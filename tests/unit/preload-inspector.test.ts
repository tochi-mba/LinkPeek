import {afterEach, beforeEach, describe, expect, it, onTestFinished, vi} from "vitest";
import type {PreloadEntry} from "../../src/content/link-prefetcher";
import {PreloadInspector, type PreloadInspectorHost} from "../../src/content/preload-inspector";

let entries: PreloadEntry[], listeners: Array<() => void>, frames: Array<() => void>, source: PreloadInspectorHost & {[K in "setPriority" | "openUrl"]: ReturnType<typeof vi.fn>};

const entry = (name: string, state: PreloadEntry["state"], patch: Partial<PreloadEntry> = {}): PreloadEntry => ({
  url: `https://x.test/${name}`, label: name, state, priority: "normal", source: "page", hasGif: false, ...patch
});
function link(name: string) {
  const a = document.createElement("a");
  a.href = `https://x.test/${name}`;
  document.body.append(a);
  return a;
}
const panel = (inspector: PreloadInspector) => inspector.host.shadowRoot!;
const q = <T extends Element = HTMLElement>(inspector: PreloadInspector, selector: string) => panel(inspector).querySelector<T>(selector);
const notify = () => listeners.forEach(listener => listener());

beforeEach(() => {
  vi.useFakeTimers({toFake: ["setTimeout", "clearTimeout", "Date", "performance"]});
  document.body.innerHTML = "";
  entries = [];
  listeners = [];
  frames = [];
  source = {
    snapshot: () => entries,
    setPriority: vi.fn(),
    openUrl: vi.fn(),
    subscribe: listener => {
      listeners.push(listener);
      return () => listeners.splice(listeners.indexOf(listener), 1);
    }
  };
  vi.stubGlobal("requestAnimationFrame", vi.fn((callback: () => void) => frames.push(callback)));
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  document.querySelectorAll("[data-linkpeek-inspector],[data-linkpeek-inspector-style]").forEach(el => el.remove());
});

describe("the preload inspector", () => {
  it("opens in the corner with a summary and colour-coded outlines on the page's links", () => {
    const ready = link("ready"), loading = link("loading"), blocked = link("blocked");
    entries = [entry("ready", "prepared", {title: "Ready gallery"}), entry("loading", "loading", {priority: "maximum"}), entry("blocked", "blocked")];
    const inspector = new PreloadInspector(source);
    inspector.open();
    inspector.open();
    expect(inspector.isOpen).toBe(true);
    expect(document.querySelectorAll("[data-linkpeek-inspector-style]")).toHaveLength(1);
    expect(q(inspector, ".pi-sum")!.textContent).toBe("1 ready · 1 loading · 0 queued");
    expect([ready.dataset.linkpeekPreloadState, loading.dataset.linkpeekPreloadState, blocked.dataset.linkpeekPreloadState]).toEqual(["prepared", "loading", "blocked"]);
    expect(loading.dataset.linkpeekPreloadPriority).toBe("maximum");
    expect(ready.dataset.linkpeekPreloadPriority).toBeUndefined();
    expect(q(inspector, '[data-group="prepared"] small')!.textContent).toBe("Ready gallery");
    expect(q(inspector, '[data-group="loading"] .pi-state')!.textContent).toBe("loading · maximum");
  });

  it("shows a play badge only for links known to contain GIFs", () => {
    const gif = link("gif"), still = link("still");
    entries = [entry("gif", "prepared", {hasGif: true}), entry("still", "prepared")];
    const inspector = new PreloadInspector(source);
    inspector.open();
    expect(gif.dataset.linkpeekPreloadGif).toBe("true");
    expect(still.dataset.linkpeekPreloadGif).toBeUndefined();
    expect(panel(inspector).querySelectorAll(".pi-gif")).toHaveLength(1);
    expect(q(inspector, ".pi-gif")!.getAttribute("title")).toBe("Contains GIF");
    inspector.close();
    expect(gif.dataset.linkpeekPreloadGif).toBeUndefined();
  });

  it("adds the GIF icon live even when the preload state itself did not change", () => {
    const a = link("live");
    entries = [entry("live", "prepared")];
    const inspector = new PreloadInspector(source);
    inspector.open();
    expect(a.dataset.linkpeekPreloadGif).toBeUndefined();
    expect(q(inspector, ".pi-gif")).toBeNull();

    entries = [entry("live", "prepared", {hasGif: true})];
    notify();
    vi.advanceTimersByTime(200);
    frames.shift()!();
    expect(a.dataset.linkpeekPreloadGif).toBe("true");
    expect(q(inspector, ".pi-gif")).not.toBeNull();

    entries = [entry("live", "prepared")];
    notify();
    vi.advanceTimersByTime(200);
    frames.shift()!();
    expect(a.dataset.linkpeekPreloadGif).toBeUndefined();
    expect(q(inspector, ".pi-gif")).toBeNull();
  });

  it("keeps closed accordion groups as counts only, caps long groups and shows empty ones", () => {
    entries = Array.from({length: 160}, (_, i) => entry(`p${i}`, "prepared"));
    const inspector = new PreloadInspector(source);
    inspector.open();
    expect(panel(inspector).querySelectorAll('[data-group="prepared"] .pi-row')).toHaveLength(150);
    expect(q(inspector, ".pi-more")!.textContent).toBe("and 10 more");
    expect(q(inspector, '[data-group="queued"] .pi-none')!.textContent).toBe("None");
    expect(q(inspector, '[data-group="not-started"] .pi-row')).toBeNull();
    expect(q(inspector, '[data-group="not-started"] .pi-count')!.textContent).toBe("0");
  });

  it("opens and closes accordion groups", () => {
    entries = [entry("idle", "not-started")];
    const inspector = new PreloadInspector(source);
    inspector.open();
    const group = q<HTMLDetailsElement>(inspector, '[data-group="not-started"]')!;
    group.open = true;
    group.dispatchEvent(new Event("toggle"));
    expect(q(inspector, '[data-group="not-started"] .pi-row')).not.toBeNull();
    const reopened = q<HTMLDetailsElement>(inspector, '[data-group="not-started"]')!;
    reopened.dispatchEvent(new Event("toggle"));
    reopened.open = false;
    reopened.dispatchEvent(new Event("toggle"));
    expect(q(inspector, '[data-group="not-started"] .pi-row')).toBeNull();
  });

  it("coalesces bursts of changes into one redraw a frame, and skips redraws when nothing changed", () => {
    entries = [entry("a", "queued")];
    const inspector = new PreloadInspector(source);
    inspector.open();
    const before = q(inspector, ".pi");
    notify();
    notify();
    vi.advanceTimersByTime(200);
    expect(frames).toHaveLength(1);
    frames.shift()!();
    expect(q(inspector, ".pi")).toBe(before);
    entries = [entry("a", "loading")];
    notify();
    vi.advanceTimersByTime(200);
    frames.shift()!();
    expect(q(inspector, ".pi")).not.toBe(before);
    expect(q(inspector, ".pi-sum")!.textContent).toContain("1 loading");
  });

  it("selects rows, applies a priority to all of them and opens a row's link", () => {
    entries = [entry("a", "queued"), entry("b", "queued", {source: "linked"})];
    const inspector = new PreloadInspector(source);
    inspector.open();
    expect(q<HTMLButtonElement>(inspector, '[data-action="high"]')!.disabled).toBe(true);
    expect(q(inspector, ".pi-tag")!.textContent).toBe("linked page");
    // Each change redraws the list, so look the checkbox up afresh every time.
    for (const url of ["https://x.test/a", "https://x.test/b"]) {
      const box = q<HTMLInputElement>(inspector, `[data-select="${url}"]`)!;
      box.checked = true;
      box.dispatchEvent(new Event("change", {bubbles: true}));
    }
    expect(q(inspector, ".pi-tools span")!.textContent).toBe("2 selected");
    const first = q<HTMLInputElement>(inspector, "[data-select]")!;
    first.checked = false;
    first.dispatchEvent(new Event("change", {bubbles: true}));
    expect(q(inspector, ".pi-tools span")!.textContent).toBe("1 selected");
    q<HTMLButtonElement>(inspector, '[data-action="maximum"]')!.click();
    expect(source.setPriority).toHaveBeenCalledWith(["https://x.test/b"], "maximum");
    expect(q(inspector, ".pi-tools span")!.textContent).toBe("0 selected");
    q<HTMLButtonElement>(inspector, "[data-open]")!.click();
    expect(source.openUrl).toHaveBeenCalledWith("https://x.test/a");
    q(inspector, ".pi-list")!.click();
  });

  it("forgets selections for links that disappeared", () => {
    entries = [entry("a", "queued")];
    const inspector = new PreloadInspector(source);
    inspector.open();
    const box = q<HTMLInputElement>(inspector, "[data-select]")!;
    box.checked = true;
    box.dispatchEvent(new Event("change", {bubbles: true}));
    entries = [];
    notify();
    vi.advanceTimersByTime(200);
    frames.shift()!();
    expect(q(inspector, ".pi-tools span")!.textContent).toBe("0 selected");
  });

  it("collapses to a pill and expands again", () => {
    entries = [entry("a", "prepared")];
    const inspector = new PreloadInspector(source);
    inspector.open();
    q<HTMLButtonElement>(inspector, '[data-action="minimize"]')!.click();
    expect(q(inspector, ".pi.min")).not.toBeNull();
    expect(q(inspector, ".pi-list")).toBeNull();
    q<HTMLButtonElement>(inspector, '[data-action="minimize"]')!.click();
    expect(q(inspector, ".pi-list")).not.toBeNull();
  });

  it("shows how long until a link is retried", () => {
    entries = [entry("a", "backoff", {retryAt: Date.now() + 12_400}), entry("b", "backoff")];
    const inspector = new PreloadInspector(source);
    inspector.open();
    const group = q<HTMLDetailsElement>(inspector, '[data-group="backoff"]')!;
    group.open = true;
    group.dispatchEvent(new Event("toggle"));
    expect([...panel(inspector).querySelectorAll('[data-group="backoff"] .pi-state')].map(el => el.textContent)).toEqual(["retry in 13s", "backoff"]);
  });

  it("only rewrites outlines that changed, and removes them from links that left the list", () => {
    const a = link("a"), b = link("b");
    entries = [entry("a", "queued", {priority: "high"}), entry("b", "queued")];
    const inspector = new PreloadInspector(source);
    inspector.open();
    expect(a.dataset.linkpeekPreloadPriority).toBe("high");
    entries = [entry("a", "loading")];
    notify();
    vi.advanceTimersByTime(200);
    frames.shift()!();
    expect([a.dataset.linkpeekPreloadState, a.dataset.linkpeekPreloadPriority, b.dataset.linkpeekPreloadState]).toEqual(["loading", undefined, undefined]);
    entries = [entry("a", "loading", {priority: "maximum"})];
    notify();
    vi.advanceTimersByTime(200);
    frames.shift()!();
    expect(a.dataset.linkpeekPreloadPriority).toBe("maximum");
  });

  it("closes with Escape, the close button or toggle, cleaning up everything", () => {
    const a = link("a");
    entries = [entry("a", "prepared")];
    const inspector = new PreloadInspector(source);
    expect(inspector.key(new KeyboardEvent("keydown", {key: "Escape"}))).toBe(false);
    inspector.toggle();
    expect(inspector.key(new KeyboardEvent("keydown", {key: "x"}))).toBe(false);
    notify();
    expect(inspector.key(new KeyboardEvent("keydown", {key: "Escape"}))).toBe(true);
    expect(cancelAnimationFrame).toHaveBeenCalled();
    expect([inspector.isOpen, a.dataset.linkpeekPreloadState, listeners.length]).toEqual([false, undefined, 0]);
    expect(document.querySelector("[data-linkpeek-inspector-style]")).toBeNull();
    inspector.toggle();
    q<HTMLButtonElement>(inspector, '[data-action="close"]')!.click();
    expect(inspector.isOpen).toBe(false);
    inspector.toggle();
    inspector.toggle();
    inspector.close();
    expect(inspector.isOpen).toBe(false);
  });

  it("keeps the list's scroll position across redraws", () => {
    // jsdom has no layout, so give elements a scroll position that sticks.
    const original = Object.getOwnPropertyDescriptor(Element.prototype, "scrollTop")!;
    const positions = new WeakMap<Element, number>();
    Object.defineProperty(Element.prototype, "scrollTop", {configurable: true, get() {
      return positions.get(this) ?? 0;
    }, set(value: number) {
      positions.set(this, value);
    }});
    onTestFinished(() => {
      Object.defineProperty(Element.prototype, "scrollTop", original);
    });
    entries = Array.from({length: 40}, (_, i) => entry(`q${i}`, "queued"));
    const inspector = new PreloadInspector(source);
    inspector.open();
    q(inspector, ".pi-list")!.scrollTop = 120;
    entries = [...entries, entry("new", "loading")];
    notify();
    vi.advanceTimersByTime(200);
    frames.shift()!();
    expect(q(inspector, ".pi-list")!.scrollTop).toBe(120);
  });
});
