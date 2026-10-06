import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {GALLERY_BYTES, GALLERY_INDEX, GALLERY_LIMIT, GALLERY_PREFIX, GalleryStore} from "../../src/background/gallery-store";
import type {ScanResult} from "../../src/shared/media";

let store: Record<string, unknown>;
const result = (url: string, extra = ""): ScanResult => ({url, kind: "generic", complete: true, title: extra, items: []});

beforeEach(() => {
  vi.useFakeTimers();
  store = {};
  vi.stubGlobal("chrome", {storage: {local: {
    get: vi.fn(async (keys: string | string[]) => Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map(key => [key, store[key]]))),
    set: vi.fn(async (values: Record<string, unknown>) => Object.assign(store, values)),
    remove: vi.fn(async (keys: string | string[]) => (Array.isArray(keys) ? keys : [keys]).forEach(key => delete store[key]))
  }}});
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("saved galleries", () => {
  it("come back for the same link and scan settings within their age, and never otherwise", async () => {
    const galleries = new GalleryStore();
    await galleries.put("https://a.test/1", "k", result("https://a.test/1"));
    expect((await galleries.get("https://a.test/1", "k", 60_000))!.result.url).toBe("https://a.test/1");
    expect(await galleries.get("https://a.test/1", "other settings", 60_000)).toBeUndefined();
    expect(await galleries.get("https://a.test/missing", "k", 60_000)).toBeUndefined();
    store[GALLERY_PREFIX + "https://a.test/odd"] = {url: "https://a.test/else", scanKey: "k", at: Date.now(), result: result("x")};
    expect(await galleries.get("https://a.test/odd", "k", 60_000)).toBeUndefined();
    vi.advanceTimersByTime(61_000);
    expect(await galleries.get("https://a.test/1", "k", 60_000)).toBeUndefined();
    expect(store[GALLERY_PREFIX + "https://a.test/1"]).toBeUndefined();
  });

  it("keep an index in batches, dropping the oldest past the count limit, and skip galleries too large to keep", async () => {
    const galleries = new GalleryStore();
    for (let i = 0; i <= GALLERY_LIMIT; i++) await galleries.put(`https://a.test/${i}`, "k", result(`https://a.test/${i}`));
    expect(store[GALLERY_PREFIX + "https://a.test/0"]).toBeUndefined();
    expect(store[GALLERY_INDEX]).toBeUndefined();
    await vi.advanceTimersByTimeAsync(5000);
    expect((store[GALLERY_INDEX] as unknown[]).length).toBe(GALLERY_LIMIT);
    expect((await galleries.stats()).count).toBe(GALLERY_LIMIT);
    await galleries.put("https://a.test/huge", "k", result("https://a.test/huge", "x".repeat(GALLERY_BYTES / 16)));
    expect(store[GALLERY_PREFIX + "https://a.test/huge"]).toBeUndefined();
  }, 60_000);

  it("drop the oldest past the size limit too", async () => {
    const galleries = new GalleryStore(), big = "x".repeat(GALLERY_BYTES / 17);
    for (let i = 0; i < 18; i++) await galleries.put(`https://a.test/${i}`, "k", result(`https://a.test/${i}`, big));
    const {count, bytes} = await galleries.stats();
    expect(count).toBeLessThan(18);
    expect(bytes).toBeLessThanOrEqual(GALLERY_BYTES);
    expect(store[GALLERY_PREFIX + "https://a.test/0"]).toBeUndefined();
  });

  it("read an index left by an earlier session, ignoring broken entries, and forget everything on request", async () => {
    store[GALLERY_INDEX] = [["https://a.test/new", {at: 20, bytes: 5}], ["https://a.test/old", {at: 10, bytes: 7}], ["bad"], 3];
    store[GALLERY_PREFIX + "https://a.test/new"] = {};
    store[GALLERY_PREFIX + "https://a.test/old"] = {};
    const galleries = new GalleryStore();
    expect(await galleries.stats()).toEqual({count: 2, bytes: 12});
    await galleries.clear();
    expect(store).toEqual({[GALLERY_INDEX]: []});
    store[GALLERY_INDEX] = "corrupt";
    expect(await new GalleryStore().stats()).toEqual({count: 0, bytes: 0});
  });
});
