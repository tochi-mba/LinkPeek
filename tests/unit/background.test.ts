import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import type {ScanResult} from "../../src/shared/media";
import {SETTINGS_VERSION} from "../../src/shared/settings";

const core = vi.hoisted(() => ({scanDiscourse: vi.fn(), prefetchDiscourse: vi.fn(), scanGeneric: vi.fn()}));
vi.mock("../../src/core/discourse", () => ({scanDiscourse: core.scanDiscourse, prefetchDiscourse: core.prefetchDiscourse}));
vi.mock("../../src/core/generic", () => ({scanGeneric: core.scanGeneric}));

const result = (url: string, kind: ScanResult["kind"] = "generic", items = 0, complete = true): ScanResult => ({
  url, kind, title: "t", complete,
  items: Array.from({length: items}, (_, i) => ({id: `${url}#${i}`, type: "image" as const, originalUrl: `${url}/${i}.jpg`, previewUrl: `${url}/${i}.jpg`, sourceUrl: url, score: 1})),
  diagnostics: {adapter: "x", ignored: 0, duplicates: 0, warnings: []}
});
const seed = {topic: {id: 1, post_stream: {posts: [], stream: []}}};
const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0));

type Listener = (msg: unknown, sender: unknown, send: (value: unknown) => void) => boolean | undefined;
let onMessage: Listener, onInstalled: (details: {reason: string}) => Promise<void>, onStorage: (changes: Record<string, unknown>, area: string) => void;
let store: Record<string, unknown>, sent: unknown[][], created: unknown[];

/** Sends a message to the worker and resolves with what it answered (and whether it answered asynchronously). */
function send(msg: unknown, sender: unknown = {tab: {id: 3}, frameId: 2}) {
  return new Promise<{async: boolean | undefined; value: any}>(resolve => {
    let answered = false, value: any;
    const async = onMessage(msg, sender, response => {
      answered = true;
      value = response;
      // A synchronous answer arrives before onMessage returns; report it once `async` is known.
      queueMicrotask(() => resolve({async, value}));
    });
    if (!async && !answered) resolve({async, value: undefined});
  });
}

beforeEach(async () => {
  vi.resetModules();
  for (const mock of Object.values(core)) mock.mockReset();
  store = {settings: {}, settingsVersion: SETTINGS_VERSION};
  sent = [];
  created = [];
  vi.stubGlobal("chrome", {
    storage: {
      local: {
        get: vi.fn(async (keys: string[]) => Object.fromEntries(keys.map(key => [key, store[key]]))),
        set: vi.fn(async (values: Record<string, unknown>) => Object.assign(store, values))
      },
      onChanged: {addListener: vi.fn(listener => onStorage = listener)}
    },
    runtime: {
      onInstalled: {addListener: vi.fn(listener => onInstalled = listener)},
      onMessage: {addListener: vi.fn(listener => onMessage = listener)},
      getURL: (path: string) => `chrome-extension://id/${path}`
    },
    tabs: {
      create: vi.fn(async (value: unknown) => created.push(value)),
      sendMessage: vi.fn(async (...args: unknown[]) => sent.push(args))
    },
    downloads: {download: vi.fn(async () => 7)}
  });
  core.scanGeneric.mockImplementation(async (url: string) => result(url, "generic", 1));
  core.prefetchDiscourse.mockImplementation(async (url: string) => ({result: result(url, "discourse", 1, false), seed}));
  core.scanDiscourse.mockImplementation(async (url: string) => result(url, "discourse", 2));
  await import("../../src/background");
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("installation", () => {
  it("starts fresh installs on sparse settings and opens the guide", async () => {
    store = {};
    await onInstalled({reason: "install"});
    expect(store).toEqual({settings: {}, settingsVersion: SETTINGS_VERSION});
    expect(created).toEqual([{url: "chrome-extension://id/onboarding.html"}]);
  });

  it("migrates settings when the extension updates, and ignores other events", async () => {
    store = {settings: {hoverDelay: 450, loopMode: "stop"}};
    await onInstalled({reason: "update"});
    expect(store).toEqual({settings: {hoverDelay: 450, wrapAround: false}, settingsVersion: SETTINGS_VERSION});
    await onInstalled({reason: "chrome_update"});
    expect(created).toEqual([]);
  });
});

describe("scanning", () => {
  it("answers direct media without fetching", async () => {
    const image = await send({type: "LINKPEEK_SCAN", url: "https://x.test/a.gif", kind: "direct-image", token: "t"});
    expect(image).toMatchObject({async: true, value: {kind: "direct-image", items: [{type: "gif"}]}});
    const video = await send({type: "LINKPEEK_SCAN", url: "https://x.test/v.mp4", kind: "direct-video", token: "t"});
    expect(video.value.items[0].type).toBe("video");
    store.settings = {includeVideo: false};
    onStorage({settings: {}}, "local");
    expect((await send({type: "LINKPEEK_SCAN", url: "https://x.test/w.mp4", kind: "direct-video", token: "t"})).value.items).toEqual([]);
  });

  it("scans generic pages and reuses the cached result", async () => {
    const first = await send({type: "LINKPEEK_SCAN", url: "https://x.test/p", kind: "generic", token: "t"});
    expect(first.value.items).toHaveLength(1);
    await send({type: "LINKPEEK_SCAN", url: "https://x.test/p", kind: "generic", token: "t2"});
    expect(core.scanGeneric).toHaveBeenCalledTimes(1);
  });

  it("keeps the cache across unrelated settings changes but not scan-affecting ones", async () => {
    await send({type: "LINKPEEK_SCAN", url: "https://x.test/p", kind: "generic", token: "t"});
    store.settings = {hoverDelay: 50};
    onStorage({settings: {}}, "local");
    onStorage({favorites: {}}, "local");
    onStorage({settings: {}}, "sync");
    await send({type: "LINKPEEK_SCAN", url: "https://x.test/p", kind: "generic", token: "t"});
    expect(core.scanGeneric).toHaveBeenCalledTimes(1);
    store.settings = {minWidth: 10};
    onStorage({settings: {}}, "local");
    await send({type: "LINKPEEK_SCAN", url: "https://x.test/p", kind: "generic", token: "t"});
    expect(core.scanGeneric).toHaveBeenCalledTimes(2);
  });

  it("expires cached scans after the configured time", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
    await send({type: "LINKPEEK_SCAN", url: "https://x.test/p", kind: "generic", token: "t"});
    now.mockReturnValue(1_000 + 60 * 60_000);
    await send({type: "LINKPEEK_SCAN", url: "https://x.test/p", kind: "generic", token: "t"});
    expect(core.scanGeneric).toHaveBeenCalledTimes(2);
  });

  it("streams Discourse progress to every tab watching the same thread, after a short hold", async () => {
    vi.useFakeTimers();
    let finish!: (value: ScanResult) => void;
    core.scanDiscourse.mockImplementation((url: string, _b: number, _m: number, _s: unknown, _seed: unknown, hooks: {onProgress: (r: ScanResult) => void}) => {
      hooks.onProgress(result(url, "discourse", 1, false));
      hooks.onProgress(result(url, "discourse", 2, false));
      return new Promise(resolve => finish = () => {
        hooks.onProgress(result(url, "discourse", 3, false));
        resolve(result(url, "discourse", 4));
      });
    });
    const url = "https://f.test/t/a/1";
    const first = send({type: "LINKPEEK_SCAN", url, kind: "discourse", token: "a"}, {tab: {id: 1}, frameId: 0});
    const second = send({type: "LINKPEEK_SCAN", url, kind: "discourse", token: "b"}, {tab: {id: 2}});
    const noTab = send({type: "LINKPEEK_SCAN", url, kind: "discourse", token: "c"}, {});
    await vi.advanceTimersByTimeAsync(0);
    expect(sent).toEqual([]);
    await vi.advanceTimersByTimeAsync(60);
    expect(sent.map(([tab, message]) => [tab, (message as {token: string}).token, (message as {result: ScanResult}).result.items.length])).toEqual([[1, "a", 2], [2, "b", 2]]);
    expect(sent[1][2]).toEqual({frameId: 0});
    finish(result(url, "discourse", 4));
    const answers = await Promise.all([first, second, noTab]);
    expect(answers.map(answer => answer.value.items.length)).toEqual([4, 4, 4]);
    expect(sent).toHaveLength(4);
    expect(core.scanDiscourse).toHaveBeenCalledTimes(1);
  });

  it("answers fast scans once and can skip progress entirely", async () => {
    core.scanDiscourse.mockImplementation(async (url: string, _b: number, _m: number, _s: unknown, _seed: unknown, hooks: {onProgress?: (r: ScanResult) => void}) => {
      hooks.onProgress?.(result(url, "discourse", 1, false));
      return result(url, "discourse", 2);
    });
    await send({type: "LINKPEEK_SCAN", url: "https://f.test/t/a/1", kind: "discourse", token: "a"});
    store.settings = {progressiveScan: false};
    onStorage({settings: {}}, "local");
    await send({type: "LINKPEEK_SCAN", url: "https://f.test/t/b/2", kind: "discourse", token: "a"});
    await tick();
    expect(sent).toEqual([]);
    expect(core.scanDiscourse.mock.calls[1][5].onProgress).toBeUndefined();
  });

  it("continues from a prefetched Discourse seed instead of refetching the topic", async () => {
    const url = "https://f.test/t/a/1";
    await send({type: "LINKPEEK_PREFETCH", url, kind: "discourse", deep: false});
    await send({type: "LINKPEEK_SCAN", url, kind: "discourse", token: "a"});
    expect(core.scanDiscourse.mock.calls[0][4]).toBe(seed);
  });

  it("cancels a scan only when its last viewer leaves, and starts over after an abort", async () => {
    let signal!: AbortSignal;
    core.scanGeneric.mockImplementation((url: string, _s: unknown, abort: AbortSignal) => {
      signal = abort;
      return new Promise((resolve, reject) => abort.addEventListener("abort", () => reject(Object.assign(new Error("stop"), {name: "AbortError"}))));
    });
    const url = "https://x.test/slow";
    const a = send({type: "LINKPEEK_SCAN", url, kind: "generic", token: "a"});
    const b = send({type: "LINKPEEK_SCAN", url, kind: "generic", token: "b"});
    await tick();
    expect((await send({type: "LINKPEEK_CANCEL_SCAN", url, token: "a"})).value).toEqual({ok: true});
    expect(signal.aborted).toBe(false);
    await send({type: "LINKPEEK_CANCEL_SCAN", url, token: "b"});
    expect(signal.aborted).toBe(true);
    expect((await a).value).toEqual({cancelled: true});
    expect((await b).value).toEqual({cancelled: true});
    await send({type: "LINKPEEK_CANCEL_SCAN", url: "https://x.test/none", token: "z"});
    core.scanGeneric.mockImplementation(async (scanUrl: string) => result(scanUrl, "generic", 1));
    expect((await send({type: "LINKPEEK_SCAN", url, kind: "generic", token: "c"})).value.items).toHaveLength(1);
  });

  it("replaces an aborted task that has not settled yet", async () => {
    const pending: Array<(value: ScanResult) => void> = [];
    core.scanGeneric.mockImplementation((url: string) => new Promise(resolve => pending.push(resolve)));
    const url = "https://x.test/race";
    const first = send({type: "LINKPEEK_SCAN", url, kind: "generic", token: "a"});
    await tick();
    await send({type: "LINKPEEK_CANCEL_SCAN", url, token: "a"});
    const second = send({type: "LINKPEEK_SCAN", url, kind: "generic", token: "b"});
    await tick();
    expect(core.scanGeneric).toHaveBeenCalledTimes(2);
    pending[1](result(url, "generic", 2));
    pending[0](result(url, "generic", 1));
    expect((await second).value.items).toHaveLength(2);
    expect((await first).value.items).toHaveLength(1);
  });

  it("reports scan errors", async () => {
    core.scanGeneric.mockRejectedValue(new Error("HTTP 500"));
    expect((await send({type: "LINKPEEK_SCAN", url: "https://x.test/bad", kind: "generic", token: "a"})).value).toEqual({error: "HTTP 500"});
  });

  it("retries loading settings after a storage failure", async () => {
    (chrome.storage.local.get as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("storage down"));
    expect((await send({type: "LINKPEEK_SCAN", url: "https://x.test/p", kind: "generic", token: "a"})).value).toEqual({error: "storage down"});
    expect((await send({type: "LINKPEEK_SCAN", url: "https://x.test/p", kind: "generic", token: "a"})).value.items).toHaveLength(1);
  });

  it("does not cache results larger than the cache", async () => {
    store.settings = {maxCacheMb: 16};
    onStorage({settings: {}}, "local");
    core.scanGeneric.mockImplementation(async (url: string) => ({...result(url), title: "x".repeat(17 * 1024 * 1024)}));
    await send({type: "LINKPEEK_SCAN", url: "https://x.test/huge", kind: "generic", token: "a"});
    await send({type: "LINKPEEK_SCAN", url: "https://x.test/huge", kind: "generic", token: "a"});
    expect(core.scanGeneric).toHaveBeenCalledTimes(2);
  });
});

describe("prefetching", () => {
  it("prepares direct media, Discourse first pages and generic pages, sharing work in flight", async () => {
    expect((await send({type: "LINKPEEK_PREFETCH", url: "https://x.test/a.png", kind: "direct-image", deep: false})).value.items).toHaveLength(1);
    const [a, b] = await Promise.all([
      send({type: "LINKPEEK_PREFETCH", url: "https://f.test/t/a/1", kind: "discourse", deep: false}),
      send({type: "LINKPEEK_PREFETCH", url: "https://f.test/t/a/1", kind: "discourse", deep: true})
    ]);
    expect(a.value).toEqual(b.value);
    expect(core.prefetchDiscourse).toHaveBeenCalledTimes(1);
    await send({type: "LINKPEEK_PREFETCH", url: "https://f.test/t/a/1", kind: "discourse", deep: false});
    expect(core.prefetchDiscourse).toHaveBeenCalledTimes(1);
    expect((await send({type: "LINKPEEK_PREFETCH", url: "https://x.test/page", kind: "generic", deep: false})).value.items).toHaveLength(1);
    expect(core.scanGeneric.mock.calls[0][3]).toBe(false);
    expect((await send({type: "LINKPEEK_PREFETCH", url: "https://x.test/f.zip", kind: "download", deep: false})).value).toBeNull();
  });

  it("does not cache an empty quick check while a linked-page search could still find media", async () => {
    core.scanGeneric.mockImplementation(async (url: string, _s: unknown, _signal: unknown, deep: boolean) => result(url, "generic", deep ? 2 : 0));
    const url = "https://x.test/index";
    expect((await send({type: "LINKPEEK_PREFETCH", url, kind: "generic", deep: false})).value.items).toEqual([]);
    expect((await send({type: "LINKPEEK_PREFETCH", url, kind: "generic", deep: true})).value.items).toHaveLength(2);
    expect((await send({type: "LINKPEEK_SCAN", url, kind: "generic", token: "a"})).value.items).toHaveLength(2);
    expect(core.scanGeneric).toHaveBeenCalledTimes(2);
  });

  it("upgrades a quick check already in flight to the deep search", async () => {
    let release!: () => void;
    core.scanGeneric.mockImplementation((url: string, _s: unknown, _signal: unknown, deep: boolean) => deep ? Promise.resolve(result(url, "generic", 3)) : new Promise(resolve => release = () => resolve(result(url))));
    const url = "https://x.test/index";
    const shallow = send({type: "LINKPEEK_PREFETCH", url, kind: "generic", deep: false});
    const deep = send({type: "LINKPEEK_PREFETCH", url, kind: "generic", deep: true});
    await tick();
    release();
    expect((await shallow).value.items).toEqual([]);
    expect((await deep).value.items).toHaveLength(3);
  });

  it("caches quick checks that are final, and leaves always-search pages to the full scan", async () => {
    store.settings = {recursiveSearch: "off"};
    onStorage({settings: {}}, "local");
    core.scanGeneric.mockImplementation(async (url: string) => result(url, "generic", 0));
    await send({type: "LINKPEEK_PREFETCH", url: "https://x.test/off", kind: "generic", deep: false});
    await send({type: "LINKPEEK_SCAN", url: "https://x.test/off", kind: "generic", token: "a"});
    expect(core.scanGeneric).toHaveBeenCalledTimes(1);
    store.settings = {recursiveTrigger: "always"};
    onStorage({settings: {}}, "local");
    core.scanGeneric.mockImplementation(async (url: string) => result(url, "generic", 1));
    await send({type: "LINKPEEK_PREFETCH", url: "https://x.test/always", kind: "generic", deep: false});
    await send({type: "LINKPEEK_SCAN", url: "https://x.test/always", kind: "generic", token: "a"});
    expect(core.scanGeneric).toHaveBeenCalledTimes(3);
  });

  it("lets a scan wait for a running prefetch, even one that fails", async () => {
    let fail!: () => void;
    core.prefetchDiscourse.mockImplementation(() => new Promise((_, reject) => fail = () => reject(new Error("offline"))));
    const url = "https://f.test/t/a/1";
    const prefetch = send({type: "LINKPEEK_PREFETCH", url, kind: "discourse", deep: false});
    const scan = send({type: "LINKPEEK_SCAN", url, kind: "discourse", token: "a"});
    await tick();
    fail();
    expect((await prefetch).value).toEqual({error: "offline"});
    expect((await scan).value.items).toHaveLength(2);
    expect(core.scanDiscourse.mock.calls[0][4]).toBeUndefined();
  });
});

describe("GIF bytes, downloads and housekeeping", () => {
  const bytes = (size: number, headers: Record<string, string> = {}) => new Response(new Uint8Array(size).fill(65), {headers});
  it("checks each caller's limit even for cached and shared GIF bytes", async () => {
    vi.stubGlobal("fetch",vi.fn(async()=>bytes(2*1024*1024)));
    const [large,small]=await Promise.all([
      send({type:"LINKPEEK_FETCH_BINARY",url:"https://x.test/large.gif",maxMb:4}),
      send({type:"LINKPEEK_FETCH_BINARY",url:"https://x.test/large.gif",maxMb:1})
    ]);
    expect(large.value.bytes).toBe(2*1024*1024);
    expect(small.value.error).toContain("larger");
    expect((await send({type:"LINKPEEK_FETCH_BINARY",url:"https://x.test/large.gif",maxMb:1})).value.error).toContain("larger");
  });

  it("fetches GIF bytes once, shares the work and caches the result", async () => {
    const fetch = vi.fn(async () => bytes(3, {"content-type": "image/gif"}));
    vi.stubGlobal("fetch", fetch);
    const [a, b] = await Promise.all([
      send({type: "LINKPEEK_FETCH_BINARY", url: "https://x.test/a.gif", maxMb: 1}),
      send({type: "LINKPEEK_FETCH_BINARY", url: "https://x.test/a.gif", maxMb: 1})
    ]);
    expect(a.value).toEqual({base64: "QUFB", mime: "image/gif", bytes: 3});
    expect(b.value).toEqual(a.value);
    await send({type: "LINKPEEK_FETCH_BINARY", url: "https://x.test/a.gif"});
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("refuses unsupported URLs, failed responses and files over the limit", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.includes("404")) return new Response("", {status: 404});
      if (url.includes("announced")) return bytes(1, {"content-length": String(3 * 1024 * 1024)});
      return bytes(2 * 1024 * 1024 + 1);
    }));
    expect((await send({type: "LINKPEEK_FETCH_BINARY", url: "ftp://x.test/a.gif", maxMb: 1})).value).toEqual({error: "Unsupported media URL"});
    expect((await send({type: "LINKPEEK_FETCH_BINARY", url: "https://x.test/404.gif", maxMb: 1})).value).toEqual({error: "HTTP 404 for media"});
    expect((await send({type: "LINKPEEK_FETCH_BINARY", url: "https://x.test/announced.gif", maxMb: 2})).value.error).toMatch(/larger than/);
    expect((await send({type: "LINKPEEK_FETCH_BINARY", url: "https://x.test/actual.gif", maxMb: 2})).value.error).toMatch(/larger than/);
    const plain = await send({type: "LINKPEEK_FETCH_BINARY", url: "https://x.test/plain.gif", maxMb: 5});
    expect(plain.value.mime).toBe("application/octet-stream");
  });

  it("downloads with a safe name, retrying without one when the browser refuses it", async () => {
    expect((await send({type: "LINKPEEK_DOWNLOAD", url: "https://x.test/a.jpg", filename: "a.jpg"})).value).toEqual({id: 7});
    const download = chrome.downloads.download as ReturnType<typeof vi.fn>;
    download.mockRejectedValueOnce(new Error("Invalid filename"));
    expect((await send({type: "LINKPEEK_DOWNLOAD", url: "https://x.test/b.jpg", filename: "b.jpg"})).value).toEqual({id: 7});
    expect(download.mock.calls.at(-1)![0]).toEqual({url: "https://x.test/b.jpg", conflictAction: "uniquify", saveAs: false});
    download.mockRejectedValueOnce(new Error("Download blocked"));
    expect((await send({type: "LINKPEEK_DOWNLOAD", url: "https://x.test/c.jpg"})).value).toEqual({error: "Download blocked"});
  });

  it("uses the default GIF size limit when none is given", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => bytes(1)));
    expect((await send({type: "LINKPEEK_FETCH_BINARY", url: "https://x.test/limit.gif", maxMb: Number.NaN})).value.bytes).toBe(1);
  });

  it("downloads a whole gallery into one folder, numbered in order, two at a time", async () => {
    const download = chrome.downloads.download as ReturnType<typeof vi.fn>;
    const items = Array.from({length: 10}, (_, i) => ({url: `https://x.test/${i}.jpg`, filename: `${i}.jpg`}));
    download.mockRejectedValueOnce(new Error("Invalid filename")).mockRejectedValueOnce(new Error("blocked")).mockRejectedValueOnce(new Error("blocked"));
    expect((await send({type: "LINKPEEK_DOWNLOAD_ALL", folder: "Trip", items})).value).toEqual({started: 9, failed: 1});
    const names = download.mock.calls.map(([options]) => options.filename);
    expect(names).toContain("Trip/01 0.jpg");
    expect(names).toContain("Trip/10 9.jpg");
    expect(download).toHaveBeenCalledTimes(12);
  });

  it("opens a background tab right after the page's own tab", async () => {
    expect((await send({type: "LINKPEEK_OPEN_TAB", url: "https://x.test/a.jpg"}, {tab: {id: 3, index: 4}})).value).toEqual({ok: true});
    expect(created.at(-1)).toEqual({url: "https://x.test/a.jpg", active: false, index: 5, openerTabId: 3});
    await send({type: "LINKPEEK_OPEN_TAB", url: "https://x.test/b.jpg", active: true}, {});
    expect(created.at(-1)).toEqual({url: "https://x.test/b.jpg", active: true, index: undefined, openerTabId: undefined});
  });

  it("clears every cache on request and ignores unknown messages", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => bytes(1)));
    await send({type: "LINKPEEK_SCAN", url: "https://x.test/p", kind: "generic", token: "a"});
    await send({type: "LINKPEEK_FETCH_BINARY", url: "https://x.test/a.gif", maxMb: 1});
    expect((await send({type: "LINKPEEK_CLEAR_CACHE"})).value).toEqual({ok: true});
    await send({type: "LINKPEEK_SCAN", url: "https://x.test/p", kind: "generic", token: "a"});
    await send({type: "LINKPEEK_FETCH_BINARY", url: "https://x.test/a.gif", maxMb: 1});
    expect(core.scanGeneric).toHaveBeenCalledTimes(2);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(await send({type: "SOMETHING_ELSE"})).toEqual({async: false, value: undefined});
    expect(await send(undefined)).toEqual({async: false, value: undefined});
  });
});
