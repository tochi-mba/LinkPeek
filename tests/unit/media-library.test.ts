import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {MediaLibrary, type LibraryRules} from "../../src/background/media-library";
import {LIBRARY_CACHE, LIBRARY_INDEX, type LibraryEntry} from "../../src/shared/history";
import {fakeCaches} from "./fake-caches";

let store: Record<string, unknown>, cachesApi: ReturnType<typeof fakeCaches>, sizes: Record<string, number>;
/** Pixel sizes handed to decoded pictures, by their byte length; unknown lengths decode to a comfortable size. */
let dims: Record<number, {width: number; height: number}>;
let downloads: {download: ReturnType<typeof vi.fn>; removeFile: ReturnType<typeof vi.fn>; erase: ReturnType<typeof vi.fn>};
const saved = () => [...(cachesApi.stores.get(LIBRARY_CACHE)?.keys() ?? [])];
const index = () => new Map(store[LIBRARY_INDEX] as Array<[string, LibraryEntry]>);
const seen = {seen: true}, prepared = {seen: false, type: "image" as const, source: "https://x.test/page", title: "Page"};
const rules = (budget = 1000, patch: Partial<LibraryRules> = {}): LibraryRules => ({budget, minWidth: 50, minHeight: 50, mirror: false, ...patch});
const settle = async () => {
  for (let i = 0; i < 20; i++) await vi.advanceTimersByTimeAsync(0);
};

beforeEach(() => {
  vi.useFakeTimers();
  store = {};
  sizes = {};
  dims = {};
  cachesApi = fakeCaches();
  downloads = {download: vi.fn(async () => 7), removeFile: vi.fn(async () => undefined), erase: vi.fn(async () => undefined)};
  vi.stubGlobal("chrome", {downloads, storage: {local: {
    get: vi.fn(async (key: string) => ({[key]: store[key]})),
    set: vi.fn(async (values: Record<string, unknown>) => Object.assign(store, values))
  }}});
  vi.stubGlobal("fetch", vi.fn(async (url: string) => url.includes("missing")
    ? new Response("", {status: 404})
    : new Response(new Uint8Array(sizes[url] ?? 10), {headers: url.includes("untyped") ? {} : {"content-type": "image/jpeg"}})));
  vi.stubGlobal("createImageBitmap", vi.fn(async (blob: Blob) => ({...(dims[blob.size] ?? {width: 500, height: 500}), close: () => undefined})));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("the media library", () => {
  it("keeps each file once, with its type and measured size, two at a time, in an index written in batches", async () => {
    const library = new MediaLibrary();
    for (const name of ["a", "b", "c", "a"]) library.save(`https://cdn.test/${name}.jpg`, rules(), seen);
    library.save("https://cdn.test/untyped", rules(), seen);
    library.save("data:image/png;base64,xx", rules(), seen);
    await settle();
    expect(saved().sort()).toEqual(["https://cdn.test/a.jpg", "https://cdn.test/b.jpg", "https://cdn.test/c.jpg", "https://cdn.test/untyped"]);
    expect(fetch).toHaveBeenCalledTimes(4);
    const response = await (await caches.open(LIBRARY_CACHE)).match("https://cdn.test/untyped");
    expect(response!.headers.get("content-type")).toBe("application/octet-stream");
    expect(store[LIBRARY_INDEX]).toBeUndefined();
    await vi.advanceTimersByTimeAsync(5000);
    expect((store[LIBRARY_INDEX] as unknown[]).length).toBe(4);
    // A measured picture keeps its pixel size; a file that could not be decoded has none.
    expect(index().get("https://cdn.test/a.jpg")).toMatchObject({w: 500, h: 500});
    expect(index().get("https://cdn.test/untyped")!.w).toBeUndefined();
    expect(await library.stats()).toEqual({count: 4, bytes: 40});
    // Already kept: not fetched again.
    library.save("https://cdn.test/a.jpg", rules(), seen);
    await settle();
    expect(fetch).toHaveBeenCalledTimes(4);
  });

  it("drops the oldest once over budget, skips files over a quarter of it and ones that fail", async () => {
    const library = new MediaLibrary();
    sizes = {"https://cdn.test/big.jpg": 300};
    for (const name of ["1", "2", "3", "4", "5"]) {
      library.save(`https://cdn.test/${name}.jpg`, rules(40), seen);
      await settle();
    }
    expect(saved()).toEqual(["https://cdn.test/2.jpg", "https://cdn.test/3.jpg", "https://cdn.test/4.jpg", "https://cdn.test/5.jpg"]);
    library.save("https://cdn.test/big.jpg", rules(1000), seen);
    library.save("https://cdn.test/missing.jpg", rules(1000), seen);
    await settle();
    expect(saved()).not.toContain("https://cdn.test/big.jpg");
    expect(saved()).not.toContain("https://cdn.test/missing.jpg");
    await library.trim(1000);
  });

  it("reads an index left by an earlier session, ignoring broken entries, and deletes everything with its Downloads copies", async () => {
    store[LIBRARY_INDEX] = [["https://cdn.test/x.jpg", {bytes: 5, at: 2, dl: 31}], ["bad"], 7];
    const library = new MediaLibrary();
    expect(await library.stats()).toEqual({count: 1, bytes: 5});
    library.save("https://cdn.test/y.jpg", rules(), seen);
    await library.clear();
    expect(cachesApi.delete).toHaveBeenCalledWith(LIBRARY_CACHE);
    expect(downloads.removeFile).toHaveBeenCalledWith(31);
    expect(downloads.erase).toHaveBeenCalledWith({id: 31});
    expect(store[LIBRARY_INDEX]).toEqual([]);
    store[LIBRARY_INDEX] = "corrupt";
    expect(await new MediaLibrary().stats()).toEqual({count: 0, bytes: 0});
  });
});

describe("the smallest picture worth keeping", () => {
  it("measures pictures as they arrive and never keeps or refetches one below the minimums", async () => {
    const library = new MediaLibrary();
    sizes = {"https://cdn.test/narrow.jpg": 3, "https://cdn.test/short.jpg": 4};
    dims = {3: {width: 40, height: 400}, 4: {width: 400, height: 30}};
    library.save("https://cdn.test/narrow.jpg", rules(), prepared);
    library.save("https://cdn.test/short.jpg", rules(), prepared);
    library.save("https://cdn.test/fine.jpg", rules(), prepared);
    await settle();
    expect(saved()).toEqual(["https://cdn.test/fine.jpg"]);
    // Measured too small once: not fetched again.
    library.save("https://cdn.test/narrow.jpg", rules(), seen);
    await settle();
    expect(fetch).toHaveBeenCalledTimes(3);
  });
});

describe("copies in Downloads", () => {
  it("writes each kept file into Downloads from its bytes, falling back to its address for huge files", async () => {
    const library = new MediaLibrary();
    vi.setSystemTime(new Date(2026, 9, 6, 9, 5, 7));
    const huge = 33 * 1024 * 1024;
    sizes = {"https://cdn.test/huge.bin": huge};
    library.save("https://cdn.test/a.jpg", rules(1000, {mirror: true}), seen);
    await settle();
    expect(downloads.download).toHaveBeenCalledWith({
      url: `data:image/jpeg;base64,${btoa("\u0000".repeat(10))}`,
      filename: "LinkPeek Library/2026-10-06/09.05.07 a.jpg", conflictAction: "uniquify", saveAs: false
    });
    await vi.advanceTimersByTimeAsync(5000);
    expect(index().get("https://cdn.test/a.jpg")!.dl).toBe(7);
    library.save("https://cdn.test/huge.bin", rules(huge * 8, {mirror: true}), seen);
    await settle();
    expect(downloads.download).toHaveBeenLastCalledWith(expect.objectContaining({url: "https://cdn.test/huge.bin"}));
  });

  it("gives a file kept before mirroring its copy on the next save, and survives a refused download", async () => {
    const library = new MediaLibrary();
    downloads.download.mockRejectedValueOnce(new Error("no"));
    library.save("https://cdn.test/a.jpg", rules(1000, {mirror: true}), seen);
    await settle();
    await vi.advanceTimersByTimeAsync(5000);
    expect(index().get("https://cdn.test/a.jpg")!.dl).toBeUndefined();
    library.save("https://cdn.test/a.jpg", rules(1000, {mirror: true}), seen);
    await settle();
    await vi.advanceTimersByTimeAsync(5000);
    expect(index().get("https://cdn.test/a.jpg")!.dl).toBe(7);
    // Mirroring off: already-kept files are left alone.
    library.save("https://cdn.test/a.jpg", rules(), seen);
    await settle();
    expect(downloads.download).toHaveBeenCalledTimes(2);
  });

  it("takes the Downloads copy with a file trimmed for space", async () => {
    const library = new MediaLibrary();
    library.save("https://cdn.test/old.jpg", rules(40, {mirror: true}), prepared);
    await settle();
    for (const name of ["a", "b", "c", "d"]) {
      library.save(`https://cdn.test/${name}.jpg`, rules(40, {mirror: true}), seen);
      await settle();
    }
    expect(saved()).not.toContain("https://cdn.test/old.jpg");
    expect(downloads.removeFile).toHaveBeenCalledWith(7);
  });
});

describe("checking what is already saved", () => {
  it("measures unmeasured pictures, removes too-small ones everywhere, and fills in missing Downloads copies", async () => {
    const tiny = new Response(new Uint8Array(3), {headers: {"content-type": "image/jpeg"}});
    const good = new Response(new Uint8Array(10), {headers: {"content-type": "image/jpeg"}});
    dims = {3: {width: 40, height: 400}};
    const cache = await caches.open(LIBRARY_CACHE);
    await cache.put("https://cdn.test/tiny.jpg", tiny);
    await cache.put("https://cdn.test/good.jpg", good);
    await cache.put("https://cdn.test/plain.bin", new Response(new Uint8Array(2)));
    store[LIBRARY_INDEX] = [
      ["https://cdn.test/tiny.jpg", {bytes: 3, at: 1, dl: 21}],
      ["https://cdn.test/good.jpg", {bytes: 10, at: 2}],
      ["https://cdn.test/small-known.jpg", {bytes: 5, at: 3, w: 20, h: 20}],
      ["https://cdn.test/video.mp4", {bytes: 9, at: 4, type: "video", dl: 22}],
      ["https://cdn.test/gone.jpg", {bytes: 8, at: 5}],
      ["https://cdn.test/plain.bin", {bytes: 2, at: 6}],
      ["https://cdn.test/wide.jpg", {bytes: 5, at: 7, w: 2000}]
    ] satisfies Array<[string, LibraryEntry]>;
    const library = new MediaLibrary();
    // The video already has its copy; everything kept and copyless gets one — including the file whose
    // bytes cannot be decoded, the one whose bytes are gone, and the one with only a width on record.
    expect(await library.audit(rules(1000, {mirror: true}))).toEqual({checked: 7, removed: 2, mirrored: 4});
    const kept = index();
    expect([...kept.keys()].sort()).toEqual(["https://cdn.test/gone.jpg", "https://cdn.test/good.jpg", "https://cdn.test/plain.bin", "https://cdn.test/video.mp4", "https://cdn.test/wide.jpg"]);
    // The measured survivor remembers its size; the tiny file's Downloads copy went with it.
    expect(kept.get("https://cdn.test/good.jpg")).toMatchObject({w: 500, h: 500, dl: 7});
    expect(downloads.removeFile).toHaveBeenCalledWith(21);
    // Measured too small during the check: not fetched if offered again.
    library.save("https://cdn.test/small-known.jpg", rules(), seen);
    await settle();
    expect(fetch).not.toHaveBeenCalled();
    // Without mirroring, a second pass has nothing left to do.
    expect(await library.audit(rules())).toEqual({checked: 5, removed: 0, mirrored: 0});
  });

  it("lets the memory of rejected files go, oldest first", async () => {
    store[LIBRARY_INDEX] = Array.from({length: 5001}, (_, i) => [`https://cdn.test/t${i}.jpg`, {bytes: 1, at: i, w: 10, h: 10}]);
    const library = new MediaLibrary();
    await library.audit(rules());
    // The first rejection was let go to make room: that file would be fetched again, a recent one still not.
    library.save("https://cdn.test/t0.jpg", rules(), seen);
    library.save("https://cdn.test/t5000.jpg", rules(), seen);
    await settle();
    expect((fetch as ReturnType<typeof vi.fn>).mock.calls.map(([url]) => url)).toEqual(["https://cdn.test/t0.jpg"]);
  }, 20_000);

  it("forgets one file on request, Downloads copy included, and ignores an unknown address", async () => {
    store[LIBRARY_INDEX] = [["https://cdn.test/x.jpg", {bytes: 5, at: 2, dl: 31}]];
    const cache = await caches.open(LIBRARY_CACHE);
    await cache.put("https://cdn.test/x.jpg", new Response(new Uint8Array(5)));
    const library = new MediaLibrary();
    await library.remove("https://cdn.test/none.jpg");
    await library.remove("https://cdn.test/x.jpg");
    expect(saved()).toEqual([]);
    expect(downloads.removeFile).toHaveBeenCalledWith(31);
    await vi.advanceTimersByTimeAsync(5000);
    expect(store[LIBRARY_INDEX]).toEqual([]);
  });
});

describe("prepared and seen media", () => {
  it("lets what is being looked at jump ahead of prepared files, and marks a kept or waiting file seen", async () => {
    const library = new MediaLibrary();
    for (const name of ["p1", "p2", "p3", "p4"]) library.save(`https://cdn.test/${name}.jpg`, rules(), prepared);
    library.save("https://cdn.test/p4.jpg", rules(), seen);
    library.save("https://cdn.test/p4.jpg", rules(), seen);
    library.save("https://cdn.test/s1.jpg", rules(), seen);
    await settle();
    const order = (fetch as ReturnType<typeof vi.fn>).mock.calls.map(([url]) => url);
    expect(order.slice(0, 2)).toEqual(["https://cdn.test/p1.jpg", "https://cdn.test/p2.jpg"]);
    expect(order.slice(2, 4)).toEqual(["https://cdn.test/s1.jpg", "https://cdn.test/p4.jpg"]);
    await vi.advanceTimersByTimeAsync(5000);
    expect([index().get("https://cdn.test/p1.jpg")!.seen, index().get("https://cdn.test/p4.jpg")!.seen, index().get("https://cdn.test/p1.jpg")!.title]).toEqual([false, true, "Page"]);
    library.save("https://cdn.test/p1.jpg", rules(), seen);
    library.save("https://cdn.test/p2.jpg", rules(), prepared);
    await settle();
    await vi.advanceTimersByTimeAsync(5000);
    expect(index().get("https://cdn.test/p1.jpg")!.seen).toBe(true);
  });

  it("drops never-seen files before seen ones when space runs out", async () => {
    const library = new MediaLibrary();
    library.save("https://cdn.test/seen-old.jpg", rules(40), seen);
    await settle();
    for (const name of ["a", "b", "c"]) {
      library.save(`https://cdn.test/${name}.jpg`, rules(40), prepared);
      await settle();
    }
    library.save("https://cdn.test/seen-new.jpg", rules(40), seen);
    await settle();
    expect(saved()).toEqual(["https://cdn.test/seen-old.jpg", "https://cdn.test/b.jpg", "https://cdn.test/c.jpg", "https://cdn.test/seen-new.jpg"]);
  });
});
