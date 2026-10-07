import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {MediaLibrary, contentDigest, measure, svgSize, type AuditProgress, type LibraryRules} from "../../src/background/media-library";
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
const fixtureBytes = (url: string, size: number) => {
  const bytes = new Uint8Array(size);
  let hash = 2166136261;
  for (const char of url) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  for (let i = 0; i < Math.min(4, size); i++) bytes[i] = hash >>> (i * 8);
  return bytes;
};
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
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url.includes("missing")) return new Response("", {status: 404});
    const bytes = fixtureBytes(url, sizes[url] ?? 10);
    return new Response(bytes, {headers: url.includes("untyped") ? {} : {"content-type": "image/jpeg"}});
  }));
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
    // A measured picture keeps its pixel size, even one served with no type at all.
    expect(index().get("https://cdn.test/a.jpg")).toMatchObject({w: 500, h: 500});
    expect(index().get("https://cdn.test/untyped")).toMatchObject({w: 500, h: 500});
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

  it("indexes existing Tumblr downloads without copying or charging them to the cache budget", async () => {
    const library = new MediaLibrary();
    const external = {seen: false, type: "video" as const, source: "https://www.tumblr.com/demo/42", title: "@demo · post 42", original: "https://va.media.tumblr.com/clip.mp4", local: "file:///C:/Downloads/clip.mp4", dl: 42, external: true, diskBytes: 900};
    expect(await library.importExternal("file:///clip.mp4", external)).toBe("ignored");
    expect(await library.importExternal("https://va.media.tumblr.com/no-external.mp4", {...external, external: false})).toBe("ignored");
    expect(await library.importExternal("https://va.media.tumblr.com/no-id.mp4", {...external, dl: undefined})).toBe("ignored");
    expect(await library.importExternal(external.original, external, 123)).toBe("saved");
    expect(await library.stats()).toEqual({count: 1, bytes: 0});
    expect(fetch).not.toHaveBeenCalled();
    await library.trim(0);
    expect((await library.stats()).count).toBe(1);
    expect(await library.importExternal(external.original, {...external, seen: true, title: "replacement", source: "https://replacement.test"}, 456)).toBe("existing");
    const untitled = "https://va.media.tumblr.com/untitled.mp4";
    expect(await library.importExternal(untitled, {...external, original: untitled, title: undefined, source: undefined}, 789)).toBe("saved");
    expect(await library.importExternal(untitled, {...external, original: untitled, title: "Now titled", source: "https://www.tumblr.com/demo/99"})).toBe("existing");
    await library.saveIndex();
    expect(index().get(external.original)).toMatchObject({at: 123, seen: true, title: "@demo · post 42", source: "https://www.tumblr.com/demo/42", bytes: 0, diskBytes: 900});
    expect(index().get(untitled)).toMatchObject({title: "Now titled", source: "https://www.tumblr.com/demo/99"});
  });

  it("clears queued and in-flight saves without letting them repopulate the Library", async () => {
    const releases: Array<(response: Response) => void> = [];
    vi.mocked(fetch).mockImplementation(() => new Promise(resolve => releases.push(resolve)));
    const library = new MediaLibrary();
    const saves = ["a", "b", "c"].map(name => library.save(`https://cdn.test/${name}.jpg`, rules(), seen));
    await vi.advanceTimersByTimeAsync(0);
    expect(releases).toHaveLength(2);
    await library.clear();
    expect(await saves[2]).toBe("ignored");
    releases.forEach((release, i) => release(new Response(new Uint8Array([i + 1]))));
    await settle();
    expect(await Promise.all(saves.slice(0, 2))).toEqual(["ignored", "ignored"]);
    expect(saved()).toEqual([]);
    expect(await library.stats()).toEqual({count: 0, bytes: 0});
  });

  it("cancels saves cleared during decoding or while equal bytes wait to be written", async () => {
    let finishDecode!: () => void;
    vi.stubGlobal("createImageBitmap", vi.fn(() => new Promise(resolve => finishDecode = () => resolve({width: 500, height: 500, close: () => undefined}))));
    const decodingLibrary = new MediaLibrary();
    const decoding = decodingLibrary.save("https://cdn.test/decoding.jpg", rules(), seen);
    while (!finishDecode) await vi.advanceTimersByTimeAsync(0);
    await decodingLibrary.clear();
    finishDecode();
    await settle();
    expect(await decoding).toBe("ignored");

    vi.stubGlobal("createImageBitmap", vi.fn(async () => ({width: 500, height: 500, close: () => undefined})));
    vi.mocked(fetch).mockImplementation(async () => new Response(new Uint8Array([8, 6, 7, 5]), {headers: {"content-type": "image/jpeg"}}));
    const cache = await cachesApi.open(LIBRARY_CACHE);
    let finishOpen!: () => void;
    cachesApi.open.mockImplementationOnce(() => new Promise(resolve => finishOpen = () => resolve(cache)));
    const writingLibrary = new MediaLibrary();
    const first = writingLibrary.save("https://cdn.test/first.jpg", rules(), seen);
    const waiting = writingLibrary.save("https://cdn.test/waiting.jpg", rules(), seen);
    while (!finishOpen) await vi.advanceTimersByTimeAsync(0);
    await writingLibrary.clear();
    finishOpen();
    await settle();
    expect(await Promise.all([first, waiting])).toEqual(["ignored", "ignored"]);
    expect(saved()).toEqual([]);
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
  it("keeps byte-identical media only once even when its addresses differ", async () => {
    vi.mocked(fetch).mockImplementation(async () => new Response(new Uint8Array([1, 2, 3, 4]), {headers: {"content-type": "image/jpeg"}}));
    const library = new MediaLibrary();
    const first = library.save("https://cdn.test/one.jpg", rules(), prepared);
    await settle();
    expect(await first).toBe("saved");
    const second = library.save("https://cdn.test/two.jpg", rules(), seen);
    await settle();
    expect(await second).toBe("duplicate");
    expect(saved()).toEqual(["https://cdn.test/one.jpg"]);
    await vi.advanceTimersByTimeAsync(5000);
    expect(index().get("https://cdn.test/one.jpg")).toMatchObject({seen: true, digest: contentDigest(new Uint8Array([1, 2, 3, 4]).buffer)});
  });

  it("writes each kept file into Downloads from its bytes, falling back to its address for huge files", async () => {
    const library = new MediaLibrary();
    vi.setSystemTime(new Date(2026, 9, 6, 9, 5, 7));
    const huge = 33 * 1024 * 1024;
    sizes = {"https://cdn.test/huge.bin": huge};
    library.save("https://cdn.test/a.jpg", rules(1000, {mirror: true}), seen);
    await settle();
    expect(downloads.download).toHaveBeenCalledWith({
      url: `data:image/jpeg;base64,${btoa(String.fromCharCode(...fixtureBytes("https://cdn.test/a.jpg", 10)))}`,
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

  it("adopts an explicit download without duplicating or deleting it, and can mark it seen", async () => {
    store[LIBRARY_INDEX] = [["https://cdn.test/tumblr.jpg", {bytes: 10, at: 1, seen: false, type: "image"}]];
    const library = new MediaLibrary();
    library.save("https://cdn.test/tumblr.jpg", rules(1000, {mirror: true}), {
      seen: false, type: "image", source: "https://demo.tumblr.com/post/1", original: "https://cdn.test/tumblr.jpg", dl: 41, external: true
    });
    await settle();
    await library.markSeen("https://cdn.test/tumblr.jpg");
    await library.markSeen("https://cdn.test/missing.jpg");
    await vi.advanceTimersByTimeAsync(5000);
    expect(index().get("https://cdn.test/tumblr.jpg")).toMatchObject({seen: true, dl: 41, external: true});
    expect(downloads.download).not.toHaveBeenCalled();
    await library.remove("https://cdn.test/tumblr.jpg");
    expect(downloads.removeFile).not.toHaveBeenCalled();
    expect(downloads.erase).not.toHaveBeenCalled();
  });

  it("still lists an explicit download when its web copy cannot be cached", async () => {
    const library = new MediaLibrary();
    library.save("https://cdn.test/missing.jpg", rules(1000), {
      seen: false, type: "image", source: "https://demo.tumblr.com/post/2", original: "https://cdn.test/missing.jpg", dl: 42, external: true
    });
    await settle();
    await vi.advanceTimersByTimeAsync(5000);
    expect(index().get("https://cdn.test/missing.jpg")).toMatchObject({bytes: 0, seen: false, dl: 42, external: true});
    expect(saved()).not.toContain("https://cdn.test/missing.jpg");
  });
});

describe("checking what is already saved", () => {
  it("finds old byte-identical files, keeps the favourite, and removes even an explicit duplicate download", async () => {
    const cache = await caches.open(LIBRARY_CACHE), bytes = new Uint8Array([9, 8, 7]);
    await cache.put("https://cdn.test/old.jpg", new Response(bytes));
    await cache.put("https://cdn.test/favourite.jpg", new Response(bytes));
    await cache.put("https://cdn.test/new-copy.jpg", new Response(bytes));
    store.favoriteMedia = ["https://cdn.test/favourite.jpg"];
    store[LIBRARY_INDEX] = [
      ["https://cdn.test/old.jpg", {bytes: 3, at: 1, seen: true, type: "image", w: 500, h: 500, dl: 31, external: true}],
      ["https://cdn.test/favourite.jpg", {bytes: 3, at: 2, seen: true, type: "image", w: 500, h: 500, dl: 32, external: true}],
      ["https://cdn.test/new-copy.jpg", {bytes: 3, at: 3, seen: true, type: "image", w: 500, h: 500, dl: 33, external: true}]
    ];
    expect(await new MediaLibrary().audit(rules())).toEqual({checked: 3, removed: 2, mirrored: 0});
    expect([...index().keys()]).toEqual(["https://cdn.test/favourite.jpg"]);
    expect(downloads.removeFile).toHaveBeenCalledWith(31);
    expect(downloads.removeFile).toHaveBeenCalledWith(33);
    expect(downloads.erase).toHaveBeenCalledWith({id: 31});
  });

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

  it("narrates its progress and eases off after a file that took real work, but always finishes", async () => {
    store[LIBRARY_INDEX] = [["https://cdn.test/slow.jpg", {bytes: 3, at: 1}], ["https://cdn.test/quick.jpg", {bytes: 4, at: 2, w: 500, h: 500}]];
    const cache = await caches.open(LIBRARY_CACHE);
    await cache.put("https://cdn.test/slow.jpg", new Response(new Uint8Array(3), {headers: {"content-type": "image/jpeg"}}));
    (createImageBitmap as ReturnType<typeof vi.fn>).mockImplementationOnce(async (blob: Blob) => {
      // Decoding this one takes a while; the audit should rest as long afterwards (capped at a second).
      vi.setSystemTime(Date.now() + 5000);
      return {...(dims[blob.size] ?? {width: 500, height: 500}), close: () => undefined};
    });
    const ticks: AuditProgress[] = [];
    const library = new MediaLibrary();
    const done = library.audit(rules(), progress => ticks.push(progress));
    await vi.advanceTimersByTimeAsync(1000);
    expect(await done).toEqual({checked: 2, removed: 0, mirrored: 0});
    expect(ticks.map(tick => tick.resting)).toEqual([1000, 0]);
    expect(ticks[1]).toMatchObject({checked: 2, total: 2, removed: 0, mirrored: 0, url: "https://cdn.test/quick.jpg"});
  });

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

describe("measuring pictures", () => {
  const bytes = (text: string) => new TextEncoder().encode(text).buffer as ArrayBuffer;

  it("sizes an SVG by its own width and height, else its viewBox", () => {
    expect(svgSize(`<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" width="20" height="18px">`)).toEqual({w: 20, h: 18});
    expect(svgSize(`<svg viewBox="0 0 36 36"><path/></svg>`)).toEqual({w: 36, h: 36});
    // Relative sizes say nothing in pixels, so the viewBox decides.
    expect(svgSize(`<svg width="100%" height="100%" viewBox="-5,-5, 640 480">`)).toEqual({w: 640, h: 480});
    expect(svgSize(`<svg width="10">`)).toBeUndefined();
    expect(svgSize(`<svg viewBox="0 0 0 0">`)).toBeUndefined();
    expect(svgSize("<html>no picture</html>")).toBeUndefined();
  });

  it("tries every picture whatever its declared type, skips video, and spots an SVG served as anything", async () => {
    expect(await measure(bytes("x"), "video/mp4")).toBeUndefined();
    expect(await measure(bytes("x"), "audio/mpeg")).toBeUndefined();
    expect(await measure(bytes(`<svg width="24" height="24"></svg>`), "application/octet-stream")).toEqual({w: 24, h: 24});
    expect(await measure(bytes(`<svg viewBox="0 0 30 20"/>`), "image/svg+xml")).toEqual({w: 30, h: 20});
    expect(await measure(bytes("png"), "")).toEqual({w: 500, h: 500});
    (createImageBitmap as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("not a picture"));
    expect(await measure(bytes("junk"), "text/plain")).toBeUndefined();
  });

  it("finds a file's size as measured, from its saved bytes, or from the web once", async () => {
    store[LIBRARY_INDEX] = [["https://cdn.test/known.jpg", {bytes: 1, at: 1, w: 40, h: 30}], ["https://cdn.test/wide.jpg", {bytes: 1, at: 2, w: 90}]];
    await (await caches.open(LIBRARY_CACHE)).put("https://cdn.test/kept.svg", new Response(`<svg width="12" height="12"/>`, {headers: {"content-type": "image/svg+xml"}}));
    await (await caches.open(LIBRARY_CACHE)).put("https://cdn.test/plain.jpg", new Response(new Uint8Array(4)));
    const library = new MediaLibrary();
    expect(await library.sizeFor("https://cdn.test/known.jpg")).toEqual({w: 40, h: 30});
    expect(await library.sizeFor("https://cdn.test/wide.jpg")).toEqual({w: 90, h: 0});
    expect(await library.sizeFor("https://cdn.test/kept.svg")).toEqual({w: 12, h: 12});
    expect(await library.sizeFor("https://cdn.test/plain.jpg")).toEqual({w: 500, h: 500});
    expect(fetch).not.toHaveBeenCalled();
    expect(await library.sizeFor("https://cdn.test/web.jpg")).toEqual({w: 500, h: 500});
    // A web file sent with no type at all is still tried.
    expect(await library.sizeFor("https://cdn.test/untyped-web")).toEqual({w: 500, h: 500});
    expect(await library.sizeFor("https://cdn.test/missing.jpg")).toBeUndefined();
    expect(await library.sizeFor("data:image/png;base64,xx")).toBeUndefined();
    expect(fetch).toHaveBeenCalledTimes(3);
    // A file turned away for being too small keeps the size that ruled it out, with no second fetch.
    sizes["https://cdn.test/tiny.png"] = 3;
    dims[3] = {width: 20, height: 20};
    library.save("https://cdn.test/tiny.png", rules(), seen);
    await settle();
    expect(await library.sizeFor("https://cdn.test/tiny.png")).toEqual({w: 20, h: 20});
    expect(fetch).toHaveBeenCalledTimes(4);
  });
});

describe("favourites", () => {
  it("are never trimmed for space, however full it gets", async () => {
    store.favoriteMedia = ["https://cdn.test/old.jpg", 5];
    const library = new MediaLibrary();
    library.save("https://cdn.test/old.jpg", rules(40), prepared);
    await settle();
    for (const name of ["a", "b", "c", "d"]) {
      library.save(`https://cdn.test/${name}.jpg`, rules(40), seen);
      await settle();
    }
    // The oldest never-seen file would go first, but it is a favourite: the next oldest goes instead.
    expect(saved()).toContain("https://cdn.test/old.jpg");
    expect(saved()).not.toContain("https://cdn.test/a.jpg");
  });

  it("are never removed by the size check, however small", async () => {
    store[LIBRARY_INDEX] = [["https://cdn.test/tiny-fav.jpg", {bytes: 1, at: 1, w: 10, h: 10}], ["https://cdn.test/tiny.jpg", {bytes: 1, at: 2, w: 10, h: 10}]];
    store.favoriteMedia = ["https://cdn.test/tiny-fav.jpg"];
    expect(await new MediaLibrary().audit(rules())).toMatchObject({removed: 1});
    expect([...index().keys()]).toEqual(["https://cdn.test/tiny-fav.jpg"]);
  });

  it("read as none when the stored list is missing or broken", async () => {
    store.favoriteMedia = "corrupt";
    // A size stored with only its width (from an older index) is judged on the width alone.
    store[LIBRARY_INDEX] = [["https://cdn.test/tiny.jpg", {bytes: 1, at: 2, w: 10}]];
    const library = new MediaLibrary();
    expect(await library.audit(rules())).toMatchObject({removed: 1});
    expect(await library.sizeFor("https://cdn.test/tiny.jpg")).toEqual({w: 10, h: 0});
  });
});
