import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import type {ImageWarmer} from "../../src/content/image-warmer";
import {LinkPrefetcher, type PrefetchHost} from "../../src/content/link-prefetcher";
import type {Budget} from "../../src/content/resource-governor";
import type {ScanResult} from "../../src/shared/media";
import {resolveSettings, type LinkPeekSettings} from "../../src/shared/settings";

type IOCallback = (entries: Array<{target: Element; isIntersecting: boolean}>) => void;
let ioCallback: IOCallback, observed: Element[], idle: Array<() => void>;
let pending: Array<{msg: {url: string; deep: boolean}; resolve: (value: unknown) => void; reject: (error: Error) => void}>;
let settings: LinkPeekSettings, budget: Partial<Budget>, pointer: {x: number; y: number; vx: number; vy: number};
const warmer = {warm: vi.fn()};

const scan = (url: string, items: Array<{type?: "image" | "gif" | "video"; posterUrl?: string}> = [{}]): ScanResult => ({
  url, kind: "generic", complete: true,
  items: items.map((item, i) => ({id: `${url}-${i}`, type: item.type ?? "image", originalUrl: `${url}/o${i}`, previewUrl: `${url}/p${i}`, posterUrl: item.posterUrl, sourceUrl: url, score: 1}))
});

function link(href: string, top = 0, left = 0) {
  const a = document.createElement("a");
  a.href = href;
  a.textContent = href;
  a.getBoundingClientRect = () => ({left, right: left + 40, top, bottom: top + 10, width: 40, height: 10, x: left, y: top, toJSON: () => ({})});
  document.body.append(a);
  return a;
}

const host: PrefetchHost = {
  settingsFor: anchor => anchor.href.includes("blocked") ? undefined : settings,
  pointer: () => pointer,
  budget: () => budget as Budget
};
const flush = () => new Promise(resolve => setTimeout(resolve, 0));
const runIdle = () => idle.shift()!();
const show = (...anchors: Element[]) => ioCallback(anchors.map(target => ({target, isIntersecting: true})));

beforeEach(() => {
  document.body.innerHTML = "";
  observed = [];
  idle = [];
  pending = [];
  warmer.warm.mockReset();
  settings = resolveSettings({});
  budget = {speculative: true, nearbyLinks: 2, linkConcurrency: 1, thumbsPerLink: 1, hoverThumbs: 2, hoverIdleThumbs: 3};
  pointer = {x: 0, y: 0, vx: 0, vy: 0};
  Object.defineProperty(document, "hidden", {configurable: true, value: false});
  vi.stubGlobal("IntersectionObserver", class {
    constructor(callback: IOCallback) {
      ioCallback = callback;
    }
    observe(el: Element) {
      observed.push(el);
    }
  });
  vi.stubGlobal("requestIdleCallback", vi.fn((callback: () => void) => idle.push(callback)));
  vi.stubGlobal("chrome", {runtime: {sendMessage: vi.fn((msg: {url: string; deep: boolean}) => new Promise((resolve, reject) => pending.push({msg, resolve, reject})))}});
});
afterEach(() => vi.unstubAllGlobals());

function prefetcher() {
  const instance = new LinkPrefetcher(host, warmer as unknown as ImageWarmer);
  instance.start();
  return instance;
}

describe("preparing nearby links", () => {
  it("prepares the links closest to where the pointer is heading, one request at a time", async () => {
    const far = link("https://x.test/far", 500), near = link("https://x.test/near", 100), ahead = link("https://x.test/ahead", 300);
    const p = prefetcher();
    expect(observed).toEqual([far, near, ahead]);
    pointer = {x: 0, y: 150, vx: 0, vy: 1};
    show(far, near, ahead);
    show(near);
    expect(idle).toHaveLength(1);
    runIdle();
    await flush();
    expect(pending.map(entry => entry.msg.url)).toEqual(["https://x.test/ahead"]);
    pending[0].resolve(scan("https://x.test/ahead", [{type: "gif"}, {}, {}]));
    await flush();
    expect(pending.map(entry => entry.msg.url)).toEqual(["https://x.test/ahead", "https://x.test/near"]);
    expect(warmer.warm).toHaveBeenCalledWith(["https://x.test/ahead/p1"], "soon");
    expect(p.isPrepared("https://x.test/ahead")).toBe(true);
    expect(p.preparedCount).toBe(1);
  });

  it("skips filtered, duplicate and removed links and does nothing with no budget", async () => {
    const a = link("https://x.test/a"), copy = link("https://x.test/a", 5), blocked = link("https://x.test/blocked"), gone = link("https://x.test/gone");
    prefetcher();
    show(a, copy, blocked, gone);
    gone.remove();
    ioCallback([{target: copy, isIntersecting: false}]);
    budget.nearbyLinks = 0;
    runIdle();
    expect(pending).toEqual([]);
    budget.nearbyLinks = 5;
    show(a);
    runIdle();
    await flush();
    expect(pending.map(entry => entry.msg.url)).toEqual(["https://x.test/a"]);
  });

  it("does not schedule while the tab is hidden or while a pass is already scheduled", () => {
    const p = prefetcher();
    Object.defineProperty(document, "hidden", {configurable: true, value: true});
    p.schedule();
    expect(idle).toHaveLength(0);
    Object.defineProperty(document, "hidden", {configurable: true, value: false});
    p.schedule();
    p.schedule();
    expect(idle).toHaveLength(1);
  });

  it("deduplicates two visible anchors that point to the same destination", async () => {
    const first = link("https://x.test/same", 10), second = link("https://x.test/same", 20);
    prefetcher();
    show(first, second);
    runIdle();
    await flush();
    expect(pending.map(entry => entry.msg.url)).toEqual(["https://x.test/same"]);
  });

  it("tracks links added later, including recycled hrefs", () => {
    const p = prefetcher();
    const wrapper = document.createElement("div");
    wrapper.innerHTML = `<a href="https://x.test/inner">i</a>`;
    const direct = document.createElement("a");
    direct.href = "https://x.test/direct";
    const recycled = link("https://x.test/old");
    p.trackAdded([
      {type: "childList", addedNodes: [wrapper, direct, document.createTextNode("t")], target: document.body} as unknown as MutationRecord,
      {type: "attributes", addedNodes: [], target: recycled} as unknown as MutationRecord,
      {type: "attributes", addedNodes: [], target: document.body} as unknown as MutationRecord
    ]);
    expect(observed.map(el => (el as HTMLAnchorElement).href)).toEqual(["https://x.test/inner", "https://x.test/direct", "https://x.test/old"]);
  });
});

describe("the link under the pointer", () => {
  it("is prepared straight away, ahead of the queue, with its first thumbnails decoded", async () => {
    const busy = link("https://x.test/busy"), hovered = link("https://x.test/hovered");
    const p = prefetcher();
    show(busy);
    runIdle();
    p.hover(hovered);
    p.hover(hovered);
    await flush();
    expect(pending.map(entry => entry.msg.url)).toEqual(["https://x.test/busy", "https://x.test/hovered"]);
    pending[1].resolve(scan("https://x.test/hovered", [{}, {type: "video", posterUrl: "https://x.test/poster"}, {type: "video"}, {}, {}, {}]));
    await flush();
    expect(warmer.warm).toHaveBeenNthCalledWith(1, ["https://x.test/hovered/p0", "https://x.test/poster"], "now", true);
    expect(warmer.warm).toHaveBeenNthCalledWith(2, ["https://x.test/hovered/p3", "https://x.test/hovered/p4", "https://x.test/hovered/p5"], "idle");
    expect(p.cached("https://x.test/hovered")!.items).toHaveLength(6);
    expect(p.cached("https://x.test/none")).toBeUndefined();
  });

  it("runs the deeper linked-page search when the pointer stays, once", async () => {
    const a = link("https://x.test/index");
    const p = prefetcher();
    p.hover(a);
    p.deepen(a);
    p.deepen(a);
    await flush();
    expect(pending.map(entry => entry.msg.deep)).toEqual([false, true]);
    settings = resolveSettings({recursiveSearch: "off"});
    p.deepen(link("https://x.test/other"));
    p.deepen(link("https://x.test/blocked"));
    expect(pending).toHaveLength(2);
  });

  it("backs off from a link that failed and recovers its previous level", async () => {
    const a = link("https://x.test/flaky");
    const p = prefetcher();
    p.hover(a);
    await flush();
    pending[0].resolve({error: "HTTP 500"});
    await flush();
    p.hover(a);
    expect(pending).toHaveLength(1);
    const now = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 31_000);
    p.hover(a);
    await flush();
    pending[1].resolve(scan("https://x.test/flaky"));
    await flush();
    p.deepen(a);
    await flush();
    pending[2].reject(new Error("offline"));
    await flush();
    p.hover(a);
    expect(pending).toHaveLength(3);
    now.mockRestore();
    p.hover(link("https://x.test/null"));
    await flush();
    pending[3].resolve(null);
    await flush();
    expect(p.isPrepared("https://x.test/null")).toBe(false);
  });

  it("skips hidden tabs, links that may not be previewed, and everything when nothing may be prepared ahead", async () => {
    const p = prefetcher();
    budget.speculative = false;
    p.hover(link("https://x.test/saver"));
    p.deepen(link("https://x.test/saver-deep"));
    budget.speculative = true;
    p.hover(link("https://x.test/blocked"));
    Object.defineProperty(document, "hidden", {configurable: true, value: true});
    p.hover(link("https://x.test/visible-later"));
    await flush();
    expect(pending).toEqual([]);
  });
});

describe("prepared galleries", () => {
  it("remember full scans, keep the most recent, and list prepared links in document order", () => {
    const p = prefetcher();
    const first = link("https://x.test/1"), second = link("https://x.test/2");
    link("https://x.test/1");
    link("https://x.test/blocked");
    p.remember("https://x.test/2", scan("https://x.test/2"));
    p.remember("https://x.test/1", scan("https://x.test/1"));
    p.remember("https://x.test/blocked", scan("https://x.test/blocked"));
    p.remember("https://x.test/empty", scan("https://x.test/empty", []));
    expect(p.preparedAnchors()).toEqual([first, second]);
    for (let i = 0; i < 90; i++) p.remember(`https://x.test/r${i}`, scan(`https://x.test/r${i}`));
    expect(p.preparedCount).toBe(80);
    expect(p.isPrepared("https://x.test/2")).toBe(false);
    p.reset();
    expect(p.preparedCount).toBe(0);
  });
});
