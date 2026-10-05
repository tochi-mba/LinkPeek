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
  settingsFor: url => url.includes("blocked") ? undefined : settings,
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
  it("discards scans and failures from before a reset", async () => {
    const p = prefetcher(), a = link("https://x.test/a"), b = link("https://x.test/b");
    p.hover(a);p.hover(b);await flush();
    p.reset();
    pending[0].resolve(scan(a.href));pending[1].reject(new Error("old failure"));
    await flush();
    expect(p.preparedCount).toBe(0);
    expect(warmer.warm).not.toHaveBeenCalled();
    expect(p.snapshot().every(entry => entry.state === "not-started")).toBe(true);
    p.hover(a);await flush();
    expect(pending).toHaveLength(3);
  });

  it("bounds urgent concurrency and does not start queued work after disabling speculation", async () => {
    const p = prefetcher();
    const links = Array.from({length: 5}, (_, i) => link(`https://x.test/${i}`));
    for (const a of links) p.hover(a);
    await flush();
    expect(pending).toHaveLength(2);
    budget.speculative = false;
    pending[0].resolve(scan(links[0].href));pending[1].resolve(scan(links[1].href));
    await flush();
    expect(pending).toHaveLength(2);
  });

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

describe("linked-page lists", () => {
  const list = ["a", "b", "c", "d", "e"].map(name => `https://x.test/list/${name}`);

  it("prepare the next two links and the previous one around the link being viewed, wrapping", async () => {
    budget.linkConcurrency = 4;
    const p = prefetcher();
    p.warmAround(list, 0);
    await flush();
    expect(pending.map(entry => entry.msg)).toEqual([list[1], list[2], list[4]].map(url => ({type: "LINKPEEK_PREFETCH", url, kind: "generic", deep: false})));
    p.warmAround(list, -1);
    await flush();
    expect(pending.map(entry => entry.msg.url)).toContain(list[0]);
  });

  it("reach one link ahead on a small budget and skip links that may not be previewed", async () => {
    budget = {...budget, nearbyLinks: 0, linkConcurrency: 4};
    const p = prefetcher();
    p.warmAround(["https://x.test/one", "https://x.test/blocked"], 0);
    p.warmAround(["https://x.test/x", "https://x.test/y", "https://x.test/z"], 1);
    await flush();
    expect(pending.map(entry => entry.msg.url)).toEqual(["https://x.test/z", "https://x.test/x"]);
  });

  it("do nothing when nothing may be prepared ahead or there is nowhere to go", async () => {
    const p = prefetcher();
    p.warmAround(["https://x.test/only"], 0);
    budget.speculative = false;
    p.warmAround(list, 0);
    await flush();
    expect(pending).toEqual([]);
  });

  it("appear in the inspector as linked pages, keeping only the most recent", async () => {
    const p = prefetcher();
    p.warmAround(["https://x.test/start", "https://x.test/gallery/%E0%A4%A", "https://x.test/"], 0);
    const linked = p.snapshot().filter(entry => entry.source === "linked");
    expect(linked.map(entry => entry.label)).toEqual(["%E0%A4%A", "x.test"]);
    for (let i = 0; i < 90; i++) p.warmAround([`https://x.test/from${i}`, `https://x.test/to${i}`], 0);
    expect(p.snapshot().filter(entry => entry.source === "linked")).toHaveLength(80);
  });
});

describe("the inspector's view", () => {
  it("lists every page link once, with what is happening to it", async () => {
    budget.linkConcurrency = 1;
    const p = prefetcher();
    const [ready, loading, failed, inFlight, waiting] = ["ready", "loading", "failed", "in-flight", "waiting"].map(name => link(`https://x.test/${name}`));
    link("https://x.test/blocked");
    link("https://x.test/idle").textContent = "  ";
    link("https://x.test/ready");
    p.remember(ready.href, {...scan(ready.href), title: "Ready gallery"});
    p.hover(loading);
    p.hover(failed);
    await flush();
    pending[1].reject(new Error("offline"));
    await flush();
    p.hover(inFlight);
    p.hover(waiting);
    await flush();
    const byUrl = new Map(p.snapshot().map(entry => [entry.url.split("/").pop(), entry]));
    expect(p.snapshot().filter(entry => entry.url === ready.href)).toHaveLength(1);
    expect(byUrl.get("ready")).toMatchObject({state: "prepared", title: "Ready gallery", label: ready.href, source: "page"});
    expect(byUrl.get("loading")!.state).toBe("loading");
    expect(byUrl.get("waiting")!.state).toBe("queued");
    expect(byUrl.get("failed")).toMatchObject({state: "backoff", retryAt: expect.any(Number)});
    expect(byUrl.get("blocked")!.state).toBe("blocked");
    expect(byUrl.get("idle")).toMatchObject({state: "not-started", priority: "normal", label: "https://x.test/idle"});
  });

  it("reports GIF presence from type, original, preview, filename and direct GIF URLs", () => {
    const p = prefetcher();
    const typed = link("https://x.test/typed"), original = link("https://x.test/original"), preview = link("https://x.test/preview");
    const named = link("https://x.test/named"), direct = link("https://x.test/direct.gif"), still = link("https://x.test/still.jpg");
    p.remember(typed.href, scan(typed.href, [{type: "gif"}]));
    const originalScan = scan(original.href);
    originalScan.items[0].originalUrl = "https://cdn.test/animation.gif?x=1";
    p.remember(original.href, originalScan);
    const previewScan = scan(preview.href);
    previewScan.items[0].previewUrl = "https://cdn.test/preview.gif#frame";
    p.remember(preview.href, previewScan);
    const namedScan = scan(named.href);
    namedScan.items[0].filename = "animation.GIF";
    p.remember(named.href, namedScan);
    const byUrl = new Map(p.snapshot().map(entry => [entry.url, entry]));
    expect([typed, original, preview, named, direct].map(a => byUrl.get(a.href)!.hasGif)).toEqual([true, true, true, true, true]);
    expect(byUrl.get(still.href)!.hasGif).toBe(false);
  });

  it("tells subscribers about changes until they unsubscribe", () => {
    const p = prefetcher(), listener = vi.fn(), unsubscribe = p.subscribe(listener);
    p.remember("https://x.test/a", scan("https://x.test/a"));
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
    p.reset();
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("prepares a link at maximum priority now, at high priority when idle, and clears normal", async () => {
    budget = {...budget, speculative: false, linkConcurrency: 1};
    const p = prefetcher(), [now, soon, later, blocked] = ["now", "soon", "later", "blocked"].map(name => link(`https://x.test/${name}`));
    p.setPriority([now.href], "maximum");
    await flush();
    expect(pending.map(entry => entry.msg)).toEqual([expect.objectContaining({url: now.href, deep: true})]);
    p.setPriority([soon.href, later.href, blocked.href], "high");
    expect(p.snapshot().find(entry => entry.url === soon.href)).toMatchObject({state: "queued", priority: "high"});
    expect(p.snapshot().find(entry => entry.url === blocked.href)!.priority).toBe("normal");
    runIdle();
    expect(idle).toHaveLength(1);
    runIdle();
    await flush();
    pending[0].resolve(scan(now.href));
    await flush();
    pending[1].resolve(scan(soon.href));
    await flush();
    expect(pending.map(entry => entry.msg.url)).toEqual([now.href, soon.href, later.href]);
    p.setPriority([now.href], "normal");
    expect(p.snapshot().find(entry => entry.url === now.href)!.priority).toBe("normal");
  });

  it("drops a raised link that was removed from the page or blocked meanwhile", async () => {
    const p = prefetcher(), gone = link("https://x.test/gone"), original = host.settingsFor;
    p.setPriority([gone.href], "high");
    host.settingsFor = () => undefined;
    runIdle();
    host.settingsFor = original;
    await flush();
    expect(pending).toEqual([]);
  });
});

describe("limits", () => {
  it("skip new work while too much is already waiting", async () => {
    budget.linkConcurrency = 1;
    const p = prefetcher(), anchors = Array.from({length: 84}, (_, i) => link(`https://x.test/w${i}`));
    for (const anchor of anchors) p.hover(anchor);
    await flush();
    expect(pending).toHaveLength(2);
    expect(p.snapshot().find(entry => entry.url === anchors[81].href)!.state).toBe("queued");
    expect(p.snapshot().find(entry => entry.url === anchors[83].href)!.state).toBe("not-started");
  });

  it("drop work that was waiting for a slot when the page changed", async () => {
    budget.linkConcurrency = 1;
    const p = prefetcher();
    for (const name of ["a", "b", "c"]) p.hover(link(`https://x.test/${name}`));
    await flush();
    expect(pending).toHaveLength(2);
    p.reset();
    pending[0].resolve(scan(pending[0].msg.url));
    await flush();
    expect(pending).toHaveLength(2);
  });

  it("forget the oldest requests past a thousand, so those links can be prepared again", async () => {
    const send = vi.fn(async (msg: {url: string}) => scan(msg.url, []));
    vi.stubGlobal("chrome", {runtime: {sendMessage: send}});
    budget.linkConcurrency = 8;
    const p = prefetcher(), first = link("https://x.test/m0");
    p.hover(first);
    await flush();
    for (let i = 1; i <= 1000; i++) {
      p.hover(link(`https://x.test/m${i}`));
      if (i % 50 === 0) await flush();
    }
    await flush();
    p.hover(first);
    await flush();
    expect(send.mock.calls.filter(([msg]) => msg.url === first.href)).toHaveLength(2);
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
