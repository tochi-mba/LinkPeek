import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {LIBRARY_INDEX, MediaLibrary} from "../../src/background/media-library";
import {LIBRARY_CACHE} from "../../src/shared/history";
import {fakeCaches} from "./fake-caches";

let store: Record<string, unknown>, cachesApi: ReturnType<typeof fakeCaches>, sizes: Record<string, number>;
const saved = () => [...(cachesApi.stores.get(LIBRARY_CACHE)?.keys() ?? [])];
const settle = async () => {
  for (let i = 0; i < 20; i++) await vi.advanceTimersByTimeAsync(0);
};

beforeEach(() => {
  vi.useFakeTimers();
  store = {};
  sizes = {};
  cachesApi = fakeCaches();
  vi.stubGlobal("chrome", {storage: {local: {
    get: vi.fn(async (key: string) => ({[key]: store[key]})),
    set: vi.fn(async (values: Record<string, unknown>) => Object.assign(store, values))
  }}});
  vi.stubGlobal("fetch", vi.fn(async (url: string) => url.includes("missing")
    ? new Response("", {status: 404})
    : new Response(new Uint8Array(sizes[url] ?? 10), {headers: url.includes("untyped") ? {} : {"content-type": "image/jpeg"}})));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("the media library", () => {
  it("keeps each file once, with its type, two at a time, and records it in an index written in batches", async () => {
    const library = new MediaLibrary();
    for (const name of ["a", "b", "c", "a"]) library.save(`https://cdn.test/${name}.jpg`, 1000);
    library.save("https://cdn.test/untyped", 1000);
    library.save("data:image/png;base64,xx", 1000);
    await settle();
    expect(saved()).toEqual(["https://cdn.test/a.jpg", "https://cdn.test/b.jpg", "https://cdn.test/c.jpg", "https://cdn.test/untyped"]);
    expect(fetch).toHaveBeenCalledTimes(4);
    const response = await (await caches.open(LIBRARY_CACHE)).match("https://cdn.test/untyped");
    expect(response!.headers.get("content-type")).toBe("application/octet-stream");
    expect(store[LIBRARY_INDEX]).toBeUndefined();
    await vi.advanceTimersByTimeAsync(5000);
    expect((store[LIBRARY_INDEX] as unknown[]).length).toBe(4);
    expect(await library.stats()).toEqual({count: 4, bytes: 40});
    // Already kept: not fetched again.
    library.save("https://cdn.test/a.jpg", 1000);
    await settle();
    expect(fetch).toHaveBeenCalledTimes(4);
  });

  it("drops the oldest once over budget, skips files over a quarter of it and ones that fail", async () => {
    const library = new MediaLibrary();
    sizes = {"https://cdn.test/big.jpg": 300};
    for (const name of ["1", "2", "3", "4", "5"]) {
      library.save(`https://cdn.test/${name}.jpg`, 40);
      await settle();
    }
    expect(saved()).toEqual(["https://cdn.test/2.jpg", "https://cdn.test/3.jpg", "https://cdn.test/4.jpg", "https://cdn.test/5.jpg"]);
    library.save("https://cdn.test/big.jpg", 1000);
    library.save("https://cdn.test/missing.jpg", 1000);
    await settle();
    expect(saved()).not.toContain("https://cdn.test/big.jpg");
    expect(saved()).not.toContain("https://cdn.test/missing.jpg");
    await library.trim(1000);
  });

  it("reads an index left by an earlier session, ignoring broken entries, and deletes everything", async () => {
    store[LIBRARY_INDEX] = [["https://cdn.test/x.jpg", {bytes: 5, at: 2}], ["bad"], 7];
    const library = new MediaLibrary();
    expect(await library.stats()).toEqual({count: 1, bytes: 5});
    library.save("https://cdn.test/y.jpg", 1000);
    await library.clear();
    expect(cachesApi.delete).toHaveBeenCalledWith(LIBRARY_CACHE);
    expect(store[LIBRARY_INDEX]).toEqual([]);
    store[LIBRARY_INDEX] = "corrupt";
    expect(await new MediaLibrary().stats()).toEqual({count: 0, bytes: 0});
  });
});
