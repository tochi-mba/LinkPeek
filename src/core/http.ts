/** Shared resilient GET policy for scanners. */
const TRANSIENT = new Set([408, 425, 429, 500, 502, 503, 504]);

export type RetryMode = "interactive" | "background";

type RetryPlan = {
  attempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  maxElapsedMs: number;
  attemptTimeoutMs: number;
};

const PLANS: Record<RetryMode, RetryPlan> = {
  // Hover/open work is intentionally patient. Explicit cancellation still stops immediately.
  interactive: {attempts: 10, baseDelayMs: 400, maxDelayMs: 15_000, maxElapsedMs: 90_000, attemptTimeoutMs: 15_000},
  // Speculative work backs off sooner so it never competes aggressively with the user.
  background: {attempts: 4, baseDelayMs: 700, maxDelayMs: 5_000, maxElapsedMs: 15_000, attemptTimeoutMs: 8_000}
};

function aborted() {
  return new DOMException("Aborted", "AbortError");
}

function isAbort(error: unknown) {
  return error instanceof DOMException && error.name === "AbortError";
}

/** Retry-After wins; otherwise equal-jitter exponential backoff avoids synchronized retry storms. */
export function retryDelayMs(
  response: Response | undefined,
  attempt: number,
  mode: RetryMode = "interactive",
  now = Date.now(),
  random = Math.random
) {
  const plan = PLANS[mode], raw = response?.headers.get("retry-after");
  if (raw) {
    const seconds = Number(raw);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(plan.maxDelayMs, seconds * 1000);
    const date = Date.parse(raw);
    if (Number.isFinite(date)) return Math.min(plan.maxDelayMs, Math.max(0, date - now));
  }
  const ceiling = Math.min(plan.maxDelayMs, plan.baseDelayMs * (2 ** attempt));
  return Math.round(ceiling / 2 + random() * ceiling / 2);
}

async function sleep(ms: number, signal?: AbortSignal) {
  if (signal?.aborted) throw aborted();
  await new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(aborted());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, {once: true});
  });
}

async function oneAttempt(url: string, init: RequestInit, timeoutMs: number) {
  if (init.signal?.aborted) throw aborted();
  const controller = new AbortController(), external = init.signal;
  const onAbort = () => controller.abort();
  external?.addEventListener("abort", onAbort, {once: true});
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {...init, signal: controller.signal});
  } catch (error) {
    if (external?.aborted) throw aborted();
    throw error;
  } finally {
    clearTimeout(timer);
    external?.removeEventListener("abort", onAbort);
  }
}

/**
 * Retries idempotent GETs on rate limits, temporary server errors, timeouts and
 * network failures. Permanent HTTP errors return immediately. Interactive work
 * is deliberately patient; cancellation from the caller always wins.
 */
export async function fetchWithRetry(url: string, init: RequestInit = {}, mode: RetryMode = "interactive", attemptTimeoutMs?: number) {
  const plan = PLANS[mode], started = Date.now(), timeout = Math.max(500, attemptTimeoutMs ?? plan.attemptTimeoutMs);
  let lastError: unknown;
  for (let attempt = 0; attempt < plan.attempts; attempt++) {
    let response: Response | undefined;
    try {
      response = await oneAttempt(url, init, timeout);
    } catch (error) {
      if (init.signal?.aborted) throw aborted();
      lastError = error;
      // A per-attempt timeout is retryable; an explicit caller abort is not.
      if (attempt === plan.attempts - 1) throw error;
    }
    if (response) {
      if (response.ok || !TRANSIENT.has(response.status)) return response;
      if (attempt === plan.attempts - 1) return response;
      void response.body?.cancel().catch(() => undefined);
    }
    const delay = retryDelayMs(response, attempt, mode);
    if (Date.now() - started + delay >= plan.maxElapsedMs) {
      if (response) return response;
      throw lastError instanceof Error ? lastError : new Error("Request retry window exhausted");
    }
    await sleep(delay, init.signal);
  }
  if (lastError) throw lastError;
  throw new Error("Request retry window exhausted");
}
