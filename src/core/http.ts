/** Shared retry policy for idempotent GETs used by scanners. */
const TRANSIENT = new Set([429, 502, 503, 504]);
const MAX_ATTEMPTS = 3;
const BASE_DELAY_MS = 250;
const MAX_DELAY_MS = 2000;

function aborted() {
  return new DOMException("Aborted", "AbortError");
}

/** Retry-After wins when present; otherwise use bounded exponential backoff. */
export function retryDelayMs(response: Response | undefined, attempt: number, now = Date.now()) {
  const raw = response?.headers.get("retry-after");
  if (raw) {
    const seconds = Number(raw);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(MAX_DELAY_MS, seconds * 1000);
    const date = Date.parse(raw);
    if (Number.isFinite(date)) return Math.min(MAX_DELAY_MS, Math.max(0, date - now));
  }
  return Math.min(MAX_DELAY_MS, BASE_DELAY_MS * (2 ** attempt));
}

async function sleep(ms: number, signal?: AbortSignal) {
  if (signal?.aborted) throw aborted();
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(aborted());
    }, {once: true});
  });
}

/**
 * Retries idempotent GETs on rate limits, gateway/service outages and network
 * failures. Permanent HTTP errors are returned immediately for the caller to
 * handle. Cancellation always wins.
 */
export async function fetchWithRetry(url: string, init: RequestInit = {}) {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    let response: Response;
    try {
      response = await fetch(url, init);
    } catch (error) {
      if (init.signal?.aborted || attempt === MAX_ATTEMPTS - 1) throw error;
      await sleep(retryDelayMs(undefined, attempt), init.signal);
      continue;
    }
    if (response.ok || !TRANSIENT.has(response.status) || attempt === MAX_ATTEMPTS - 1) return response;
    void response.body?.cancel().catch(() => undefined);
    await sleep(retryDelayMs(response, attempt), init.signal);
  }
  throw new Error("Unreachable retry state");
}
