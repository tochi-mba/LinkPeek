/** Bounded retries for idempotent requests, including consumption of their bodies. */
const TRANSIENT = new Set([408, 425, 429, 500, 502, 503, 504]);
export type RetryMode = "interactive" | "background";

/** Stops an unknown-length download before allocating more than its byte limit. */
export async function readBytesCapped(response: Response, maxBytes: number, message: string) {
  if (Number(response.headers.get("content-length")) > maxBytes) {
    await response.body?.cancel();
    throw new Error(message);
  }
  const reader = response.body?.getReader();
  if (!reader) return new ArrayBuffer(0);
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const {done, value} = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) { await reader.cancel(); throw new Error(message); }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return bytes.buffer;
}
const PLANS = {
  interactive: {attempts: 5, baseDelayMs: 400, maxDelayMs: 8000, maxElapsedMs: 30_000, attemptTimeoutMs: 8000},
  background: {attempts: 3, baseDelayMs: 700, maxDelayMs: 3000, maxElapsedMs: 12_000, attemptTimeoutMs: 4000}
};

function aborted() {
  return new DOMException("Aborted", "AbortError");
}

/** Never retry earlier than Retry-After; a delay beyond our budget ends the request. */
export function retryDelayMs(response: Response | undefined, attempt: number, mode: RetryMode = "interactive", now = Date.now(), random = Math.random) {
  const raw = response?.headers.get("retry-after");
  if (raw?.trim()) {
    const seconds = Number(raw);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
    const date = Date.parse(raw);
    if (Number.isFinite(date)) return Math.max(0, date - now);
  }
  const plan = PLANS[mode], ceiling = Math.min(plan.maxDelayMs, plan.baseDelayMs * 2 ** attempt);
  return Math.round(ceiling * (0.5 + random() / 2));
}

async function sleep(ms: number, signal?: AbortSignal | null) {
  if (signal?.aborted) throw aborted();
  await new Promise<void>((resolve, reject) => {
    const onAbort = () => { clearTimeout(timer); reject(aborted()); };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, {once: true});
  });
}

/** Pass a reader to keep timeout and cancellation active until the body is consumed. */
export async function fetchWithRetry<T = Response>(
  url: string, init: RequestInit = {}, mode: RetryMode = "interactive", attemptTimeoutMs?: number,
  read: (response: Response) => Promise<T> = async response => response as T
): Promise<T> {
  const plan = PLANS[mode], started = Date.now();
  const timeout = Math.max(500, attemptTimeoutMs ?? plan.attemptTimeoutMs);
  const attempts = /^(GET|HEAD)$/i.test(init.method ?? "GET") ? plan.attempts : 1;
  for (let attempt = 0; ; attempt++) {
    if (init.signal?.aborted) throw aborted();
    const controller = new AbortController(), external = init.signal;
    const onAbort = () => controller.abort();
    external?.addEventListener("abort", onAbort, {once: true});
    const timer = setTimeout(() => controller.abort(), Math.min(timeout, plan.maxElapsedMs - (Date.now() - started)));
    let response: Response | undefined;
    let delay = 0;
    try {
      response = await fetch(url, {...init, signal: controller.signal});
      delay = retryDelayMs(response, attempt, mode);
      if (!TRANSIENT.has(response.status) || attempt + 1 >= attempts || Date.now() - started + delay >= plan.maxElapsedMs) {
        return await read(response);
      }
    } catch (error) {
      if (external?.aborted) throw aborted();
      delay = retryDelayMs(undefined, attempt, mode);
      // Parsing/validation errors and permanent HTTP failures are not network failures.
      const retryable = controller.signal.aborted || error instanceof TypeError;
      if (!retryable || attempt + 1 >= attempts || Date.now() - started + delay >= plan.maxElapsedMs) throw error;
    } finally {
      clearTimeout(timer);
      external?.removeEventListener("abort", onAbort);
    }
    await response?.body?.cancel().catch(() => undefined);
    await sleep(delay, external);
  }
}
