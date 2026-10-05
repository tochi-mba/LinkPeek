import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {MAX_HTML_BYTES, fetchWithRetry, readBytesCapped, readTextCapped, retryDelayMs} from "../../src/core/http";

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const response = (status = 200, retryAfter?: string, body: BodyInit | null = "body") => new Response(body, {status, headers: retryAfter ? {"retry-after": retryAfter} : {}});
const hanging = () => vi.fn((_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
  init.signal!.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
}));

describe("retry delays", () => {
  it("follow Retry-After in seconds or as a date, else jittered exponential backoff", () => {
    expect(retryDelayMs(response(429, "120"), 0)).toBe(120_000);
    expect(retryDelayMs(response(503, new Date(10_000).toUTCString()), 0, Math.random, 1000)).toBe(9000);
    expect(retryDelayMs(response(503, new Date(0).toUTCString()), 0, Math.random, 1000)).toBe(0);
    expect(retryDelayMs(response(503, "0"), 0)).toBe(0);
    expect(retryDelayMs(response(503, "soon"), 0, () => 0)).toBe(150);
    expect(retryDelayMs(undefined, 1, () => 1)).toBe(600);
    expect(retryDelayMs(undefined, 10, () => 1)).toBe(2000);
  });
});

describe("requests someone is waiting on", () => {
  it("retry temporary failures a few times, discarding the bodies they drop", async () => {
    const first = response(503, "0"), second = response(502, "0"), last = response();
    const fetch = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second).mockResolvedValueOnce(last);
    vi.stubGlobal("fetch", fetch);
    const pending = fetchWithRetry("https://x.test");
    await vi.runAllTimersAsync();
    expect(await pending).toBe(last);
    expect([first.bodyUsed, second.bodyUsed, await last.text()]).toEqual([true, true, "body"]);
  });

  it("stop at the attempt limit, at real errors, and when the server asks for too long a wait", async () => {
    for (const [status, retryAfter, calls] of [[503, "0", 3], [404, "0", 1], [500, "0", 1], [429, "120", 1]] as const) {
      const fetch = vi.fn(async () => response(status, retryAfter));
      vi.stubGlobal("fetch", fetch);
      const pending = fetchWithRetry("https://x.test");
      await vi.runAllTimersAsync();
      const result = await pending;
      expect([result.status, await result.text(), fetch.mock.calls.length]).toEqual([status, "body", calls]);
    }
  });

  it("retry network failures and timeouts, but never bad bodies or non-GET requests", async () => {
    const network = vi.fn().mockRejectedValueOnce(new TypeError("network")).mockResolvedValueOnce(response());
    vi.stubGlobal("fetch", network);
    const recovered = fetchWithRetry("https://x.test");
    await vi.runAllTimersAsync();
    expect((await recovered).status).toBe(200);

    const slow = hanging();
    slow.mockImplementationOnce(slow.getMockImplementation()!).mockResolvedValueOnce(response());
    vi.stubGlobal("fetch", slow);
    const afterTimeout = fetchWithRetry("https://x.test", {}, {timeoutMs: 500});
    await vi.runAllTimersAsync();
    expect((await afterTimeout).status).toBe(200);

    vi.stubGlobal("fetch", vi.fn(async () => response()));
    await expect(fetchWithRetry("https://x.test", {}, {read: async () => {
      throw new SyntaxError("bad JSON");
    }})).rejects.toThrow("bad JSON");
    const post = vi.fn(async () => response(503, "0"));
    vi.stubGlobal("fetch", post);
    expect((await fetchWithRetry("https://x.test", {method: "POST"})).status).toBe(503);
    expect(post).toHaveBeenCalledTimes(1);
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("offline")));
    const exhausted = expect(fetchWithRetry("https://x.test")).rejects.toThrow("offline");
    await vi.runAllTimersAsync();
    await exhausted;
  });

  it("give up once the time budget is spent", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(0);
    const fetch = vi.fn(async () => {
      now.mockReturnValue(14_900);
      return response(503);
    });
    vi.stubGlobal("fetch", fetch);
    expect((await fetchWithRetry("https://x.test")).status).toBe(503);
    now.mockReturnValue(0);
    vi.stubGlobal("fetch", vi.fn(async () => {
      now.mockReturnValue(14_900);
      throw new TypeError("network");
    }));
    await expect(fetchWithRetry("https://x.test")).rejects.toThrow("network");
  });

  it("time out slow bodies too, since reading happens inside the attempt", async () => {
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => response(200, undefined, new ReadableStream({
      start(controller) {
        init.signal!.addEventListener("abort", () => controller.error(new DOMException("Aborted", "AbortError")));
      }
    }))));
    const pending = expect(fetchWithRetry("https://x.test", {}, {mode: "background", read: body => body.text()})).rejects.toThrow("Aborted");
    await vi.runAllTimersAsync();
    await pending;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("wait between attempts without holding on to the caller's signal", async () => {
    const live = new AbortController(), remove = vi.spyOn(live.signal, "removeEventListener");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(response(503, "0")).mockResolvedValueOnce(response()));
    const pending = fetchWithRetry("https://x.test", {signal: live.signal});
    await vi.runAllTimersAsync();
    expect((await pending).status).toBe(200);
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
    // Cancelled while the dropped body is discarded: no wait at all.
    const late = new AbortController();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new ReadableStream({cancel: () => late.abort()}), {status: 503, headers: {"retry-after": "1"}})));
    await expect(fetchWithRetry("https://x.test", {signal: late.signal})).rejects.toThrow("Aborted");
  });

  it("stop at once when cancelled, before, during or between attempts", async () => {
    const already = new AbortController();
    already.abort();
    await expect(fetchWithRetry("https://x.test", {signal: already.signal})).rejects.toThrow("Aborted");
    const during = new AbortController();
    vi.stubGlobal("fetch", hanging());
    const inFlight = expect(fetchWithRetry("https://x.test", {signal: during.signal})).rejects.toThrow("Aborted");
    during.abort();
    await inFlight;
    const between = new AbortController();
    vi.stubGlobal("fetch", vi.fn(async () => response(503, "1")));
    const waiting = expect(fetchWithRetry("https://x.test", {signal: between.signal})).rejects.toThrow("Aborted");
    await vi.advanceTimersByTimeAsync(1);
    between.abort();
    await waiting;
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("background requests", () => {
  it("never retry", async () => {
    const fetch = vi.fn().mockRejectedValue(new TypeError("network"));
    vi.stubGlobal("fetch", fetch);
    await expect(fetchWithRetry("https://x.test", {}, {mode: "background"})).rejects.toThrow("network");
    const busy = vi.fn(async () => response(503, "0"));
    vi.stubGlobal("fetch", busy);
    expect((await fetchWithRetry("https://x.test", {}, {mode: "background"})).status).toBe(503);
    expect([fetch.mock.calls.length, busy.mock.calls.length]).toEqual([1, 1]);
  });
});

describe("capped reading", () => {
  const chunked = (chunks: number[], onPull: () => unknown = () => undefined) => {
    let index = 0;
    return new ReadableStream<Uint8Array>({pull(controller) {
      onPull();
      if (index < chunks.length) controller.enqueue(new Uint8Array(chunks[index++]).fill(97));
      else controller.close();
    }});
  };

  it("reads whole bodies within the limit and refuses larger ones", async () => {
    expect([...new Uint8Array(await readBytesCapped(response(), 4, "too big"))]).toEqual([98, 111, 100, 121]);
    expect((await readBytesCapped(response(200, undefined, null), 4, "too big")).byteLength).toBe(0);
    expect((await readBytesCapped(response(200, undefined, chunked([2, 2])), 4, "too big")).byteLength).toBe(4);
    await expect(readBytesCapped(new Response("body", {headers: {"content-length": "4"}}), 3, "too big")).rejects.toThrow("too big");
    await expect(readBytesCapped(response(200, undefined, chunked([2, 2])), 3, "too big")).rejects.toThrow("too big");
  });

  it("cuts text off at the limit and decodes the declared charset", async () => {
    let pulls = 0;
    const text = await readTextCapped(response(200, undefined, chunked(Array(50).fill(1024), () => pulls++)), 4096);
    expect(text).toHaveLength(4096);
    expect(pulls).toBeLessThan(10);
    expect(MAX_HTML_BYTES).toBe(3 * 1024 * 1024);
    const latin = new Response(new Uint8Array([0x63, 0x61, 0x66, 0xe9]), {headers: {"content-type": "text/html; charset=iso-8859-1"}});
    expect(await readTextCapped(latin)).toBe("café");
    expect(await readTextCapped(new Response("plain", {headers: {"content-type": "text/html; charset=nonsense"}}))).toBe("plain");
    expect(await readTextCapped(response(200, undefined, null))).toBe("");
  });
});
