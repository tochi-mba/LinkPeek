import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {PreloadInspector, type PreloadInspectorHost} from "../../src/content/preload-inspector";
import type {PreloadEntry, PreloadPriority} from "../../src/content/link-prefetcher";

let entries: PreloadEntry[], listener: (() => void) | undefined;
let priorities: Array<{urls: string[]; priority: PreloadPriority}>, opened: string[];

const entry = (url: string, state: PreloadEntry["state"], patch: Partial<PreloadEntry> = {}): PreloadEntry => ({
  url, label: url.split("/").at(-1) || url, state, priority: "normal", source: "page", ...patch
});

const host = (): PreloadInspectorHost => ({
  snapshot: () => entries,
  setPriority: (urls, priority) => priorities.push({urls: [...urls], priority}),
  openUrl: url => opened.push(url),
  subscribe: callback => {
    listener = callback;
    return () => {
      listener = undefined;
    };
  }
});

function shadow(inspector: PreloadInspector) {
  return (inspector as unknown as {shadow: ShadowRoot}).shadow;
}

beforeEach(() => {
  document.documentElement.innerHTML = "<head><title>Inspector page</title></head><body></body>";
  history.replaceState(null, "", "/inspector");
  entries = [];
  priorities = [];
  opened = [];
  listener = undefined;
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("preload inspector", () => {
  it("opens, renders every state, outlines page links and closes with Escape", () => {
    const urls = ["ready", "load", "queue", "retry", "fresh", "blocked"].map(name => `https://example.test/${name}`);
    for (const url of urls) {
      const a = document.createElement("a");
      a.href = url;
      a.textContent = url.split("/").at(-1)!;
      document.body.append(a);
    }
    entries = [
      entry(urls[0], "prepared", {title: "Prepared title"}),
      entry(urls[1], "loading", {priority: "maximum"}),
      entry(urls[2], "queued", {priority: "high"}),
      entry(urls[3], "backoff", {retryAt: Date.now() + 2500}),
      entry(urls[4], "not-started"),
      entry(urls[5], "blocked")
    ];
    const inspector = new PreloadInspector(host());
    inspector.open();
    expect(inspector.isOpen).toBe(true);
    expect(shadow(inspector).textContent).toContain("Inspector page");
    expect(shadow(inspector).textContent).toContain("active: load");
    expect(shadow(inspector).textContent).toContain("backoff · 3s");
    expect(document.querySelector<HTMLAnchorElement>('a[href$="/ready"]')!.dataset.linkpeekPreloadState).toBe("prepared");
    expect(document.querySelector<HTMLAnchorElement>('a[href$="/load"]')!.dataset.linkpeekPreloadPriority).toBe("maximum");

    inspector.open();
    expect(inspector.key(new KeyboardEvent("keydown", {key: "Enter"}))).toBe(false);
    expect(inspector.key(new KeyboardEvent("keydown", {key: "Escape"}))).toBe(true);
    expect(inspector.isOpen).toBe(false);
    expect(document.querySelector("[data-linkpeek-inspector-style]")).toBeNull();
    expect(document.querySelector<HTMLAnchorElement>('a[href$="/ready"]')!.dataset.linkpeekPreloadState).toBeUndefined();
  });

  it("toggles, live-renders queued/backoff/no-active states and shows empty groups", () => {
    const inspector = new PreloadInspector(host());
    inspector.toggle();
    expect(inspector.isOpen).toBe(true);
    expect(shadow(inspector).textContent).toContain("None");

    entries = [entry("https://example.test/q", "queued")];
    listener!();
    expect(shadow(inspector).textContent).toContain("active: q");

    entries = [entry("https://example.test/b", "backoff")];
    listener!();
    expect(shadow(inspector).textContent).toContain("active: b");

    entries = [entry("https://example.test/p", "prepared")];
    listener!();
    expect(shadow(inspector).textContent).not.toContain("active:");

    inspector.toggle();
    expect(inspector.isOpen).toBe(false);
    expect(inspector.key(new KeyboardEvent("keydown", {key: "Escape"}))).toBe(false);
  });

  it("selects multiple rows, changes all priority levels and opens entries", () => {
    entries = [
      entry("https://example.test/a", "not-started"),
      entry("https://example.test/b", "not-started", {priority: "high"})
    ];
    const inspector = new PreloadInspector(host());
    inspector.open();
    const root = shadow(inspector);

    const checks = [...root.querySelectorAll<HTMLInputElement>("[data-select]")];
    checks[0].checked = true;
    checks[0].dispatchEvent(new Event("change", {bubbles: true}));
    const refreshed = [...root.querySelectorAll<HTMLInputElement>("[data-select]")];
    refreshed[1].checked = true;
    refreshed[1].dispatchEvent(new Event("change", {bubbles: true}));
    expect(root.textContent).toContain("2 selected");

    for (const priority of ["high", "maximum", "normal"] as const) {
      root.querySelector<HTMLButtonElement>(`[data-action="${priority}"]`)!.click();
    }
    expect(priorities).toEqual([
      {urls: ["https://example.test/a", "https://example.test/b"], priority: "high"},
      {urls: ["https://example.test/a", "https://example.test/b"], priority: "maximum"},
      {urls: ["https://example.test/a", "https://example.test/b"], priority: "normal"}
    ]);

    root.querySelector<HTMLButtonElement>('[data-open="https://example.test/a"]')!.click();
    expect(opened).toEqual(["https://example.test/a"]);

    const again = root.querySelector<HTMLInputElement>('[data-select="https://example.test/a"]')!;
    again.checked = false;
    again.dispatchEvent(new Event("change", {bubbles: true}));
    expect(root.textContent).toContain("1 selected");

    root.querySelector<HTMLElement>(".pi")!.dispatchEvent(new MouseEvent("click", {bubbles: true}));
    const orphan = document.createElement("input");
    orphan.dispatchEvent(new Event("change", {bubbles: true}));
    root.querySelector<HTMLButtonElement>('[data-action="close"]')!.click();
    expect(inspector.isOpen).toBe(false);
  });

  it("falls back to the URL when the tab has no title and ignores page links missing from the snapshot", () => {
    document.title = "";
    const known = document.createElement("a"), unknown = document.createElement("a");
    known.href = "https://example.test/known";
    unknown.href = "https://example.test/unknown";
    document.body.append(known, unknown);
    entries = [entry(known.href, "prepared", {label: "Known"})];
    const inspector = new PreloadInspector(host());
    inspector.open();
    expect(shadow(inspector).textContent).toContain(location.href);
    expect(known.dataset.linkpeekPreloadState).toBe("prepared");
    expect(unknown.dataset.linkpeekPreloadState).toBeUndefined();
    listener!();
    inspector.close();
  });
});
