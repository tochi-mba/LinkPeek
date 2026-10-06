import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import type {ImageWarmer} from "../../src/content/image-warmer";
import {LinkPrefetcher, type PrefetchHost} from "../../src/content/link-prefetcher";
import type {Budget} from "../../src/content/resource-governor";
import type {ScanResult} from "../../src/shared/media";
import {resolveSettings, type LinkPeekSettings} from "../../src/shared/settings";

type IOCallback = (entries: Array<{target: Element; isIntersecting: boolean}>) => void;
let ioCallback: IOCallback, observed: Element[], idle: Array<(deadline: IdleDeadline) => void>, busy: boolean, idleTime: number;
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
  budget: () => budget as Budget,
  busy: () => busy
};
const flush = () => new Promise(resolve => setTimeout(resolve, 0));
const runIdle = (didTimeout = false) => idle.shift()!({didTimeout, timeRemaining: () => idleTime});
const show = (...anchors: Element[]) => ioCallback(anchors.map(target => ({target, isIntersecting: true})));

beforeEach(() => {
  document.body.innerHTML = "";
  observed = [];
  idle = [];
  pending = [];
  warmer.warm.mockReset();
  settings = resolveSettings({});
  budget = {speculative: true, nearbyLinks: 2, backgroundLinks: 0, linkConcurrency: 1, thumbsPerLink: 1, hoverThumbs: 2, hoverIdleThumbs: 3};
  busy = false;
  idleTime = 50;
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
  vi.stubGlobal("requestIdleCallback", vi.fn((callback: (deadline: IdleDeadline) => void) => idle.push(callback)));
  vi.stubGlobal("chrome", {runtime: {sendMessage: vi.fn((msg: {url: string; deep: boolean}) => new Promise((resolve, reject) => pending.push({msg, resolve, reject})))}});
});
afterEach(() => vi.unstubAllGlobals());

function prefetcher() {
  const instance = new LinkPrefetcher(host, warmer as unknown as ImageWarmer);
  instance.start();
  return instance;
}

describe("what checks found", () => {
  it("remembers which links hold a GIF", () => {
    const p = prefetcher();
    p.remember("https://x.test/gif", scan("https://x.test/gif", [{type: "gif"}]));
    p.remember("https://x.test/still", scan("https://x.test/still"));
    expect([p.knownGif("https://x.test/gif"), p.knownGif("https://x.test/still"), p.knownGif("https://x.test/new")]).toEqual([true, false, false]);
  });
});

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

  it("forget the oldest requests past five thousand, so those links can be prepared again", async () => {
    const send = vi.fn(async (msg: {url: string}) => scan(msg.url, []));
    vi.stubGlobal("chrome", {runtime: {sendMessage: send}});
    budget.linkConcurrency = 8;
    const p = prefetcher(), first = link("https://x.test/m0");
    const detached = (href: string) => Object.assign(document.createElement("a"), {href});
    p.hover(first);
    await flush();
    for (let i = 1; i <= 5000; i++) {
      p.hover(detached(`https://x.test/m${i}`));
      if (i % 40 === 0) await flush();
    }
    await flush();
    p.hover(first);
    await flush();
    expect(send.mock.calls.filter(([msg]) => msg.url === first.href)).toHaveLength(2);
  }, 60_000);
});

describe("the rest of the page", () => {
  const page = (count: number) => Array.from({length: count}, (_, i) => link(`https://x.test/page/${i}`));
  const urls = () => pending.map(entry => entry.msg.url.replace("https://x.test/", ""));
  const answer = async (index: number, value: unknown = scan(pending[index].msg.url)) => {
    pending[index].resolve(value);
    await flush();
  };

  beforeEach(() => {
    budget = {...budget, nearbyLinks: 0, backgroundLinks: 1, linkConcurrency: 2};
  });

  it("is checked one link at a time in idle time, those near the screen first, until every link is done", async () => {
    const [first, second, third] = page(3);
    link("https://x.test/blocked");
    const p = prefetcher();
    show(third);
    runIdle();
    await flush();
    expect(urls()).toEqual(["page/2"]);
    expect(p.snapshot().find(entry => entry.url === third.href)!.state).toBe("loading");
    await answer(0);
    // Each finished check asks for the next idle moment rather than starting straight away.
    expect(idle).toHaveLength(1);
    runIdle();
    await flush();
    await answer(1, scan(first.href, []));
    runIdle();
    await flush();
    await answer(2);
    runIdle();
    expect(urls()).toEqual(["page/2", "page/0", "page/1"]);
    expect(p.snapshot().map(entry => entry.state)).toEqual(["empty", "prepared", "prepared", "blocked"]);
    expect([p.isPrepared(second.href), p.knownEmpty(first.href)]).toEqual([true, false]);
    // A page that was only checked quickly gets the deeper linked-page search once nothing else is left.
    show(first);
    runIdle();
    await flush();
    expect(pending.at(-1)!.msg).toMatchObject({url: first.href, deep: true});
    await answer(3, scan(first.href, []));
    runIdle();
    expect(p.knownEmpty(first.href)).toBe(true);
    expect(pending).toHaveLength(4);
    // Thumbnails are never downloaded for links that are not near the pointer.
    expect(warmer.warm).not.toHaveBeenCalled();
  });

  it("picks up links added later and leaves alone links that are being prepared or rest after a failure", async () => {
    const [first] = page(1);
    const p = prefetcher();
    p.hover(first);
    p.schedule();
    runIdle();
    await flush();
    expect(urls()).toEqual(["page/0"]);
    pending[0].reject(new Error("offline"));
    await flush();
    const later = link("https://x.test/page/later");
    p.trackAdded([{type: "childList", addedNodes: [later] as unknown as NodeList, target: document.body} as unknown as MutationRecord]);
    runIdle();
    await flush();
    expect(urls()).toEqual(["page/0", "page/later"]);
  });

  it("waits while a preview loads, while the page is under pressure, without idle time, and when nothing may be prepared", async () => {
    vi.useFakeTimers({toFake: ["setTimeout", "clearTimeout"]});
    try {
      page(2);
      const p = prefetcher();
      const settle = () => vi.advanceTimersByTimeAsync(0);
      p.schedule();
      for (const pause of [() => budget.backgroundLinks = 0, () => budget.speculative = false, () => idleTime = 1]) {
        pause();
        runIdle();
        await settle();
        expect(pending).toEqual([]);
        budget = {...budget, backgroundLinks: 1, speculative: true};
        idleTime = 50;
        p.schedule();
      }
      // Paused by pressure or by a preview loading, it looks again by itself a moment later.
      for (const wait of [() => budget = {...budget, backgroundLinks: 0, backgroundPaused: true}, () => busy = true]) {
        wait();
        runIdle();
        await settle();
        expect([idle.length, pending.length]).toEqual([0, 0]);
        budget = {...budget, backgroundLinks: 1, backgroundPaused: false};
        busy = false;
        await vi.advanceTimersByTimeAsync(1000);
        expect(idle).toHaveLength(1);
      }
      // A callback that ran out of patience still does one link's worth of work.
      idleTime = 0;
      runIdle(true);
      await settle();
      expect(pending).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives a struggling site room: two failures in a row pause the pass, longer each time", async () => {
    vi.useFakeTimers({toFake: ["setTimeout", "Date"]});
    try {
      page(6);
      const p = prefetcher();
      p.schedule();
      const step = async () => {
        if (idle.length) runIdle();
        await vi.advanceTimersByTimeAsync(0);
      };
      await step();
      pending[0].reject(new Error("HTTP 429"));
      await vi.advanceTimersByTimeAsync(0);
      await step();
      pending[1].reject(new Error("HTTP 429"));
      await vi.advanceTimersByTimeAsync(0);
      await step();
      expect(pending).toHaveLength(2);
      // Idle rounds still run (nearby work goes on); only the whole-page pass waits.
      p.schedule();
      await step();
      expect(pending).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(10_000);
      await step();
      expect(pending).toHaveLength(3);
      pending[2].reject(new Error("HTTP 429"));
      await vi.advanceTimersByTimeAsync(0);
      await step();
      await vi.advanceTimersByTimeAsync(10_000);
      await step();
      expect(pending).toHaveLength(3);
      await vi.advanceTimersByTimeAsync(10_000);
      await step();
      expect(pending).toHaveLength(4);
      // A success clears the streak.
      await vi.advanceTimersByTimeAsync(0);
      pending[3].resolve(scan(pending[3].msg.url));
      await vi.advanceTimersByTimeAsync(0);
      await step();
      expect(pending).toHaveLength(5);
      // Failures of links asked for explicitly do not count against the site.
      p.setPriority(["https://x.test/explicit"], "maximum");
      await vi.advanceTimersByTimeAsync(0);
      pending.at(-1)!.reject(new Error("HTTP 500"));
      pending[4].reject(new Error("HTTP 500"));
      await vi.advanceTimersByTimeAsync(0);
      await step();
      expect(pending).toHaveLength(7);
    } finally {
      vi.useRealTimers();
    }
  });

  it("checks at most 400 off-screen links per visit, while links near the screen are never limited", async () => {
    vi.stubGlobal("chrome", {runtime: {sendMessage: vi.fn(async (msg: {url: string}) => scan(msg.url, []))}});
    const links = page(402);
    const p = prefetcher();
    for (let round = 0; round < 450; round++) {
      p.schedule();
      runIdle();
      await flush();
    }
    const sent = (chrome.runtime.sendMessage as ReturnType<typeof vi.fn>).mock.calls.map(([msg]) => msg.url);
    expect(sent).toHaveLength(400);
    show(links[401]);
    runIdle();
    await flush();
    expect((chrome.runtime.sendMessage as ReturnType<typeof vi.fn>).mock.calls.at(-1)![0].url).toBe(links[401].href);
    p.reset();
    p.schedule();
    runIdle();
    await flush();
    expect((chrome.runtime.sendMessage as ReturnType<typeof vi.fn>).mock.calls.at(-1)![0].url).toBe(links[401].href);
  }, 60_000);

  it("only keeps a full gallery from a whole-page check while there is room, never evicting one near the pointer", async () => {
    const p = prefetcher();
    for (let i = 0; i < 80; i++) p.remember(`https://x.test/kept${i}`, scan(`https://x.test/kept${i}`));
    const [far] = page(1);
    p.schedule();
    runIdle();
    await flush();
    await answer(0);
    expect([p.cached(far.href), p.isPrepared(far.href), p.cached("https://x.test/kept0")]).toEqual([undefined, true, expect.anything()]);
  });

  it("fetches a far link's gallery again once it comes near, to warm its thumbnails", async () => {
    budget.nearbyLinks = 1;
    const [far] = page(1);
    const p = prefetcher();
    for (let i = 0; i < 80; i++) p.remember(`https://x.test/kept${i}`, scan(`https://x.test/kept${i}`));
    p.schedule();
    runIdle();
    await flush();
    await answer(0);
    show(far);
    runIdle();
    await flush();
    expect(urls()).toEqual(["page/0", "page/0"]);
    await answer(1);
    expect(warmer.warm).toHaveBeenCalledWith([`${far.href}/p0`], "soon");
    warmer.warm.mockClear();
    p.schedule();
    runIdle();
    await flush();
    expect(warmer.warm).not.toHaveBeenCalled();
    expect(pending).toHaveLength(2);
    expect(p.cached(far.href)).toBeDefined();
  });
});

describe("full galleries for the shuffle", () => {
  it("come from memory, from preparation already running, or from the service worker, empty ones included", async () => {
    const p = prefetcher(), kept = link("https://x.test/kept"), running = link("https://x.test/running");
    p.remember(kept.href, scan(kept.href));
    expect(await p.gallery(kept.href)).toEqual(scan(kept.href));
    expect(p.galleries().map(([url]) => url)).toEqual([kept.href]);
    p.hover(running);
    const waiting = p.gallery(running.href);
    await flush();
    expect(pending).toHaveLength(1);
    pending[0].resolve(scan(running.href));
    expect(await waiting).toEqual(scan(running.href));
    const empty = p.gallery("https://x.test/empty");
    await flush();
    pending[1].resolve({...scan("https://x.test/empty", []), linkContexts: [{sourceUrl: "https://x.test/empty", links: ["https://x.test/deeper"]}]});
    expect((await empty)!.linkContexts![0].links).toEqual(["https://x.test/deeper"]);
    expect(await p.gallery("https://x.test/blocked")).toBeUndefined();
    expect(p.pausedFor()).toBe(0);
  });
});

describe("prepared galleries", () => {
  it("keep the most recent galleries for instant display and a summary of every link checked", () => {
    const p = prefetcher();
    p.remember("https://x.test/2", scan("https://x.test/2"));
    p.remember("https://x.test/empty", scan("https://x.test/empty", []));
    p.remember("https://x.test/partial", {...scan("https://x.test/partial", []), complete: false});
    for (let i = 0; i < 90; i++) p.remember(`https://x.test/r${i}`, scan(`https://x.test/r${i}`));
    expect(p.preparedCount).toBe(91);
    // Evicted from memory, but the service worker still has it: still prepared.
    expect([p.cached("https://x.test/2"), p.isPrepared("https://x.test/2")]).toEqual([undefined, true]);
    expect([p.knownEmpty("https://x.test/empty"), p.knownEmpty("https://x.test/partial"), p.knownEmpty("https://x.test/2"), p.knownEmpty("https://x.test/new")])
      .toEqual([true, false, false, false]);
    for (let i = 0; i < 5000; i++) p.remember(`https://x.test/s${i}`, scan(`https://x.test/s${i}`, []));
    expect(p.isPrepared("https://x.test/r0")).toBe(false);
    p.reset();
    expect(p.preparedCount).toBe(0);
  });
});
