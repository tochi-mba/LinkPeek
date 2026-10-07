import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {fakeCaches} from "./fake-caches";
import type {ScanResult} from "../../src/shared/media";
import {mediaKey, SEEN_PREFIX} from "../../src/shared/seen-media";
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
let onWindowRemoved: (id: number) => void, onWindowBounds: (window: chrome.windows.Window) => void;
let onDownloadChanged: (delta: chrome.downloads.DownloadDelta) => void;
let store: Record<string, unknown>, sessionStore: Record<string, unknown>, sent: unknown[][], created: unknown[], mirrorWindow: number | undefined;
let broadcasts: unknown[];

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
  // Downloading prepared galleries is tested on its own; elsewhere it would add fetches the tests count.
  store = {settings: {savePreparedMedia: false}, settingsVersion: SETTINGS_VERSION};
  sessionStore = {};
  sent = [];
  created = [];
  broadcasts = [];
  mirrorWindow = undefined;
  vi.stubGlobal("chrome", {
    storage: {
      local: {
        get: vi.fn(async (keys: string | string[]) => Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map(key => [key, store[key]]))),
        set: vi.fn(async (values: Record<string, unknown>) => Object.assign(store, values)),
        remove: vi.fn(async (keys: string | string[]) => (Array.isArray(keys) ? keys : [keys]).forEach(key => delete store[key]))
      },
      session: {
        get: vi.fn(async (key: string) => ({[key]: sessionStore[key]})),
        set: vi.fn(async (values: Record<string, unknown>) => Object.assign(sessionStore, values)),
        remove: vi.fn(async (key: string) => { delete sessionStore[key]; })
      },
      onChanged: {addListener: vi.fn(listener => onStorage = listener)}
    },
    runtime: {
      onInstalled: {addListener: vi.fn(listener => onInstalled = listener)},
      onMessage: {addListener: vi.fn(listener => onMessage = listener)},
      sendMessage: vi.fn(async (msg: unknown) => void broadcasts.push(msg)),
      getURL: (path: string) => `chrome-extension://id/${path}`
    },
    tabs: {
      create: vi.fn(async (value: unknown) => created.push(value)),
      query: vi.fn(async () => [{id: 3}, {}]),
      sendMessage: vi.fn(async (...args: unknown[]) => sent.push(args))
    },
    windows: {
      create: vi.fn(async () => ({id: mirrorWindow = 42})),
      get: vi.fn(async (id: number) => {
        if (id !== mirrorWindow) throw new Error("No window");
        return {id};
      }),
      remove: vi.fn(async (id: number) => {
        if (id === mirrorWindow) mirrorWindow = undefined;
      }),
      onRemoved: {addListener: vi.fn(listener => onWindowRemoved = listener)},
      onBoundsChanged: {addListener: vi.fn(listener => onWindowBounds = listener)},
      update: vi.fn(async () => undefined)
    },
    downloads: {
      download: vi.fn(async () => 7), removeFile: vi.fn(async () => undefined), erase: vi.fn(async () => undefined), search: vi.fn(async () => []),
      onChanged: {addListener: vi.fn(listener => onDownloadChanged = listener)}
    },
    action: {setBadgeText: vi.fn(async () => undefined)}
  });
  core.scanGeneric.mockImplementation(async (url: string) => result(url, "generic", 1));
  core.prefetchDiscourse.mockImplementation(async (url: string) => ({result: result(url, "discourse", 1, false), seed}));
  core.scanDiscourse.mockImplementation(async (url: string) => result(url, "discourse", 2));
  await import("../../src/background");
  // The first import compiles the whole worker under coverage, which can pass 10 s on a busy machine.
}, 30_000);
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

describe("Tumblr downloads", () => {
  it("starts, reports and stops the background job, and forwards download events", async () => {
    expect(await send({type: "LINKPEEK_TUMBLR_STATUS"})).toMatchObject({async: true, value: undefined});
    let release!: () => void;
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(resolve => release = () => resolve(new Response('{"API_TOKEN":"token"}')))));
    const started = await send({type: "LINKPEEK_TUMBLR_START", blog: "demo"});
    expect(started).toMatchObject({async: false, value: {blog: "demo", phase: "collecting"}});
    await tick();
    expect((await send({type: "LINKPEEK_TUMBLR_START", blog: "other"})).value.queue).toEqual(["other"]);
    expect((await send({type: "LINKPEEK_TUMBLR_REMOVE_QUEUED", blog: "other"})).value.queue).toEqual([]);
    await send({type: "LINKPEEK_TUMBLR_START", blog: "third"});
    expect((await send({type: "LINKPEEK_TUMBLR_CLEAR_QUEUE"})).value.queue).toEqual([]);
    onDownloadChanged({id: 4, state: {current: "in_progress"}} as chrome.downloads.DownloadDelta);
    expect(await send({type: "LINKPEEK_TUMBLR_STOP"})).toMatchObject({async: false, value: {ok: true}});
    release();
    await tick();
    expect((await send({type: "LINKPEEK_TUMBLR_STATUS"})).value).toMatchObject({blog: "demo", phase: "stopped"});
  });

  it("puts completed posts in the Library with captions, tags, source and device-wide seen state", async () => {
    fakeCaches();
    const first = "https://64.media.tumblr.com/first.jpg", second = "https://64.media.tumblr.com/second.jpg", duplicate = "https://64.media.tumblr.com/copy.jpg", untitled = "https://64.media.tumblr.com/untitled.jpg";
    const key = mediaKey({originalUrl: first});
    store[SEEN_PREFIX + key[0]] = [key];
    vi.mocked(chrome.downloads.download).mockImplementationOnce(async () => 71).mockImplementationOnce(async () => 72).mockImplementationOnce(async () => 73).mockImplementationOnce(async () => 74);
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url === "https://www.tumblr.com/demo") return new Response('{"API_TOKEN":"token"}');
      if (url.startsWith("https://www.tumblr.com/api/")) return Response.json({response: {total_posts: 4, posts: [
        {object_type: "post", id_string: "1", timestamp: 10, post_url: "https://demo.tumblr.com/post/1", summary: "Beach caption", tags: ["summer"], content: [{type: "image", media: [{url: first}]}]},
        {object_type: "post", id_string: "2", timestamp: 20, post_url: "https://demo.tumblr.com/post/2", tags: ["summer", "friends"], content: [{type: "text", text: "<p>Caption from NPF</p>"}, {type: "image", media: [{url: second}]}]},
        {object_type: "post", id_string: "3", timestamp: 30, post_url: "https://demo.tumblr.com/post/3", summary: "Same file, another URL", content: [{type: "image", media: [{url: duplicate}]}]},
        {object_type: "post", id_string: "4", timestamp: 40, content: [{type: "image", media: [{url: untitled}]}]}
      ]}});
      return new Response(new Uint8Array([url === first ? 1 : url === untitled ? 4 : 2, 0, 0, 0]), {headers: {"content-type": "image/jpeg"}});
    }));
    await send({type: "LINKPEEK_TUMBLR_START", blog: "demo"});
    for (let i = 0; i < 20 && vi.mocked(chrome.downloads.download).mock.calls.length < 3; i++) await tick();
    expect(chrome.downloads.download).toHaveBeenCalledTimes(3);
    onDownloadChanged({id: 71, state: {current: "complete"}} as chrome.downloads.DownloadDelta);
    for (let i = 0; i < 30 && vi.mocked(chrome.downloads.download).mock.calls.length < 4; i++) await tick();
    expect(chrome.downloads.download).toHaveBeenCalledTimes(4);
    onDownloadChanged({id: 72, state: {current: "complete"}} as chrome.downloads.DownloadDelta);
    onDownloadChanged({id: 73, state: {current: "complete"}} as chrome.downloads.DownloadDelta);
    onDownloadChanged({id: 74, state: {current: "complete"}} as chrome.downloads.DownloadDelta);
    for (let i = 0; i < 30 && (await send({type: "LINKPEEK_LIBRARY_STATS"})).value.count < 3; i++) await tick();
    for (let i = 0; i < 30 && !vi.mocked(chrome.downloads.removeFile).mock.calls.some(([id]) => id === 73); i++) await tick();
    expect((await send({type: "LINKPEEK_LIBRARY_AUDIT"})).value).toMatchObject({checked: 3, removed: 0, mirrored: 0});
    let index = new Map(store.mediaIndex as Array<[string, any]>);
    expect(index.get(first)).toMatchObject({
      seen: true, type: "image", source: "https://demo.tumblr.com/post/1", title: "Beach caption · #summer",
      original: first, dl: 71, external: true
    });
    expect(index.get(second)).toMatchObject({seen: false, title: "Caption from NPF · #summer #friends", dl: 72, external: true});
    expect(index.get(untitled)).toMatchObject({source: "https://www.tumblr.com/demo/4", title: "@demo · post 4", dl: 74, external: true});
    expect(chrome.downloads.download).toHaveBeenCalledTimes(4);
    expect(chrome.downloads.removeFile).toHaveBeenCalledWith(73);
    expect(chrome.downloads.erase).toHaveBeenCalledWith({id: 73});
    expect((await send({type: "LINKPEEK_LIBRARY_SEEN", url: second})).value).toEqual({ok: true});
    await send({type: "LINKPEEK_LIBRARY_AUDIT"});
    index = new Map(store.mediaIndex as Array<[string, any]>);
    expect(index.get(second)!.seen).toBe(true);
  });
});

describe("the mirror window", () => {
  it("opens, announces, discovers and closes the mirror", async () => {
    expect(await send({type: "LINKPEEK_TOGGLE_MIRROR"})).toMatchObject({async: true, value: {open: true}});
    expect(chrome.windows.create).toHaveBeenCalledWith({url: "chrome-extension://id/mirror.html", type: "popup", left: undefined, top: undefined, width: 1100, height: 760});

    sent = [];
    expect(await send({type: "LINKPEEK_MIRROR_READY"})).toMatchObject({async: true, value: {open: true}});
    expect(sent).toEqual([[3, {type: "LINKPEEK_MIRROR_OPEN", open: true}]]);
    expect(await send({type: "LINKPEEK_MIRROR_QUERY"})).toMatchObject({async: true, value: {open: true}});

    sent = [];
    expect(await send({type: "LINKPEEK_TOGGLE_MIRROR"})).toMatchObject({value: {open: false}});
    expect(chrome.windows.remove).toHaveBeenCalledWith(42);
    expect(sent).toEqual([[3, {type: "LINKPEEK_MIRROR_OPEN", open: false}]]);
  });

  it("reopens where it was last left: same place, size and full-screen state", async () => {
    await send({type: "LINKPEEK_TOGGLE_MIRROR"});
    onWindowBounds({id: 5} as chrome.windows.Window);
    await tick();
    expect(store.mirrorBounds).toBeUndefined();
    onWindowBounds({id: 42, left: 1920, top: 40, width: 1280, height: 900, state: "normal"} as chrome.windows.Window);
    await tick();
    await tick();
    expect(store.mirrorBounds).toEqual({left: 1920, top: 40, width: 1280, height: 900, state: "normal"});
    onWindowBounds({id: 42, left: 1920, top: 0, width: 2560, height: 1440, state: "fullscreen"} as chrome.windows.Window);
    await tick();
    await tick();
    expect(store.mirrorBounds).toEqual({left: 1920, top: 0, width: 1280, height: 900, state: "fullscreen"});
    await send({type: "LINKPEEK_TOGGLE_MIRROR"});
    (chrome.windows.update as ReturnType<typeof vi.fn>).mockClear();
    await send({type: "LINKPEEK_TOGGLE_MIRROR"});
    expect(chrome.windows.create).toHaveBeenLastCalledWith({url: "chrome-extension://id/mirror.html", type: "popup", left: 1920, top: 0, width: 1280, height: 900});
    expect(chrome.windows.update).toHaveBeenCalledWith(42, {state: "fullscreen"});
    // Maximised before any normal size was known keeps a sensible size for coming back.
    delete store.mirrorBounds;
    onWindowBounds({id: 42, left: 0, top: 0, width: 2560, height: 1400, state: "maximized"} as chrome.windows.Window);
    await tick();
    await tick();
    expect(store.mirrorBounds).toEqual({left: 0, top: 0, width: 1100, height: 760, state: "maximized"});
    onWindowBounds({id: 42, left: 0, top: 0, width: 800, height: 600, state: "minimized"} as chrome.windows.Window);
    await tick();
    await tick();
    expect(store.mirrorBounds).toMatchObject({state: "normal"});
  });

  it("recovers after worker suspension and notices the mirror closing", async () => {
    mirrorWindow = 77;
    sessionStore.mirrorWindowId = 77;
    expect(await send({type: "LINKPEEK_MIRROR_QUERY"})).toMatchObject({value: {open: true}});
    onWindowRemoved(1);
    await tick();
    expect(sent).toEqual([]);

    mirrorWindow = undefined;
    onWindowRemoved(77);
    await tick();
    expect(sent).toEqual([[3, {type: "LINKPEEK_MIRROR_OPEN", open: false}]]);
    expect(sessionStore).toEqual({});
  });

  it("tolerates a window disappearing while it is being toggled", async () => {
    mirrorWindow = 51;
    sessionStore.mirrorWindowId = 51;
    vi.mocked(chrome.windows.remove).mockRejectedValueOnce(new Error("already closed"));
    expect(await send({type: "LINKPEEK_TOGGLE_MIRROR"})).toMatchObject({value: {open: false}});
  });

  it("forgets a stale saved window and records a mirror that announces itself", async () => {
    sessionStore.mirrorWindowId = 88;
    expect(await send({type: "LINKPEEK_MIRROR_QUERY"})).toMatchObject({value: {open: false}});
    expect(sessionStore).toEqual({});

    await send({type: "LINKPEEK_MIRROR_READY"}, {tab: {id: 9, windowId: 63}});
    expect(sessionStore).toEqual({mirrorWindowId: 63});
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

  it("serves GIF bytes from the saved media library before touching the network", async () => {
    const api = fakeCaches();
    const cache = await api.open("linkpeek-media");
    await cache.put("https://x.test/kept.gif", new Response(new Uint8Array(3).fill(65), {headers: {"content-type": "image/gif"}}));
    await cache.put("https://x.test/fat.gif", new Response(new Uint8Array(1024 * 1024 + 1).fill(65)));
    await cache.put("https://x.test/plain.gif", new Response(new Uint8Array(2).fill(65)));
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    expect((await send({type: "LINKPEEK_FETCH_BINARY", url: "https://x.test/kept.gif", maxMb: 1})).value).toEqual({base64: "QUFB", mime: "image/gif", bytes: 3});
    expect((await send({type: "LINKPEEK_FETCH_BINARY", url: "https://x.test/fat.gif", maxMb: 1})).value.error).toMatch(/larger than/);
    expect((await send({type: "LINKPEEK_FETCH_BINARY", url: "https://x.test/plain.gif", maxMb: 1})).value.mime).toBe("application/octet-stream");
    expect(fetch).not.toHaveBeenCalled();
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

describe("galleries kept on the device", () => {
  const sent = () => (chrome.tabs.sendMessage as ReturnType<typeof vi.fn>).mock.calls;

  it("answer a scan straight away while fresh, show an old one at once while a fresh scan runs, and serve preparation", async () => {
    await send({type: "LINKPEEK_SCAN", url: "https://x.test/kept", kind: "generic", token: "a"});
    await tick();
    expect(store["gallery:https://x.test/kept"]).toMatchObject({url: "https://x.test/kept", result: {items: [expect.anything()]}});
    // A new session of the service worker: memory is empty, the device still has it.
    vi.resetModules();
    await import("../../src/background");
    core.scanGeneric.mockClear();
    expect((await send({type: "LINKPEEK_SCAN", url: "https://x.test/kept", kind: "generic", token: "b"})).value.url).toBe("https://x.test/kept");
    expect((await send({type: "LINKPEEK_PREFETCH", url: "https://x.test/kept", kind: "generic", deep: false})).value.url).toBe("https://x.test/kept");
    expect(core.scanGeneric).not.toHaveBeenCalled();
    (store["gallery:https://x.test/kept"] as {at: number}).at -= 2 * 60 * 60_000;
    vi.resetModules();
    await import("../../src/background");
    await send({type: "LINKPEEK_SCAN", url: "https://x.test/kept", kind: "generic", token: "c"}, {tab: {id: 9}, frameId: 0});
    expect(sent().some(([tab, msg]) => tab === 9 && msg.type === "LINKPEEK_SCAN_PROGRESS" && msg.token === "c")).toBe(true);
    expect(core.scanGeneric).toHaveBeenCalledTimes(1);
    vi.resetModules();
    await import("../../src/background");
    (store["gallery:https://x.test/kept"] as {at: number}).at -= 2 * 60 * 60_000;
    await send({type: "LINKPEEK_SCAN", url: "https://x.test/kept", kind: "generic", token: "d"}, {});
    vi.resetModules();
    await import("../../src/background");
    (store["gallery:https://x.test/kept"] as {at: number}).at -= 2 * 60 * 60_000;
    await send({type: "LINKPEEK_SCAN", url: "https://x.test/kept", kind: "generic", token: "e"}, {tab: {id: 9}});
    expect(sent().some(([tab, msg, options]) => tab === 9 && msg.token === "e" && options.frameId === 0)).toBe(true);
    // Preparation in a fresh session answers from the device too.
    vi.resetModules();
    await import("../../src/background");
    core.scanGeneric.mockClear();
    expect((await send({type: "LINKPEEK_PREFETCH", url: "https://x.test/kept", kind: "generic", deep: false})).value.url).toBe("https://x.test/kept");
    expect(core.scanGeneric).not.toHaveBeenCalled();
  });

  it("are not used or kept while that is off, report their size, and can be forgotten", async () => {
    // Earlier tests' workers may still flush their gallery index into this storage on a timer. Reading the
    // stats first pins this worker's own index in memory, and everything below is measured against it.
    const before = (await send({type: "LINKPEEK_GALLERY_STATS"})).value.count as number;
    store.settings = {rememberGalleries: false};
    onStorage({settings: {newValue: store.settings}}, "local");
    await send({type: "LINKPEEK_SCAN", url: "https://x.test/off", kind: "generic", token: "a"});
    await send({type: "LINKPEEK_PREFETCH", url: "https://x.test/off2", kind: "generic", deep: true});
    await tick();
    expect([store["gallery:https://x.test/off"], store["gallery:https://x.test/off2"]]).toEqual([undefined, undefined]);
    expect((await send({type: "LINKPEEK_GALLERY_STATS"})).value.count).toBe(before);
    store.settings = {};
    onStorage({settings: {newValue: store.settings}}, "local");
    await send({type: "LINKPEEK_SCAN", url: "https://x.test/on", kind: "generic", token: "b"});
    await tick();
    expect((await send({type: "LINKPEEK_GALLERY_STATS"})).value.count).toBe(before + 1);
    expect((await send({type: "LINKPEEK_FORGET_GALLERIES"})).value).toEqual({ok: true});
    expect(store["gallery:https://x.test/on"]).toBeUndefined();
  });

  it("search linked pages on request, as their own scan, after any preparation of that link finishes", async () => {
    let finish!: (value: unknown) => void;
    core.scanGeneric.mockImplementationOnce(() => new Promise(resolve => finish = resolve));
    const warming = send({type: "LINKPEEK_PREFETCH", url: "https://x.test/tiny", kind: "generic", deep: false});
    while (!finish) await tick();
    const linked = send({type: "LINKPEEK_SCAN", url: "https://x.test/tiny", kind: "generic", token: "a", linked: true});
    await tick();
    expect(core.scanGeneric).toHaveBeenCalledTimes(1);
    finish(result("https://x.test/tiny", "generic", 1));
    await warming;
    await linked;
    expect(core.scanGeneric.mock.calls.at(-1)![1]).toMatchObject({recursiveTrigger: "always"});
  });
});

describe("history and fingerprints", () => {
  it("save a first sighting's file for offline viewing, as settings allow, and report or delete the library", async () => {
    const api = fakeCaches();
    vi.stubGlobal("fetch", vi.fn(async (url: string) => new Response(new Uint8Array([url.includes("1-s") ? 1 : 2, 0, 0, 0]), {headers: {"content-type": "image/jpeg"}})));
    await send({type: "LINKPEEK_HISTORY_ADD", entry: {a: 1, o: "https://cdn.test/1.jpg", p: "https://cdn.test/1-s.jpg", t: "image", s: "https://x.test"}});
    await send({type: "LINKPEEK_HISTORY_ADD", entry: {a: 2, o: "https://cdn.test/2.gif", p: "https://cdn.test/2-s.gif", t: "gif", s: "https://x.test"}});
    for (let i = 0; i < 10; i++) await tick();
    expect([...api.stores.get("linkpeek-media")!.keys()].sort()).toEqual(["https://cdn.test/1-s.jpg", "https://cdn.test/2.gif"]);
    expect((await send({type: "LINKPEEK_LIBRARY_STATS"})).value).toEqual({count: 2, bytes: 8});
    expect((await send({type: "LINKPEEK_LIBRARY_CLEAR"})).value).toEqual({ok: true});
    store.settings = {saveMediaOffline: false, keepHistory: false};
    onStorage({settings: {newValue: store.settings}}, "local");
    await send({type: "LINKPEEK_HISTORY_ADD", entry: {a: 3, o: "https://cdn.test/3.jpg", p: "", t: "image", s: "https://x.test"}});
    for (let i = 0; i < 10; i++) await tick();
    expect(api.stores.get("linkpeek-media")?.size ?? 0).toBe(0);
  });

  it("download the files of prepared and scanned galleries as not seen yet, and open the library on request", async () => {
    const api = fakeCaches();
    store.settings = {};
    onStorage({settings: {newValue: store.settings}}, "local");
    vi.stubGlobal("fetch", vi.fn(async (url: string) => new Response(new Uint8Array([url.endsWith("b.mp4") ? 2 : 1, 0, 0]), {headers: {"content-type": "image/jpeg"}})));
    core.scanGeneric.mockImplementation(async (url: string) => ({...result(url, "generic", 2), items: [
      {id: "a", type: "image", originalUrl: `${url}/a.jpg`, previewUrl: `${url}/a-s.jpg`, sourceUrl: url, sourceTitle: "Page", score: 1},
      {id: "b", type: "video", originalUrl: `${url}/b.mp4`, previewUrl: `${url}/b.mp4`, posterUrl: `${url}/b.jpg`, sourceUrl: url, score: 1}
    ]}));
    await send({type: "LINKPEEK_PREFETCH", url: "https://x.test/prepared", kind: "generic", deep: false});
    for (let i = 0; i < 12; i++) await tick();
    expect([...api.stores.get("linkpeek-media")!.keys()].sort()).toEqual(["https://x.test/prepared/a-s.jpg", "https://x.test/prepared/b.mp4"]);
    await new Promise(resolve => setTimeout(resolve, 5100));
    const index = new Map(store.mediaIndex as Array<[string, {seen: boolean; title?: string; preview?: string; original?: string}]>);
    expect(index.get("https://x.test/prepared/a-s.jpg")).toMatchObject({seen: false, title: "Page", original: "https://x.test/prepared/a.jpg"});
    expect(index.get("https://x.test/prepared/b.mp4")).toMatchObject({seen: false, preview: "https://x.test/prepared/b.jpg"});
    created.length = 0;
    expect((await send({type: "LINKPEEK_OPEN_LIBRARY", view: "saved", filter: "unseen"})).value).toEqual({ok: true});
    await send({type: "LINKPEEK_OPEN_LIBRARY"});
    expect(created).toEqual([{url: "chrome-extension://id/history.html?view=saved&filter=unseen"}, {url: "chrome-extension://id/history.html"}]);
  }, 20_000);

  it("checks the saved files on demand, removing too-small ones and filling in Downloads copies", async () => {
    fakeCaches();
    store.mediaIndex = [
      ["https://cdn.test/small.jpg", {bytes: 3, at: 1, w: 20, h: 300, dl: 9}],
      ["https://cdn.test/fine.jpg", {bytes: 4, at: 2, w: 900, h: 900}]
    ];
    expect((await send({type: "LINKPEEK_LIBRARY_AUDIT"})).value).toEqual({checked: 2, removed: 1, mirrored: 1, historyRemoved: 0});
    expect(chrome.downloads.removeFile).toHaveBeenCalledWith(9);
    const index = new Map(store.mediaIndex as Array<[string, {dl?: number}]>);
    expect([[...index.keys()], index.get("https://cdn.test/fine.jpg")!.dl]).toEqual([["https://cdn.test/fine.jpg"], 7]);
    // Every change and the last file reach the page as one-line progress.
    const ticks = broadcasts.filter((msg: any) => msg.type === "LINKPEEK_AUDIT_TICK") as any[];
    expect(ticks).toHaveLength(2);
    expect(ticks[1]).toMatchObject({checked: 2, total: 2, removed: 1, mirrored: 1, url: "https://cdn.test/fine.jpg"});
  });

  it("checks the history after the files, reusing the sizes the files already know", async () => {
    fakeCaches();
    store.mediaIndex = [["https://cdn.test/1-s.jpg", {bytes: 3, at: 1, w: 20, h: 20}]];
    store.historyMeta = {first: 0, last: 0};
    store["history:0"] = [
      {a: 1, o: "https://cdn.test/1.jpg", p: "https://cdn.test/1-s.jpg", t: "image", s: "https://x.test"},
      {a: 2, o: "https://cdn.test/2.jpg", p: "https://cdn.test/2-s.jpg", t: "image", s: "https://x.test", w: 900, h: 700},
      {a: 3, o: "https://cdn.test/3.mp4", p: "", t: "video", s: "https://x.test"}
    ];
    const answer = (await send({type: "LINKPEEK_LIBRARY_AUDIT"})).value;
    // The file was too small too, so it went with its sighting.
    expect(answer).toEqual({checked: 1, removed: 1, mirrored: 0, historyRemoved: 1});
    expect((store["history:0"] as Array<{a: number}>).map(entry => entry.a)).toEqual([2, 3]);
    const ticks = broadcasts.filter((msg: any) => msg.type === "LINKPEEK_AUDIT_TICK") as any[];
    expect(ticks.map(tick => tick.phase)).toEqual(["files", "history", "history"]);
    expect(ticks.at(-1)).toMatchObject({checked: 3, total: 3, removed: 1, mirrored: 0});
  });

  it("never judges a favourite's sightings, however small", async () => {
    fakeCaches();
    store.favoriteMedia = ["https://cdn.test/1-s.jpg", "https://cdn.test/3-s.jpg"];
    store.historyMeta = {first: 0, last: 0};
    store["history:0"] = [
      {a: 1, o: "https://cdn.test/1.jpg", p: "https://cdn.test/1-s.jpg", t: "image", s: "https://x.test"},
      {a: 2, o: "https://cdn.test/2.jpg", p: "https://cdn.test/2-s.jpg", t: "image", s: "https://x.test", w: 5, h: 5},
      {a: 3, o: "https://cdn.test/3.jpg", p: "https://cdn.test/3-s.jpg", t: "image", s: "https://x.test", w: 5, h: 5}
    ];
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    expect((await send({type: "LINKPEEK_LIBRARY_AUDIT"})).value).toMatchObject({historyRemoved: 1});
    expect((store["history:0"] as Array<{a: number}>).map(entry => entry.a)).toEqual([1, 3]);
    // A favourite is never even measured.
    expect(fetch).not.toHaveBeenCalled();
  });

  it("takes back the history and saved file of media a preview rejected as too small", async () => {
    fakeCaches();
    store.mediaIndex = [["https://cdn.test/e-s.png", {bytes: 3, at: 1, dl: 4}]];
    store.historyMeta = {first: 0, last: 0};
    store["history:0"] = [
      {a: 1, o: "https://cdn.test/e.png", p: "https://cdn.test/e-s.png", t: "image", s: "https://x.test"},
      {a: 2, o: "https://cdn.test/keep.jpg", p: "https://cdn.test/keep-s.jpg", t: "image", s: "https://x.test"}
    ];
    expect((await send({type: "LINKPEEK_FORGET_MEDIA", original: "https://cdn.test/e.png", saved: "https://cdn.test/e-s.png"})).value).toEqual({ok: true});
    expect((store["history:0"] as Array<{a: number}>).map(entry => entry.a)).toEqual([2]);
    expect(chrome.downloads.removeFile).toHaveBeenCalledWith(4);
  });

  it("ticks every tenth file through a quiet stretch of the check", async () => {
    fakeCaches();
    store.mediaIndex = Array.from({length: 11}, (_, i) => [`https://cdn.test/v${i}.mp4`, {bytes: 1, at: i, type: "video", dl: 50 + i}]);
    expect((await send({type: "LINKPEEK_LIBRARY_AUDIT"})).value).toEqual({checked: 11, removed: 0, mirrored: 0, historyRemoved: 0});
    expect(broadcasts.filter((msg: any) => msg.type === "LINKPEEK_AUDIT_TICK").map((msg: any) => [msg.phase, msg.checked])).toEqual([["files", 10], ["files", 11]]);
  });

  it("forgets a picked set of saved files, and strikes picked entries from the history", async () => {
    fakeCaches();
    store.mediaIndex = [
      ["https://cdn.test/a.jpg", {bytes: 3, at: 1, dl: 9}],
      ["https://cdn.test/b.jpg", {bytes: 4, at: 2}]
    ];
    expect((await send({type: "LINKPEEK_LIBRARY_REMOVE", urls: ["https://cdn.test/a.jpg"]})).value).toEqual({ok: true});
    expect(chrome.downloads.removeFile).toHaveBeenCalledWith(9);
    expect((store.mediaIndex as unknown[]).length).toBe(1);
    store.historyMeta = {first: 0, last: 0};
    store["history:0"] = [{a: 1, o: "https://cdn.test/a.jpg", p: "", t: "image", s: "https://x.test"}, {a: 2, o: "https://cdn.test/b.jpg", p: "", t: "image", s: "https://x.test"}];
    expect((await send({type: "LINKPEEK_HISTORY_REMOVE", entries: [{a: 1, o: "https://cdn.test/a.jpg"}]})).value).toEqual({ok: true});
    expect(store["history:0"]).toEqual([{a: 2, o: "https://cdn.test/b.jpg", p: "", t: "image", s: "https://x.test"}]);
  });

  it("cleans and migrates the saved files when the extension updates", async () => {
    fakeCaches();
    store.mediaIndex = [["https://cdn.test/small.jpg", {bytes: 3, at: 1, w: 20, h: 300}]];
    await onInstalled({reason: "update"});
    expect(store.mediaIndex).toEqual([]);
  });

  it("append to the history and clear it", async () => {
    vi.useFakeTimers();
    expect((await send({type: "LINKPEEK_HISTORY_ADD", entry: {a: 1, o: "https://cdn.test/1.jpg", p: "", t: "image", s: "https://x.test"}})).value).toEqual({ok: true});
    await vi.advanceTimersByTimeAsync(2000);
    expect(store.historyMeta).toEqual({first: 0, last: 0});
    expect((await send({type: "LINKPEEK_HISTORY_CLEAR"})).value).toEqual({ok: true});
    expect(store.historyMeta).toBeUndefined();
  });

  it("fingerprint pictures for pages, null where a picture cannot be read", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => new Response(new Uint8Array([1]), {headers: url.includes("plain") ? {} : {"content-type": "image/png"}})));
    vi.stubGlobal("createImageBitmap", vi.fn(async () => ({close() {}})));
    vi.stubGlobal("OffscreenCanvas", class {
      getContext() {
        return {drawImage() {}, getImageData: () => ({data: new Uint8ClampedArray(288)})};
      }
    });
    expect((await send({type: "LINKPEEK_FINGERPRINT", urls: ["https://cdn.test/a.png", "https://cdn.test/plain"]})).value).toEqual({prints: ["0000000000000000", null]});
  });
});
