import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {fetchWithRetry, readBytesCapped, retryDelayMs} from "../../src/core/http";

beforeEach(() => vi.useFakeTimers());
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
const response = (status = 200, retryAfter?: string) => new Response("body", {status, headers: retryAfter ? {"retry-after": retryAfter} : {}});

describe("HTTP retry policy", () => {
  it("honors seconds and dates without shortening server backoff, and jitters invalid/missing values", () => {
    expect(retryDelayMs(response(429, "120"), 0)).toBe(120_000);
    expect(retryDelayMs(response(503, new Date(10_000).toUTCString()), 0, "interactive", 1000)).toBe(9000);
    expect(retryDelayMs(response(503, new Date(0).toUTCString()), 0, "interactive", 1000)).toBe(0);
    expect(retryDelayMs(response(503, "invalid"), 0, "interactive", 0, () => 0)).toBe(200);
    expect(retryDelayMs(undefined, 10, "background", 0, () => 1)).toBe(3000);
    expect(retryDelayMs(response(503, "0"), 0)).toBe(0);
  });

  it("retries temporary statuses and cancels only discarded response bodies", async () => {
    const first = response(503, "0"), last = response();
    const fetch = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(last);
    vi.stubGlobal("fetch", fetch);
    const pending = fetchWithRetry("https://x.test");
    await vi.runAllTimersAsync();
    expect(await pending).toBe(last);
    expect(first.bodyUsed).toBe(true);
    expect(await last.text()).toBe("body");
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("returns permanent errors, exhaustion and over-budget Retry-After with readable bodies", async () => {
    for (const [status, delay, count] of [[404, "0", 1], [503, "0", 5], [429, "120", 1]] as const) {
      const fetch = vi.fn(async () => response(status, delay));
      vi.stubGlobal("fetch", fetch);
      const pending = fetchWithRetry("https://x.test");
      await vi.runAllTimersAsync();
      const result = await pending;
      expect(result.status).toBe(status);
      expect(await result.text()).toBe("body");
      expect(fetch).toHaveBeenCalledTimes(count);
    }
  });

  it("does not retry non-idempotent requests or validation errors", async () => {
    const fetch = vi.fn(async () => response(503));
    vi.stubGlobal("fetch", fetch);
    expect((await fetchWithRetry("https://x.test", {method: "POST"})).status).toBe(503);
    fetch.mockResolvedValue(response());
    await expect(fetchWithRetry("https://x.test", {}, "interactive", undefined, async () => { throw new Error("invalid payload"); })).rejects.toThrow("invalid payload");
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("retries network failures up to the background attempt limit", async () => {
    const fetch = vi.fn().mockRejectedValue(new TypeError("network"));
    vi.stubGlobal("fetch", fetch);
    const pending = expect(fetchWithRetry("https://x.test", {}, "background")).rejects.toThrow("network");
    await vi.runAllTimersAsync();
    await pending;
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("times out body reads, limits total elapsed time, and retries an attempt timeout", async () => {
    const fetch = vi.fn(async (_url, init: RequestInit) => new Response(new ReadableStream({
      start(controller) { init.signal!.addEventListener("abort", () => controller.error(new DOMException("Aborted", "AbortError"))); }
    })));
    vi.stubGlobal("fetch", fetch);
    const pending = expect(fetchWithRetry("https://x.test", {}, "background", 30_000, response => response.text())).rejects.toThrow("Aborted");
    await vi.runAllTimersAsync();
    await pending;
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);

    fetch.mockImplementationOnce(async (_url, init) => new Promise((_resolve, reject) => {
      init.signal!.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
    })).mockResolvedValueOnce(response());
    const retry = fetchWithRetry("https://x.test", {}, "background", 500);
    await vi.runAllTimersAsync();
    expect((await retry).status).toBe(200);
  });

  it("cancels before fetching, during fetch, and during backoff", async () => {
    const already = new AbortController();already.abort();
    await expect(fetchWithRetry("https://x.test", {signal: already.signal})).rejects.toThrow("Aborted");
    const controller = new AbortController();
    vi.stubGlobal("fetch", vi.fn(async (_url, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal!.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
    })));
    const inFlight = expect(fetchWithRetry("https://x.test", {signal: controller.signal})).rejects.toThrow("Aborted");
    controller.abort();await inFlight;
    const backoff = new AbortController();
    vi.stubGlobal("fetch", vi.fn(async () => response(503, "1")));
    const waiting = expect(fetchWithRetry("https://x.test", {signal: backoff.signal})).rejects.toThrow("Aborted");
    await vi.advanceTimersByTimeAsync(1);
    backoff.abort();await waiting;
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("bounded body reads", () => {
  it("assembles bounded chunks and handles empty bodies", async () => {
    expect([...new Uint8Array(await readBytesCapped(response(), 4, "large"))]).toEqual([98,111,100,121]);
    expect((await readBytesCapped(new Response(null), 4, "large")).byteLength).toBe(0);
  });
  it("rejects oversized declared and streaming bodies", async () => {
    await expect(readBytesCapped(new Response("body", {headers: {"content-length": "4"}}), 3, "large")).rejects.toThrow("large");
    await expect(readBytesCapped(response(), 3, "large")).rejects.toThrow("large");
  });
});
