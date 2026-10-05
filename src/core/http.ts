/**
 * Every request LinkPeek makes goes through here: a timeout per attempt that
 * also covers reading the body, cancellation, size-capped reading, and a short
 * bounded retry for transient failures.
 *
 * Only requests someone is waiting on (an open preview) retry. Speculative
 * background requests never do: the content script already rests a failed link
 * for 30 s, and retrying a rate-limited site in the background only makes it worse.
 */
export type RetryMode = "interactive" | "background";

/** Statuses that usually mean "try again shortly"; a plain 500 is treated as a real failure. */
const TRANSIENT_STATUS = new Set([408, 429, 502, 503, 504]);
const POLICY: Record<RetryMode, {attempts: number; baseDelayMs: number; maxDelayMs: number; budgetMs: number}> = {
  interactive: {attempts: 3, baseDelayMs: 300, maxDelayMs: 2000, budgetMs: 15_000},
  background: {attempts: 1, baseDelayMs: 0, maxDelayMs: 0, budgetMs: 8_000}
};
const DEFAULT_ATTEMPT_TIMEOUT_MS = 8000;
/** Enough for any real article or gallery page; bigger documents are cut off, not read whole. */
export const MAX_HTML_BYTES = 3 * 1024 * 1024;

function abortError() {
  return new DOMException("Aborted", "AbortError");
}

/** Wait before retry `attempt` (0-based): Retry-After when the server sends one, else jittered exponential backoff. */
export function retryDelayMs(response: Response | undefined, attempt: number, random = Math.random, now = Date.now()) {
  const header = response?.headers.get("retry-after")?.trim();
  if (header) {
    const seconds = Number(header);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
    const date = Date.parse(header);
    if (Number.isFinite(date)) return Math.max(0, date - now);
  }
  const {baseDelayMs, maxDelayMs} = POLICY.interactive, ceiling = Math.min(maxDelayMs, baseDelayMs * 2 ** attempt);
  return Math.round(ceiling * (0.5 + random() / 2));
}

function sleep(ms: number, signal?: AbortSignal | null) {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, {once: true});
  });
}

export interface FetchOptions<T> {
  mode?: RetryMode;
  /** Per attempt, including reading the body. */
  timeoutMs?: number;
  /** Consumes the response inside the attempt, so its timeout and cancellation still apply. */
  read?: (response: Response) => Promise<T>;
}

/** Fetches with a per-attempt timeout and, for interactive requests, a short retry on transient failures. */
export async function fetchWithRetry<T = Response>(url: string, init: RequestInit = {}, options: FetchOptions<T> = {}): Promise<T> {
  const policy = POLICY[options.mode ?? "interactive"], started = Date.now(), external = init.signal;
  const read = options.read ?? (async (response: Response) => response as T);
  const attempts = /^(GET|HEAD)$/i.test(init.method ?? "GET") ? policy.attempts : 1;
  for (let attempt = 0; ; attempt++) {
    if (external?.aborted) throw abortError();
    const controller = new AbortController(), onAbort = () => controller.abort();
    external?.addEventListener("abort", onAbort, {once: true});
    const timer = setTimeout(onAbort, Math.max(500, options.timeoutMs ?? DEFAULT_ATTEMPT_TIMEOUT_MS));
    let delay: number;
    try {
      const response = await fetch(url, {...init, signal: controller.signal});
      delay = retryDelayMs(response, attempt);
      const last = !TRANSIENT_STATUS.has(response.status) || attempt + 1 >= attempts || Date.now() - started + delay >= policy.budgetMs;
      if (last) return await read(response);
      await response.body?.cancel().catch(() => undefined);
    } catch (error) {
      if (external?.aborted) throw abortError();
      // Only network failures and timeouts are worth another try; a bad body or a 404 is final.
      const network = controller.signal.aborted || error instanceof TypeError;
      delay = retryDelayMs(undefined, attempt);
      if (!network || attempt + 1 >= attempts || Date.now() - started + delay >= policy.budgetMs) throw error;
    } finally {
      clearTimeout(timer);
      external?.removeEventListener("abort", onAbort);
    }
    await sleep(delay, external);
  }
}

/** Reads at most `maxBytes`; past that it either throws `overflow` or stops and keeps what was read. */
async function readChunks(response: Response, maxBytes: number, overflow?: Error) {
  if (overflow && Number(response.headers.get("content-length")) > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw overflow;
  }
  const reader = response.body?.getReader(), chunks: Uint8Array[] = [];
  let size = 0;
  while (reader && size < maxBytes) {
    const {done, value} = await reader.read();
    if (done) break;
    if (overflow && size + value.byteLength > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw overflow;
    }
    chunks.push(value);
    size += value.byteLength;
  }
  if (reader && size >= maxBytes) await reader.cancel().catch(() => undefined);
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/** A whole body up to `maxBytes`; anything larger is refused with `message`. */
export async function readBytesCapped(response: Response, maxBytes: number, message: string) {
  return (await readChunks(response, maxBytes, new Error(message))).buffer;
}

/** A page's text, cut off after `maxBytes` and decoded with the declared charset (UTF-8 when unknown). */
export async function readTextCapped(response: Response, maxBytes = MAX_HTML_BYTES) {
  const charset = /charset=([^;]+)/i.exec(response.headers.get("content-type") ?? "")?.[1]?.trim();
  let decoder: TextDecoder;
  try {
    decoder = new TextDecoder(charset || "utf-8");
  } catch {
    decoder = new TextDecoder("utf-8");
  }
  return decoder.decode(await readChunks(response, maxBytes));
}
