import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import type {ScanResult} from "../../src/shared/media";
import {SETTINGS_VERSION} from "../../src/shared/settings";

const viewers = vi.hoisted(() => [] as any[]);
vi.mock("../../src/ui/viewer", () => ({
  Viewer: class {
    host = document.createElement("div");
    isOpen = false;
    pinned = false;
    help = false;
    result?: ScanResult;
    index = 0;
    onDismiss?: (explicit: boolean) => void;
    onPosition?: (url: string, index: number) => void;
    restoreViewerState = vi.fn();
    openLoading = vi.fn(() => {
      this.isOpen = true;
    });
    show = vi.fn((result: ScanResult) => {
      this.result = result;
      this.index = Math.min(this.index, Math.max(0, result.items.length - 1));
    });
    error = vi.fn();
    scheduleClose = vi.fn();
    cancelClose = vi.fn();
    containsPoint = vi.fn(() => false);
    showHoverRing = vi.fn();
    hideHoverRing = vi.fn();
    key = vi.fn(() => false);
    budget: () => unknown;
    close = vi.fn((force = false) => {
      if (!this.isOpen || (this.pinned && !force)) return;
      this.isOpen = false;
      this.onDismiss?.(force);
    });
    constructor(options: {budget: () => unknown}) {
      this.budget = options.budget;
      viewers.push(this);
    }
  }
}));

import {PreviewController} from "../../src/content/controller";

type Message = {type: string; url?: string; token?: string; kind?: string; deep?: boolean};
let store: Record<string, unknown>, messages: Message[], respond: (msg: Message) => unknown;
let storageListeners: Array<(changes: Record<string, unknown>, area: string) => void>, runtimeListeners: Array<(msg: unknown, sender: unknown, send: (v: unknown) => void) => unknown>;
let mutations: MutationCallback, frames: Array<() => void>, idle: Array<() => void>, observed: Element[], runtime: {id?: string};
let controller: PreviewController, viewer: any;

const scan = (url: string, items = 1, patch: Partial<ScanResult> = {}): ScanResult => ({
  url, kind: "generic", complete: true, items: Array.from({length: items}, (_, i) => ({id: `${url}#${i}`, type: "image" as const, originalUrl: `${url}/${i}.jpg`, previewUrl: `${url}/p${i}.jpg`, sourceUrl: url, score: 1})), ...patch
});
const flush = () => vi.advanceTimersByTimeAsync(0);

function link(id: string, href = `https://dest.test/${id}`, top = 10) {
  const a = document.createElement("a");
  a.id = id;
  a.href = href;
  a.textContent = id;
  a.getBoundingClientRect = () => ({left: 10, top, right: 60, bottom: top + 10, width: 50, height: 10, x: 10, y: top, toJSON: () => ({})});
  document.body.append(a);
  return a;
}
const pointer = (type: string, target: Element, x = 20, y = 15, init: MouseEventInit = {}) => target.dispatchEvent(new MouseEvent(type, {bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, ...init}));
const key = (k: string, init: KeyboardEventInit = {}, target: EventTarget = document.body) => {
  const event = new KeyboardEvent("keydown", {key: k, bubbles: true, cancelable: true, composed: true, ...init});
  target.dispatchEvent(event);
  return event;
};
const scans = () => messages.filter(msg => msg.type === "LINKPEEK_SCAN");
const setSettings = async (settings: Record<string, unknown>) => {
  store.settings = settings;
  for (const listener of storageListeners) listener({settings: {newValue: settings}}, "local");
  await flush();
};

async function boot(settings: Record<string, unknown> = {}) {
  store = {settings: {hoverDelay: 100, closeDelay: 50, ...settings}, settingsVersion: SETTINGS_VERSION, viewerState: {view: "grid"}};
  controller = new PreviewController();
  viewer = viewers.at(-1);
  await controller.boot();
  return controller;
}

beforeEach(() => {
  vi.useFakeTimers({toFake: ["setTimeout", "clearTimeout", "performance", "Date"]});
  document.body.innerHTML = "";
  viewers.length = 0;
  messages = [];
  storageListeners = [];
  runtimeListeners = [];
  frames = [];
  idle = [];
  observed = [];
  runtime = {id: "linkpeek"};
  respond = msg => msg.type === "LINKPEEK_SCAN" ? scan(msg.url!) : msg.type === "LINKPEEK_PREFETCH" ? scan(msg.url!, 2) : {ok: true};
  history.replaceState(null, "", "/page");
  vi.stubGlobal("chrome", {
    storage: {
      local: {get: vi.fn(async (keys: string | string[]) => Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map(k => [k, store[k]]))), set: vi.fn(async (v: Record<string, unknown>) => Object.assign(store, v))},
      onChanged: {addListener: vi.fn(listener => storageListeners.push(listener)), removeListener: vi.fn(listener => storageListeners.splice(storageListeners.indexOf(listener), 1))}
    },
    runtime: Object.assign(runtime, {
      onMessage: {addListener: vi.fn(listener => runtimeListeners.push(listener)), removeListener: vi.fn(listener => runtimeListeners.splice(runtimeListeners.indexOf(listener), 1))},
      sendMessage: vi.fn(async (msg: Message) => {
        messages.push(msg);
        return respond(msg);
      })
    })
  });
  vi.stubGlobal("MutationObserver", class {
    constructor(callback: MutationCallback) {
      mutations = callback;
    }
    observe() {}
    disconnect() {}
  });
  vi.stubGlobal("IntersectionObserver", class {
    observe(el: Element) {
      observed.push(el);
    }
  });
  vi.stubGlobal("requestAnimationFrame", vi.fn((callback: () => void) => frames.push(callback)));
  vi.stubGlobal("requestIdleCallback", vi.fn((callback: () => void) => idle.push(callback)));
  vi.stubGlobal("cancelIdleCallback", vi.fn());
});
afterEach(() => {
  // Old controllers notice the extension is gone and detach, so they cannot react in the next test.
  runtime.id = undefined;
  document.dispatchEvent(new Event("visibilitychange"));
  vi.useRealTimers();
  vi.unstubAllGlobals();
  delete (document as Partial<Document>).elementFromPoint;
});

describe("starting up", () => {
  it("restores the viewer, wires its callbacks and starts tracking links", async () => {
    const a = link("a");
    await boot();
    expect(viewer.restoreViewerState).toHaveBeenCalledWith({view: "grid"});
    expect(viewer.onDismiss).toBeTypeOf("function");
    expect(observed).toEqual([a]);
    expect(controller.status()).toMatchObject({enabled: true, mode: "auto", prepared: 0, headroom: 1});
    expect(viewer.budget()).toMatchObject({speculative: true});
    const intentHost = (controller.intent as unknown as {host: {isPrepared: (url: string) => boolean; isScanning: () => boolean}}).host;
    expect(intentHost.isPrepared(a.href)).toBe(false);
    expect(intentHost.isScanning()).toBe(false);
    const prefetchHost = (controller.prefetcher as unknown as {host: {pointer: () => {x: number; y: number}}}).host;
    expect(prefetchHost.pointer()).toMatchObject({x: innerWidth / 2, y: innerHeight / 2});
  });

  it("answers the popup's status question", async () => {
    await boot();
    const send = vi.fn();
    expect(runtimeListeners[0]({type: "LINKPEEK_STATUS"}, {}, send)).toBe(false);
    expect(send).toHaveBeenCalledWith(expect.objectContaining({tier: expect.any(String)}));
    expect(runtimeListeners[0](undefined, {}, send)).toBe(false);
  });
});

describe("hover previews", () => {
  it("opens a preview after the hover delay and shows the scan", async () => {
    await boot();
    const a = link("a");
    pointer("pointerover", a);
    await vi.advanceTimersByTimeAsync(100);
    expect(viewer.openLoading).toHaveBeenCalledWith(20, 15, expect.objectContaining({hoverDelay: 100}), "a", undefined);
    expect(scans()).toEqual([expect.objectContaining({url: a.href, kind: "generic"})]);
    expect(viewer.show).toHaveBeenLastCalledWith(scan(a.href));
    expect(controller.prefetcher.isPrepared(a.href)).toBe(true);
  });

  it("shows a prepared gallery in the first frame, then the full scan", async () => {
    await boot();
    const a = link("a");
    pointer("pointerover", a);
    await flush();
    expect(messages[0]).toMatchObject({type: "LINKPEEK_PREFETCH", deep: false});
    let finish!: (value: ScanResult) => void;
    respond = msg => msg.type === "LINKPEEK_SCAN" ? new Promise(resolve => finish = resolve) : scan(msg.url!, 2);
    await vi.advanceTimersByTimeAsync(100);
    expect(viewer.show).toHaveBeenCalledWith(scan(a.href, 2));
    finish(scan(a.href, 5));
    await flush();
    expect(viewer.show).toHaveBeenLastCalledWith(scan(a.href, 5));
  });

  it("schedules a close when the pointer leaves the link, unless pinned or in click mode", async () => {
    await boot();
    const a = link("a"), away = link("away", "https://dest.test/logout");
    pointer("pointerover", a);
    await vi.advanceTimersByTimeAsync(100);
    pointer("pointerout", a, 20, 15, {relatedTarget: away});
    expect(viewer.scheduleClose).toHaveBeenCalledWith(50);
    viewer.pinned = true;
    pointer("pointerover", a);
    pointer("pointerout", a, 20, 15, {relatedTarget: away});
    expect(viewer.scheduleClose).toHaveBeenCalledTimes(1);
  });

  it("uses the page's own site rule: a paused site gets no previews", async () => {
    await boot({siteProfiles: {localhost: {enabled: false}}});
    pointer("pointerover", link("a"));
    await vi.advanceTimersByTimeAsync(500);
    expect(viewer.openLoading).not.toHaveBeenCalled();
    expect(controller.status().enabled).toBe(false);
  });

  it("previews only links that match the keywords and are safe and supported", async () => {
    await boot({activationKeywords: ["gallery"], includeVideo: false});
    const anchors = [link("a"), link("gallery-video", "https://dest.test/gallery/clip.mp4"), link("gallery-logout", "https://dest.test/gallery/logout"), link("gallery-ok", "https://dest.test/gallery/ok")];
    expect(anchors.map(anchor => Boolean(controller.settingsFor(anchor)))).toEqual([false, false, false, true]);
  });

  it("follows settings changes and starts preparation over", async () => {
    await boot();
    controller.prefetcher.remember("https://dest.test/a", scan("https://dest.test/a"));
    await setSettings({enabled: false});
    expect(controller.pageSettings().enabled).toBe(false);
    expect(controller.prefetcher.preparedCount).toBe(0);
    for (const listener of storageListeners) {
      listener({favorites: {}}, "local");
      listener({settings: {}}, "sync");
    }
  });
});

describe("scans", () => {
  it("report errors, ignore cancellations and stale answers", async () => {
    await boot();
    const a = link("a"), b = link("b"), c = link("c"), d = link("d");
    respond = msg => msg.type === "LINKPEEK_SCAN" ? {error: "HTTP 404"} : null;
    await controller.activate(a, 0, 0);
    expect(viewer.error).toHaveBeenLastCalledWith("HTTP 404");
    respond = msg => msg.type === "LINKPEEK_SCAN" ? {cancelled: true} : null;
    await controller.activate(b, 0, 0);
    respond = msg => msg.type === "LINKPEEK_SCAN" ? undefined : null;
    await controller.activate(c, 0, 0);
    expect(viewer.error).toHaveBeenLastCalledWith(expect.stringContaining("did not answer"));
    respond = () => {
      throw "plain failure";
    };
    await controller.activate(d, 0, 0);
    expect(viewer.error).toHaveBeenLastCalledWith("plain failure");
    expect(viewer.error).toHaveBeenCalledTimes(3);
  });

  it("drop an answer that arrives after a newer preview started", async () => {
    await boot();
    let finish!: (value: ScanResult) => void;
    respond = msg => msg.type === "LINKPEEK_SCAN" && msg.url!.endsWith("/a") ? new Promise(resolve => finish = resolve) : scan(msg.url!);
    const first = controller.activate(link("a"), 0, 0);
    await controller.activate(link("b"), 0, 0);
    finish(scan("https://dest.test/a"));
    await first;
    expect(viewer.show).not.toHaveBeenCalledWith(scan("https://dest.test/a"));
    let fail!: (error: Error) => void;
    respond = msg => msg.type === "LINKPEEK_SCAN" && msg.url!.endsWith("/c") ? new Promise((_, reject) => fail = reject) : scan(msg.url!);
    const failing = controller.activate(link("c"), 0, 0);
    await controller.activate(link("d"), 0, 0);
    fail(new Error("late"));
    await failing;
    expect(viewer.error).not.toHaveBeenCalled();
  });

  it("ignore activating the open link again, and links that may not be previewed", async () => {
    await boot();
    const a = link("a");
    await controller.activate(a, 0, 0);
    await controller.activate(a, 0, 0);
    await controller.activate(link("out", "https://dest.test/logout"), 0, 0);
    expect(scans()).toHaveLength(1);
  });

  it("show progress for the open scan only", async () => {
    await boot();
    respond = msg => msg.type === "LINKPEEK_SCAN" ? new Promise(() => undefined) : null;
    const a = link("a");
    void controller.activate(a, 0, 0);
    await flush();
    const {token, url} = scans()[0];
    const listener = runtimeListeners[0];
    listener({type: "LINKPEEK_SCAN_PROGRESS", token: "other", url, result: scan(url!)}, {}, vi.fn());
    listener({type: "LINKPEEK_SCAN_PROGRESS", token, url, result: undefined}, {}, vi.fn());
    expect(viewer.show).not.toHaveBeenCalled();
    listener({type: "LINKPEEK_SCAN_PROGRESS", token, url, result: scan(url!, 3, {complete: false})}, {}, vi.fn());
    expect(viewer.show).toHaveBeenCalledWith(scan(url!, 3, {complete: false}));
    expect(controller.prefetcher.isPrepared(url!)).toBe(true);
  });

  it("keep running briefly after closing, cancel when replaced, and follow the configured policy", async () => {
    await boot();
    respond = msg => msg.type === "LINKPEEK_SCAN" ? new Promise(() => undefined) : {ok: true};
    void controller.activate(link("a"), 0, 0);
    await flush();
    viewer.close();
    expect(messages.some(msg => msg.type === "LINKPEEK_CANCEL_SCAN")).toBe(false);
    await vi.advanceTimersByTimeAsync(1000);
    expect(messages.filter(msg => msg.type === "LINKPEEK_CANCEL_SCAN")).toHaveLength(1);
    void controller.activate(link("b"), 0, 0);
    await flush();
    void controller.activate(link("c"), 0, 0);
    await flush();
    expect(messages.filter(msg => msg.type === "LINKPEEK_CANCEL_SCAN").map(msg => msg.url)).toEqual(["https://dest.test/a", "https://dest.test/b"]);
    await setSettings({continueAfterClose: "always"});
    void controller.activate(link("d"), 0, 0);
    await flush();
    viewer.close(true);
    await setSettings({continueAfterClose: "no"});
    void controller.activate(link("e"), 0, 0);
    await flush();
    viewer.close(true);
    expect(messages.filter(msg => msg.type === "LINKPEEK_CANCEL_SCAN").map(msg => msg.url)).toEqual(["https://dest.test/a", "https://dest.test/b", "https://dest.test/c", "https://dest.test/e"]);
  });

  it("remember where each gallery was left, when resuming is on", async () => {
    await boot();
    const a = link("a");
    viewer.onPosition(a.href, 4);
    for (let i = 0; i < 100; i++) viewer.onPosition(`https://dest.test/x${i}`, 1);
    viewer.onPosition("https://dest.test/x99", 2);
    await controller.activate(a, 0, 0);
    expect(viewer.openLoading).toHaveBeenLastCalledWith(0, 0, expect.anything(), "a", undefined);
    viewer.close(true);
    const b = link("x99", "https://dest.test/x99");
    await controller.activate(b, 0, 0);
    expect(viewer.openLoading).toHaveBeenLastCalledWith(0, 0, expect.anything(), "x99", 2);
    viewer.close(true);
    await setSettings({resumePosition: false});
    await controller.activate(b, 0, 0);
    expect(viewer.openLoading).toHaveBeenLastCalledWith(0, 0, expect.anything(), "x99", undefined);
    const blank = link("");
    blank.textContent = "  ";
    viewer.close(true);
    await controller.activate(blank, 0, 0);
    expect(viewer.openLoading).toHaveBeenLastCalledWith(0, 0, expect.anything(), "Scanning link…", undefined);
  });
});

describe("closing", () => {
  it("closes on a click elsewhere, but not inside the preview, while pinned, or when turned off", async () => {
    await boot();
    await controller.activate(link("a"), 0, 0);
    viewer.host.append(document.createElement("span"));
    document.body.append(viewer.host);
    pointer("pointerdown", viewer.host.firstElementChild!);
    viewer.pinned = true;
    pointer("pointerdown", document.body);
    expect(viewer.isOpen).toBe(true);
    viewer.pinned = false;
    pointer("pointerdown", document.body);
    expect(viewer.isOpen).toBe(false);
    pointer("pointerdown", document.body);
    await setSettings({closeOnOutsideClick: false});
    await controller.activate(link("b"), 0, 0);
    pointer("pointerdown", document.body);
    expect(viewer.isOpen).toBe(true);
  });

  it("does not reopen a link closed on purpose while the pointer rests on it", async () => {
    await boot();
    const a = link("a");
    document.elementFromPoint = () => a;
    pointer("pointerover", a);
    await vi.advanceTimersByTimeAsync(100);
    viewer.close(true);
    pointer("pointermove", a, 25, 15);
    await vi.advanceTimersByTimeAsync(1000);
    expect(viewer.openLoading).toHaveBeenCalledTimes(1);
  });
});

describe("click mode", () => {
  it("opens on a plain click, toggles the open link and leaves modified clicks alone", async () => {
    await boot({activationMode: "click"});
    const a = link("a"), b = link("b");
    const plain = new MouseEvent("click", {bubbles: true, cancelable: true, clientX: 5, clientY: 6});
    a.dispatchEvent(plain);
    await flush();
    expect(plain.defaultPrevented).toBe(true);
    expect(viewer.openLoading).toHaveBeenCalledWith(5, 6, expect.anything(), "a", undefined);
    pointer("pointerdown", a);
    expect(viewer.isOpen).toBe(true);
    pointer("click", a);
    expect(viewer.isOpen).toBe(false);
    for (const init of [{ctrlKey: true}, {metaKey: true}, {shiftKey: true}, {altKey: true}, {button: 1}]) pointer("click", b, 0, 0, init);
    pointer("click", document.body);
    pointer("click", link("out", "https://dest.test/logout"));
    pointer("pointerout", a, 0, 0, {relatedTarget: document.body});
    expect(viewer.openLoading).toHaveBeenCalledTimes(1);
    expect(viewer.scheduleClose).not.toHaveBeenCalled();
  });

  it("is ignored in hover mode", async () => {
    await boot();
    const event = new MouseEvent("click", {bubbles: true, cancelable: true});
    link("a").dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
  });
});

describe("keyboard", () => {
  it("lets the open preview handle its keys first", async () => {
    await boot();
    viewer.key.mockReturnValueOnce(true);
    expect(key("g").defaultPrevented).toBe(true);
  });

  it("uses the fetched child page's own link order and skips empty links in both directions", async () => {
    await boot();
    const root = link("root", "https://dest.test/root");
    const recursive = scan(root.href, 1, {
      items: [{
        id: "child-media", type: "image", originalUrl: "https://dest.test/child/photo.jpg",
        previewUrl: "https://dest.test/child/photo-small.jpg", sourceUrl: "https://dest.test/child", score: 1
      }],
      linkContexts: [
        {sourceUrl: root.href, links: ["https://dest.test/child"]},
        {sourceUrl: "https://dest.test/child", links: ["https://dest.test/child/a", "https://dest.test/child/b", "https://dest.test/child/c", "https://dest.test/child/d"]}
      ]
    });
    const media = new Set(["https://dest.test/child/b", "https://dest.test/child/d"]);
    respond = msg => {
      if (msg.type === "LINKPEEK_SCAN" && msg.url === root.href) return recursive;
      if (msg.type === "LINKPEEK_SCAN" || msg.type === "LINKPEEK_PREFETCH") return scan(msg.url!, media.has(msg.url!) ? 1 : 0);
      return {ok: true};
    };
    await controller.activate(root, 30, 40);
    expect(viewer.result).toEqual(recursive);
    await flush();

    expect(key("n").defaultPrevented).toBe(true);
    await flush();
    expect(viewer.result!.url).toBe("https://dest.test/child/b");
    expect(scans().some(msg => msg.url === "https://dest.test/child/a")).toBe(true);
    // The panel stays where the recursive gallery opened.
    expect(viewer.openLoading).toHaveBeenLastCalledWith(30, 40, expect.anything(), "b", undefined);

    expect(key("n").defaultPrevented).toBe(true);
    await flush();
    expect(viewer.result!.url).toBe("https://dest.test/child/d");
    expect(key("N", {shiftKey: true}).defaultPrevented).toBe(true);
    await flush();
    expect(viewer.result!.url).toBe("https://dest.test/child/b");
  });

  it("starts a linked page's list from its end with Shift+N, and leaves single or unusable lists alone", async () => {
    await boot();
    const root = link("root", "https://dest.test/root");
    const child = (sourceUrl: string, links: string[], items = 1): ScanResult => scan(root.href, items, {
      items: Array.from({length: items}, (_, i) => ({id: `m${i}`, type: "image" as const, originalUrl: `${sourceUrl}/${i}.jpg`, previewUrl: `${sourceUrl}/${i}.jpg`, sourceUrl: i ? root.href : sourceUrl, score: 1})),
      linkContexts: [{sourceUrl: "https://dest.test/child", links}]
    });
    const list = ["https://dest.test/child/a", "https://dest.test/child/b"];
    respond = msg => msg.url === root.href ? child("https://dest.test/child", list) : scan(msg.url!);
    await controller.activate(root, 30, 40);
    key("N", {shiftKey: true});
    await flush();
    expect(viewer.result!.url).toBe(list[1]);

    // A one-link list, viewed from that link: N moves on to the prepared links on the page instead.
    viewer.close(true);
    respond = msg => msg.url === root.href ? child("https://dest.test/child", ["https://dest.test/child/a"]) : scan(msg.url!);
    await controller.activate(root, 30, 40);
    key("n");
    await flush();
    expect(viewer.result!.url).toBe("https://dest.test/child/a");
    key("n");
    await flush();
    expect(viewer.result!.url).toBe(root.href);

    // Media from the page itself, from a page with no list, or a list of blocked links: no list.
    for (const [source, links, index] of [[root.href, list, 0], ["https://dest.test/other", list, 0], ["https://dest.test/child", ["https://dest.test/logout"], 0]] as const) {
      viewer.close(true);
      respond = msg => msg.url === root.href ? child(source, [...links], 2) : scan(msg.url!);
      await controller.activate(root, 30, 40);
      viewer.index = index;
      const count = scans().length;
      key("n");
      await flush();
      expect(scans()).toHaveLength(count);
    }
  });

  it("opens the inspector only after a complete chord and leaves Cut untouched", async () => {
    await boot();
    expect(key("x").defaultPrevented).toBe(false);
    expect(controller.inspector.isOpen).toBe(false);
    expect(key("x", {ctrlKey: true}).defaultPrevented).toBe(false);
    expect(key("x").defaultPrevented).toBe(true);
    expect(controller.inspector.isOpen).toBe(true);
    expect(key("Escape").defaultPrevented).toBe(true);
    key("x", {ctrlKey: true});
    await vi.advanceTimersByTimeAsync(1000);
    expect(key("x").defaultPrevented).toBe(false);
    key("x", {ctrlKey: true});key("z");
    expect(key("x").defaultPrevented).toBe(false);
  });

  it("moves through media-bearing page links in order, skipping empties and wrapping", async () => {
    await boot();
    const [a, b, c, d] = [link("a"), link("b", undefined, 2000), link("c"), link("d")];
    link("b-copy", b.href);
    link("blocked", "https://dest.test/logout");
    b.scrollIntoView = vi.fn();
    const media = new Set([b.href, d.href]);
    respond = msg => msg.type === "LINKPEEK_SCAN" ? scan(msg.url!, media.has(msg.url!) ? 1 : 0) : scan(msg.url!, media.has(msg.url!) ? 1 : 0);

    expect(key("n").defaultPrevented).toBe(true);
    await flush();
    expect(viewer.result!.url).toBe(b.href);
    expect(scans().map(msg => msg.url)).toEqual([a.href, b.href]);
    expect(b.scrollIntoView).toHaveBeenCalledWith({block: "nearest", inline: "nearest"});

    key("n");
    await flush();
    expect(viewer.result!.url).toBe(d.href);
    expect(scans().map(msg => msg.url)).toContain(c.href);

    key("N", {shiftKey: true});
    await flush();
    expect(viewer.result!.url).toBe(b.href);

    viewer.close(true);
    controller.intent.setCurrent(null);
    key("N", {shiftKey: true});
    await flush();
    expect(viewer.result!.url).toBe(d.href);

    viewer.close(true);
    controller.intent.setCurrent(a);
    expect(controller.openAdjacentPrepared(1)).toBe(true);
    await flush();
    expect(viewer.result!.url).toBe(b.href);
    expect(key("x").defaultPrevented).toBe(false);
  });

  it("skips missing and thrown probe answers, then accepts direct media", async () => {
    await boot();
    const missing = link("missing"), broken = link("broken"), direct = link("direct", "https://dest.test/direct.gif");
    respond = msg => {
      if (msg.type !== "LINKPEEK_SCAN") return scan(msg.url!);
      if (msg.url === missing.href) return undefined;
      if (msg.url === broken.href) throw new Error("network exploded");
      if (msg.url === direct.href) return {...scan(direct.href), kind: "direct-image"};
      return scan(msg.url!);
    };
    expect(key("n").defaultPrevented).toBe(true);
    await flush();
    expect(scans().map(msg => msg.url)).toEqual([missing.href, broken.href, direct.href]);
    expect(viewer.result).toMatchObject({url: direct.href, kind: "direct-image"});
  });

  it("chooses the last eligible recursive child for Shift+N even without link-context metadata", async () => {
    await boot();
    const candidate = link("candidate");
    const blocked = "https://dest.test/logout", first = "https://dest.test/child/first", last = "https://dest.test/child/last";
    const recursive: ScanResult = {
      url: candidate.href, kind: "generic", complete: true,
      items: [
        {id: "blocked", type: "image", originalUrl: blocked + "/m.jpg", previewUrl: blocked + "/m.jpg", sourceUrl: blocked, score: 1},
        {id: "first", type: "image", originalUrl: first + "/m.jpg", previewUrl: first + "/m.jpg", sourceUrl: first, score: 1},
        {id: "last", type: "image", originalUrl: last + "/m.jpg", previewUrl: last + "/m.jpg", sourceUrl: last, score: 1}
      ]
    };
    respond = msg => msg.type === "LINKPEEK_SCAN" && msg.url === candidate.href ? recursive : scan(msg.url!);
    expect(key("N", {shiftKey: true}).defaultPrevented).toBe(true);
    await flush();
    expect(viewer.result!.url).toBe(last);
    expect(viewer.result!.items.map((item: any) => item.id)).toEqual(["last"]);
    viewer.close(true);
    controller.prefetcher.reset();
    recursive.linkContexts = [];
    expect(key("N", {shiftKey: true}).defaultPrevented).toBe(true);
    await flush();
    expect(viewer.result!.url).toBe(last);
  });

  it("keeps a dismissed preview closed when its cancelled navigation probe finishes", async () => {
    await boot();
    const current = link("current"), next = link("next");
    await controller.activate(current, 20, 30);
    let finish!: (result: ScanResult) => void;
    respond = msg => msg.type === "LINKPEEK_SCAN" ? new Promise(resolve => finish = resolve) : {ok: true};
    key("n");
    await flush();
    viewer.close(true);
    expect(messages.some(msg => msg.type === "LINKPEEK_CANCEL_SCAN" && msg.url === next.href)).toBe(true);
    finish(scan(next.href));
    await flush();
    expect(viewer.isOpen).toBe(false);
    expect(viewer.result!.url).toBe(current.href);
  });

  it("cancels an active preview scan before probing N and completes an incomplete linked candidate", async () => {
    await boot();
    const root = link("root"), child = "https://dest.test/child", next = child + "/next";
    const rootResult = scan(root.href, 1, {
      items: [{id: "child-media", type: "image", originalUrl: child + "/m.jpg", previewUrl: child + "/m.jpg", sourceUrl: child, score: 1}],
      linkContexts: [{sourceUrl: root.href, links: [child]}, {sourceUrl: child, links: [next]}]
    });
    const partial = scan(next, 1, {complete: false});
    const complete = scan(next, 2);
    let nextScans = 0;
    respond = msg => {
      if (msg.type !== "LINKPEEK_SCAN") return {ok: true};
      if (msg.url === root.href) return new Promise(() => undefined);
      if (msg.url === next) return ++nextScans === 1 ? partial : complete;
      return scan(msg.url!);
    };
    void controller.activate(root, 20, 30);
    await flush();
    viewer.show(rootResult);
    expect(key("n").defaultPrevented).toBe(true);
    await flush();
    expect(messages.some(msg => msg.type === "LINKPEEK_CANCEL_SCAN" && msg.url === root.href)).toBe(true);
    expect(scans().filter(msg => msg.url === next)).toHaveLength(2);
    expect(viewer.result).toEqual(complete);
  });

  it("handles malformed URLs and missing linked-context metadata without throwing", async () => {
    await boot();
    const internal = controller as unknown as {
      normalizeUrl: (url: string) => string;
      linkedContextForCurrent: () => unknown;
    };
    expect(internal.normalizeUrl("http://[bad")).toBe("http://[bad");
    viewer.result = undefined;
    expect(internal.linkedContextForCurrent()).toBeUndefined();

    // A completed empty gallery can still carry the page's link context.
    // Keyboard navigation must cope with there being no current media source.
    viewer.result = scan("https://dest.test/empty", 0, {
      linkContexts: [{sourceUrl: "https://dest.test/empty", links: ["https://dest.test/next"]}]
    });
    viewer.index = 0;
    expect(internal.linkedContextForCurrent()).toBeUndefined();

    const root = "https://dest.test/root", child = "https://dest.test/child";
    viewer.result = scan(root, 1, {
      items: [{id: "m", type: "image", originalUrl: child + "/m.jpg", previewUrl: child + "/m.jpg", sourceUrl: child, score: 1}],
      linkContexts: undefined
    });
    viewer.index = 0;
    expect(internal.linkedContextForCurrent()).toBeUndefined();
  });

  it("does not clear a newer navigation probe when an older probe finishes", async () => {
    await boot();
    let finish!: (value: ScanResult) => void;
    respond = msg => msg.type === "LINKPEEK_SCAN" ? new Promise(resolve => finish = resolve) : scan(msg.url!);
    const internal = controller as unknown as {
      linkNavigationId: number;
      navigationProbe?: {url: string; token: string};
      scanForNavigation: (url: string, id: number) => Promise<ScanResult | undefined>;
    };
    const pending = internal.scanForNavigation("https://dest.test/slow", internal.linkNavigationId);
    await flush();
    internal.navigationProbe = {url: "https://dest.test/newer", token: "newer-token"};
    finish(scan("https://dest.test/slow"));
    await pending;
    expect(internal.navigationProbe).toEqual({url: "https://dest.test/newer", token: "newer-token"});
  });

  it("opens an incomplete prepared result immediately but still finishes its full scan", async () => {
    await boot();
    const a = link("partial");
    const partial = scan(a.href, 1, {complete: false});
    const complete = scan(a.href, 3);
    controller.prefetcher.remember(a.href, partial);
    respond = msg => msg.type === "LINKPEEK_SCAN" ? complete : scan(msg.url!);

    expect(key("n").defaultPrevented).toBe(true);
    await flush();
    expect(scans().map(msg => msg.url)).toEqual([a.href]);
    expect(viewer.show).toHaveBeenCalledWith(partial);
    expect(viewer.show).toHaveBeenLastCalledWith(complete);
  });

  it("uses a recursive child with media only when it is new to the current page", async () => {
    await boot();
    const candidate = link("candidate"), existing = link("existing", "https://dest.test/existing"), fallback = link("fallback");
    const fresh = "https://dest.test/child/fresh", freshNext = "https://dest.test/child/fresh/next";
    const recursive = scan(candidate.href, 2, {
      items: [
        {id: "existing-media", type: "image", originalUrl: existing.href + "/x.jpg", previewUrl: existing.href + "/x.jpg", sourceUrl: existing.href, score: 1},
        {id: "fresh-media", type: "image", originalUrl: fresh + "/x.jpg", previewUrl: fresh + "/x.jpg", sourceUrl: fresh, score: 1}
      ],
      linkContexts: [
        {sourceUrl: candidate.href, links: [existing.href, fresh]},
        {sourceUrl: existing.href, links: []},
        {sourceUrl: fresh, links: [freshNext]}
      ]
    });
    respond = msg => {
      if (msg.type !== "LINKPEEK_SCAN") return scan(msg.url!);
      if (msg.url === candidate.href) return recursive;
      if (msg.url === fallback.href) return scan(fallback.href);
      return scan(msg.url!);
    };

    expect(key("n").defaultPrevented).toBe(true);
    await flush();
    expect(viewer.result!.url).toBe(fresh);
    expect(viewer.result!.items.map((item: any) => item.sourceUrl)).toEqual([fresh]);
    expect(viewer.openLoading).toHaveBeenLastCalledWith(innerWidth / 2, innerHeight / 2, expect.anything(), "fresh", undefined);

    // The recursive child's own list becomes the active N context.
    key("n");
    await flush();
    expect(viewer.result!.url).toBe(freshNext);
  });

  it("rejects recursive media that points back to current-page links and keeps searching", async () => {
    await boot();
    const first = link("first"), existing = link("existing", "https://dest.test/existing"), second = link("second");
    const recursiveOnlyExisting = scan(first.href, 1, {
      items: [{id: "m", type: "image", originalUrl: existing.href + "/m.jpg", previewUrl: existing.href + "/m.jpg", sourceUrl: existing.href, score: 1}],
      linkContexts: [{sourceUrl: first.href, links: [existing.href]}, {sourceUrl: existing.href, links: []}]
    });
    respond = msg => msg.type === "LINKPEEK_SCAN"
      ? (msg.url === first.href ? recursiveOnlyExisting : msg.url === existing.href ? scan(existing.href, 0) : scan(msg.url!))
      : scan(msg.url!);

    key("n");
    await flush();
    expect(viewer.result!.url).toBe(second.href);
    expect(scans().map(msg => msg.url)).toEqual([first.href, existing.href, second.href]);
  });

  it("inside a child-page list, recursive fallback never bounces to another link from that same list", async () => {
    await boot();
    const root = link("root"), parent = "https://dest.test/child";
    const list = [parent + "/a", parent + "/b"], deeper = parent + "/a/deeper";
    const rootResult = scan(root.href, 1, {
      items: [{id: "parent-media", type: "image", originalUrl: parent + "/m.jpg", previewUrl: parent + "/m.jpg", sourceUrl: parent, score: 1}],
      linkContexts: [{sourceUrl: root.href, links: [parent]}, {sourceUrl: parent, links: list}]
    });
    const aRecursive = scan(list[0], 2, {
      items: [
        {id: "bounce", type: "image", originalUrl: list[1] + "/m.jpg", previewUrl: list[1] + "/m.jpg", sourceUrl: list[1], score: 1},
        {id: "deep", type: "image", originalUrl: deeper + "/m.jpg", previewUrl: deeper + "/m.jpg", sourceUrl: deeper, score: 1}
      ],
      linkContexts: [
        {sourceUrl: list[0], links: [list[1], deeper]},
        {sourceUrl: list[1], links: []},
        {sourceUrl: deeper, links: []}
      ]
    });
    respond = msg => msg.type === "LINKPEEK_SCAN" && msg.url === root.href ? rootResult
      : msg.type === "LINKPEEK_SCAN" && msg.url === list[0] ? aRecursive
      : scan(msg.url!, 0);

    await controller.activate(root, 20, 20);
    key("n");
    await flush();
    expect(viewer.result!.url).toBe(deeper);
    expect(viewer.result!.items.map((item: any) => item.id)).toEqual(["deep"]);
  });

  it("ignores stale N probes when another navigation command overtakes them", async () => {
    await boot();
    const [a, b, c] = [link("a"), link("b"), link("c")];
    let finishA!: (value: ScanResult) => void;
    respond = msg => {
      if (msg.type !== "LINKPEEK_SCAN") return scan(msg.url!);
      if (msg.url === a.href) return new Promise(resolve => finishA = resolve);
      return scan(msg.url!);
    };
    key("n");
    await flush();
    key("n");
    await flush();
    expect(viewer.result!.url).toBe(b.href);
    finishA(scan(a.href));
    await flush();
    expect(viewer.result!.url).toBe(b.href);
    expect(messages.some(msg => msg.type === "LINKPEEK_CANCEL_SCAN" && msg.url === a.href)).toBe(true);
    expect(c.href).not.toBe(b.href);
  });

  it("leaves the current gallery in place when every candidate is empty, cancelled or failed", async () => {
    await boot();
    const current = link("current"), [a, b, c] = [link("a"), link("b"), link("c")];
    await controller.activate(current, 0, 0);
    const before = viewer.result;
    respond = msg => {
      if (msg.type !== "LINKPEEK_SCAN") return scan(msg.url!);
      if (msg.url === a.href) return scan(a.href, 0);
      if (msg.url === b.href) return {cancelled: true};
      if (msg.url === c.href) return {error: "nope"};
      return scan(msg.url!, 0);
    };
    expect(key("n").defaultPrevented).toBe(true);
    await flush();
    expect(viewer.result).toBe(before);
  });

  it("does nothing without another prepared link", async () => {
    await boot();
    expect(key("n").defaultPrevented).toBe(false);
    const a = link("a");
    controller.prefetcher.remember(a.href, scan(a.href));
    await controller.activate(a, 0, 0);
    expect(key("n").defaultPrevented).toBe(false);
  });

  it("yields to the page and to typing, and stays quiet while help is open or LinkPeek is off", async () => {
    await boot();
    const a = link("a");
    controller.prefetcher.remember(a.href, scan(a.href));
    const input = document.createElement("input");
    document.body.append(input);
    expect(key("n", {}, input).defaultPrevented).toBe(false);
    const pageHandler = (event: Event) => event.preventDefault();
    document.body.addEventListener("keydown", pageHandler, {once: true});
    key("n");
    expect(scans()).toEqual([]);
    viewer.isOpen = true;
    viewer.help = true;
    expect(key("n").defaultPrevented).toBe(false);
    viewer.help = false;
    viewer.isOpen = false;
    await setSettings({enabled: false});
    expect(key("n").defaultPrevented).toBe(false);
    expect(key("x").defaultPrevented).toBe(false);
  });
});

describe("page activity", () => {
  it("re-checks for links when the page changes, once per frame", async () => {
    await boot();
    const a = link("a");
    mutations([{type: "childList", addedNodes: [a], target: document.body} as unknown as MutationRecord], {} as MutationObserver);
    mutations([], {} as MutationObserver);
    expect(frames).toHaveLength(1);
    document.elementFromPoint = () => a;
    frames.shift()!();
    await vi.advanceTimersByTimeAsync(100);
    expect(viewer.openLoading).toHaveBeenCalled();
    await setSettings({mutationObserver: false});
    mutations([], {} as MutationObserver);
    expect(frames).toHaveLength(0);
  });

  it("tells the hover logic about scrolling and resumes work when the tab returns", async () => {
    await boot();
    const resume = vi.spyOn(controller.warmer, "resume");
    const onScroll = vi.spyOn(controller.intent, "onScroll");
    document.dispatchEvent(new Event("scroll"));
    expect(onScroll).toHaveBeenCalled();
    Object.defineProperty(document, "hidden", {configurable: true, value: true});
    document.dispatchEvent(new Event("visibilitychange"));
    expect(resume).not.toHaveBeenCalled();
    Object.defineProperty(document, "hidden", {configurable: true, value: false});
    document.dispatchEvent(new Event("visibilitychange"));
    expect(resume).toHaveBeenCalled();
    pointer("pointermove", document.body);
  });

  it("shuts down cleanly once the extension has been updated or removed", async () => {
    await boot();
    await controller.activate(link("a"), 0, 0);
    runtime.id = undefined;
    pointer("pointerover", link("b"));
    expect(viewer.isOpen).toBe(false);
    expect(storageListeners).toEqual([]);
    expect(runtimeListeners).toEqual([]);
    key("n");
    window.dispatchEvent(new KeyboardEvent("keydown", {key: "n"}));
    expect(scans()).toHaveLength(1);
  });
});

describe("the preload inspector", () => {
  it("opens and closes from the popup, and the popup can tell", async () => {
    await boot();
    const send = vi.fn();
    runtimeListeners[0]({type: "LINKPEEK_TOGGLE_INSPECTOR"}, {}, send);
    expect(send).toHaveBeenLastCalledWith({open: true});
    expect(controller.status().inspectorOpen).toBe(true);
    runtimeListeners[0]({type: "LINKPEEK_TOGGLE_INSPECTOR"}, {}, send);
    expect(send).toHaveBeenLastCalledWith({open: false});
  });

  it("opens a page link from the inspector beside the link, and others where the last preview was", async () => {
    await boot();
    const a = link("a", undefined, 3000);
    a.scrollIntoView = vi.fn();
    controller.inspector.open();
    (controller as unknown as {openUrlFromInspector: (url: string) => void}).openUrlFromInspector(a.href);
    await flush();
    expect(a.scrollIntoView).toHaveBeenCalled();
    expect(scans().at(-1)!.url).toBe(a.href);
    viewer.close(true);
    (controller as unknown as {openUrlFromInspector: (url: string) => void}).openUrlFromInspector("https://dest.test/elsewhere/page");
    await flush();
    expect(viewer.openLoading).toHaveBeenLastCalledWith(35, 760, expect.anything(), "page", undefined);
    (controller as unknown as {openUrlFromInspector: (url: string) => void}).openUrlFromInspector("https://dest.test/logout");
    await flush();
    expect(scans()).toHaveLength(2);
  });

  it("raises priorities and opens links from the inspector's rows", async () => {
    await boot();
    const a = link("a");
    controller.prefetcher.remember(a.href, scan(a.href));
    const raise = vi.spyOn(controller.prefetcher, "setPriority");
    controller.inspector.open();
    const panel = controller.inspector.host.shadowRoot!;
    const box = panel.querySelector<HTMLInputElement>(`[data-select="${a.href}"]`)!;
    box.checked = true;
    box.dispatchEvent(new Event("change", {bubbles: true}));
    panel.querySelector<HTMLButtonElement>('[data-action="maximum"]')!.click();
    expect(raise).toHaveBeenCalledWith([a.href], "maximum");
    panel.querySelector<HTMLButtonElement>(`[data-open="${a.href}"]`)!.click();
    await flush();
    expect(scans().at(-1)!.url).toBe(a.href);
  });

  it("does not count clicks inside the inspector as clicks outside the preview", async () => {
    await boot();
    await controller.activate(link("a"), 0, 0);
    controller.inspector.open();
    pointer("pointerdown", controller.inspector.host);
    expect(viewer.isOpen).toBe(true);
  });
});

describe("switching links while a preview is open", () => {
  it("ignores links crossed on the way from the open link to the preview", async () => {
    await boot();
    const a = link("a"), b = link("b");
    const rect = {left: 0, top: 0, right: 100, bottom: 20, width: 100, height: 20, x: 0, y: 0, toJSON() {}} as DOMRect;
    a.getBoundingClientRect = () => rect;
    await controller.activate(a, 20, 15);
    viewer.containsPoint.mockImplementation((_x: number, _y: number, from?: DOMRect) => Boolean(from));
    const opened = scans().length;
    pointer("pointerover", b, 20, 15);
    await vi.advanceTimersByTimeAsync(5000);
    expect(scans()).toHaveLength(opened);
    expect(viewer.containsPoint).toHaveBeenCalledWith(20, 15, rect);
    a.remove();
    pointer("pointerout", b, 20, 15, {relatedTarget: document.body});
    pointer("pointerover", b, 500, 400);
    await vi.advanceTimersByTimeAsync(5000);
    expect(scans().at(-1)!.url).toBe(b.href);
  });
});

describe("the hover countdown", () => {
  it("shows beside the pointer while a link arms, green when it is prepared, and can be turned off", async () => {
    await boot();
    const a = link("a");
    controller.prefetcher.remember(a.href, scan(a.href));
    pointer("pointerover", a, 21, 16);
    expect(viewer.showHoverRing).toHaveBeenCalledWith(21, 16, 100, true);
    await vi.advanceTimersByTimeAsync(100);
    expect(viewer.hideHoverRing).toHaveBeenCalled();
    await setSettings({showHoverRing: false});
    viewer.close(true);
    pointer("pointerout", a, 21, 16, {relatedTarget: document.body});
    pointer("pointerover", link("b"), 40, 16);
    expect(viewer.showHoverRing).toHaveBeenCalledTimes(1);
  });
});
