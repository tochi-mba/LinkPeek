import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import type {Budget} from "../../src/content/resource-governor";
import type {MediaItem, ScanResult} from "../../src/shared/media";
import {DEFAULT_SHORTCUTS, resolveSettings, type LinkPeekSettings} from "../../src/shared/settings";

const mocks = vi.hoisted(() => ({preloaders: [] as any[], gestures: [] as any[], isFavorite: vi.fn(), toggleFavorite: vi.fn()}));
vi.mock("../../src/ui/media-preloader", () => ({
  MediaPreloader: class {
    reset = vi.fn();
    dispose = vi.fn();
    schedule = vi.fn();
    ensure = vi.fn(async () => true);
    isReady = vi.fn(() => false);
    element = vi.fn();
    constructor() {
      mocks.preloaders.push(this);
    }
  }
}));
vi.mock("../../src/ui/gesture", () => ({
  GestureController: class {
    destroy = vi.fn();
    constructor(public el: HTMLElement, public cb: Record<string, (...args: number[]) => unknown>) {
      mocks.gestures.push(this);
    }
  }
}));
vi.mock("../../src/shared/favorites", () => ({isFavorite: mocks.isFavorite, toggleFavorite: mocks.toggleFavorite}));

import {Viewer, type GifModule} from "../../src/ui/viewer";

const item = (n: number, type: MediaItem["type"] = "image", extra: Partial<MediaItem> = {}): MediaItem => ({
  id: `i${n}`, type, originalUrl: `https://x.test/o${n}`, previewUrl: `https://x.test/p${n}`, sourceUrl: `https://x.test/post/${n}`, filename: `f${n}`, score: 1, ...extra
});
const result = (count: number, patch: Partial<ScanResult> = {}): ScanResult => ({
  url: "https://forum.test/t/a/1", kind: "discourse", title: "Topic", complete: true, postsScanned: 10, totalPosts: 10,
  items: Array.from({length: count}, (_, n) => item(n)), diagnostics: {adapter: "x", ignored: 0, duplicates: 0, warnings: []}, ...patch
});
const flush = () => vi.advanceTimersByTimeAsync(0);
const budget = () => ({}) as Budget;

let store: Record<string, unknown>, messages: unknown[], gifModule: GifModule, gifPlayers: any[];
let viewer: Viewer;

function open(patch: Partial<LinkPeekSettings> = {}, startIndex?: number) {
  viewer.openLoading(100, 100, resolveSettings({...patch}), "Link title", startIndex);
  return viewer;
}
const q = <T extends Element = HTMLElement>(selector: string) => viewer.panel.querySelector<T>(selector);
const click = (action: string) => q(`[data-action="${action}"]`)!.dispatchEvent(new MouseEvent("click", {bubbles: true}));
const press = (key: string, init: KeyboardEventInit = {}) => viewer.key(new KeyboardEvent("keydown", {key, bubbles: true, composed: true, ...init}));
const preloader = () => mocks.preloaders.at(-1);
const gesture = () => mocks.gestures.at(-1);
const count = () => q(".lp-count")!.textContent;
const toast = () => q(".lp-toast")!.textContent;

beforeEach(() => {
  vi.useFakeTimers({toFake: ["setTimeout", "clearTimeout", "performance", "Date"]});
  document.documentElement.querySelectorAll(":scope > div").forEach(el => el.remove());
  mocks.preloaders.length = 0;
  mocks.gestures.length = 0;
  mocks.isFavorite.mockReset().mockResolvedValue(false);
  mocks.toggleFavorite.mockReset().mockResolvedValue({saved: true});
  store = {};
  messages = [];
  gifPlayers = [];
  gifModule = {
    GifPlayer: class {
      init = vi.fn(async () => undefined);
      destroy = vi.fn();
      key = vi.fn((event: KeyboardEvent) => event.key === " ");
      constructor(public stage: HTMLElement, public url: string, public settings: unknown, public notice: (m: string) => void) {
        gifPlayers.push(this);
      }
    } as unknown as GifModule["GifPlayer"],
    prepareGif: vi.fn(async () => undefined)
  };
  vi.stubGlobal("ResizeObserver", class {
    observe() {}
    disconnect() {}
  });
  vi.stubGlobal("requestAnimationFrame", vi.fn(() => 1));
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  vi.stubGlobal("chrome", {
    storage: {local: {set: vi.fn(async (values: Record<string, unknown>) => Object.assign(store, values))}},
    runtime: {getURL: (path: string) => path, sendMessage: vi.fn(async (msg: unknown) => (messages.push(msg), {id: 1}))}
  });
  vi.spyOn(window, "open").mockImplementation(() => null);
  viewer = new Viewer({budget, loadGifPlayer: async () => gifModule});
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("opening", () => {
  it("shows a loading panel next to the pointer, inside a shadow root", () => {
    open();
    expect(viewer.isOpen).toBe(true);
    expect(viewer.host.shadowRoot!.contains(viewer.panel)).toBe(true);
    expect(q(".lp-title")!.textContent).toBe("Link title");
    expect(q(".lp-loading")).not.toBeNull();
    expect(viewer.panel.style.left).toBe("112px");
    expect(viewer.panel.getAttribute("aria-label")).toBe("LinkPeek preview: Link title");
  });

  it("re-attaches itself if the page removed it", () => {
    viewer.host.remove();
    open();
    expect(viewer.host.isConnected).toBe(true);
  });

  it("starts in the remembered view, tile size and size, sanitizing what was stored", () => {
    viewer.restoreViewerState({view: "grid", gridThumbSize: 999, expanded: true, geometry: {left: 10, top: 20, width: 500, height: 400}});
    open();
    viewer.show(result(3));
    expect(viewer.view).toBe("grid");
    expect(viewer.panel.classList.contains("lp-expanded")).toBe(true);
    expect(q(".lp-tiles")!.textContent).toBe("320px tiles");
    viewer.restoreViewerState({view: "sideways" as never, gridThumbSize: Number.NaN});
    viewer.restoreViewerState(undefined);
  });

  it("uses the settings' starting view and style when nothing is remembered", () => {
    open({defaultView: "grid", startExpanded: true, thumbnailSize: 80, reducedMotion: true, transparency: 0.5, blur: 4});
    expect(viewer.view).toBe("grid");
    expect(viewer.panel.className).toBe("lp-panel lp-expanded lp-calm");
    expect(viewer.panel.style.background).toBe("rgba(17, 21, 18, 0.5)");
  });
});

describe("showing results", () => {
  it("renders the first result and checks whether the link is saved", async () => {
    mocks.isFavorite.mockResolvedValue(true);
    open().show(result(3, {title: undefined, url: "https://forum.test/t/a/1"}));
    expect(q(".lp-title")!.textContent).toBe("forum.test");
    expect(q(".lp-image")!.getAttribute("src")).toBe("https://x.test/p0");
    expect(count()).toBe("1 / 3");
    expect(preloader().reset).toHaveBeenCalled();
    await flush();
    expect(q("[data-action=favorite]")!.textContent).toBe("★");
  });

  it("removes media whose decoded width is below the configured minimum", () => {
    open({minWidth: 50}).show(result(2));
    const image = q<HTMLImageElement>(".lp-image")!;
    Object.defineProperty(image, "naturalWidth", {configurable: true, value: 45});
    image.dispatchEvent(new Event("load"));
    expect(viewer.result!.items.map(entry => entry.id)).toEqual(["i1"]);
    expect(count()).toBe("1 / 1");
    expect(q(".lp-image")!.getAttribute("src")).toBe("https://x.test/p1");
  });

  it("uses a decoded image when one is ready", () => {
    open();
    const decoded = document.createElement("img");
    preloader().isReady.mockReturnValue(true);
    preloader().element.mockReturnValue(decoded);
    viewer.show(result(2));
    expect(q(".lp-media")!.firstElementChild).toBe(decoded);
    expect(decoded.className).toBe("lp-image");
    expect(decoded.alt).toBe("f0");
  });

  it("merges progress for the same gallery without rebuilding the stage", () => {
    open().show(result(2, {complete: false, postsScanned: 2}));
    const stage = q(".lp-stage");
    viewer.show(result(4, {complete: false, postsScanned: 4}));
    expect(q(".lp-stage")).toBe(stage);
    expect(count()).toBe("1 / 4");
    expect(q(".lp-meta")!.textContent).toBe("4");
    viewer.show(result(4, {complete: false, postsScanned: 4}));
    viewer.show(result(4, {complete: true}));
    expect(q(".lp-signal")!.textContent).toBe("4 media · Complete");
    expect(viewer.result!.diagnostics).toBeDefined();
    viewer.show({...result(4), diagnostics: undefined});
  });

  it("swaps the media when a better copy replaces the current item", () => {
    open().show(result(2));
    viewer.show({...result(0), complete: false, items: [{...item(0), id: "better", score: 5}]});
    viewer.show({...result(1), items: [item(9, "image", {id: "i0", originalUrl: "https://x.test/o0", score: 9})]});
    expect(q(".lp-image")!.getAttribute("src")).toBe("https://x.test/p9");
  });

  it("starts fresh for a different gallery, and ignores results once closed", () => {
    open().show(result(2));
    viewer.show({...result(1), url: "https://forum.test/t/b/2", title: "Other"});
    expect(q(".lp-title")!.textContent).toBe("Other");
    viewer.close(true);
    viewer.show(result(5));
    expect(viewer.result).toBeUndefined();
  });

  it("keeps showing loading while a scan has found nothing yet, then explains an empty result", () => {
    open().show(result(0, {complete: false}));
    expect(q(".lp-loading")).not.toBeNull();
    viewer.show(result(0, {complete: true}));
    expect(q(".lp-empty")).not.toBeNull();
  });

  it("resumes where the gallery was left once that item arrives", () => {
    open({}, 3).show(result(2, {complete: false}));
    expect(count()).toBe("1 / 2");
    viewer.show(result(5, {complete: false}));
    expect(count()).toBe("4 / 5");
    open({}, 9).show(result(4));
    expect(count()).toBe("4 / 4");
    open({}, 0).show(result(4));
    expect(count()).toBe("1 / 4");
  });

  it("updates the grid and its progress bar while scanning", () => {
    viewer.restoreViewerState({view: "grid"});
    open().show(result(2, {complete: false, postsScanned: 1}));
    expect(q(".lp-grid-progress")!.textContent).toContain("1/10 posts");
    viewer.show(result(3, {complete: false, postsScanned: 2}));
    expect(q(".lp-grid-progress")!.textContent).toContain("2/10 posts");
    expect(viewer.panel.querySelectorAll(".lp-thumb")).toHaveLength(3);
    viewer.show(result(3, {complete: true}));
    expect(q(".lp-grid-progress")).toBeNull();
    viewer.show(result(4, {complete: true}));
  });
});

describe("errors", () => {
  it("replace an empty panel, but only toast over a gallery already shown", () => {
    open();
    viewer.error("<HTTP 500>");
    expect(q(".lp-error")!.textContent).toContain("<HTTP 500>");
    viewer.show(result(2));
    viewer.error("Timed out");
    expect(q(".lp-image")).not.toBeNull();
    expect(toast()).toBe("Timed out");
    viewer.close(true);
    viewer.error("late");
  });
});

describe("closing", () => {
  it("keeps a pinned panel open unless forced, and reports how it closed", () => {
    const dismissed: boolean[] = [];
    viewer.onDismiss = explicit => dismissed.push(explicit);
    open().show(result(2));
    click("pin");
    expect(viewer.pinned).toBe(true);
    viewer.close();
    expect(viewer.isOpen).toBe(true);
    viewer.close(true);
    expect([viewer.isOpen, viewer.pinned]).toEqual([false, false]);
    open();
    viewer.close();
    viewer.close();
    expect(dismissed).toEqual([true, false]);
    expect(preloader().dispose).toHaveBeenCalledTimes(2);
  });

  it("closes after a delay that the pointer can cancel by coming back", () => {
    open();
    viewer.scheduleClose(100);
    viewer.panel.dispatchEvent(new MouseEvent("mouseenter"));
    vi.advanceTimersByTime(200);
    expect(viewer.isOpen).toBe(true);
    viewer.panel.dispatchEvent(new MouseEvent("mouseleave"));
    vi.advanceTimersByTime(180);
    expect(viewer.isOpen).toBe(false);
  });

  it("stays open on leave when pinned, while being dragged, or in click mode", () => {
    open().show(result(1));
    viewer.pinned = true;
    viewer.scheduleClose(10);
    viewer.panel.dispatchEvent(new MouseEvent("mouseleave"));
    viewer.pinned = false;
    viewer.panel.classList.add("lp-manipulating");
    viewer.panel.dispatchEvent(new MouseEvent("mouseleave"));
    viewer.panel.classList.remove("lp-manipulating");
    open({activationMode: "click"});
    viewer.panel.dispatchEvent(new MouseEvent("mouseleave"));
    vi.advanceTimersByTime(1000);
    expect(viewer.isOpen).toBe(true);
  });
});

describe("the forgiving bridge", () => {
  it("counts the panel, its margin and the path from the link", () => {
    expect(viewer.containsPoint(0, 0)).toBe(false);
    open();
    viewer.panel.getBoundingClientRect = () => ({left: 200, top: 200, right: 400, bottom: 400, width: 200, height: 200, x: 200, y: 200, toJSON: () => ({})});
    const link = {left: 0, top: 0, right: 50, bottom: 20, width: 50, height: 20, x: 0, y: 0, toJSON: () => ({})} as DOMRect;
    expect(viewer.containsPoint(190, 300)).toBe(true);
    expect(viewer.containsPoint(100, 100)).toBe(false);
    expect(viewer.containsPoint(100, 100, link)).toBe(true);
    expect(viewer.containsPoint(500, 500, link)).toBe(false);
    open({magneticBridge: false});
    expect(viewer.containsPoint(100, 100, link)).toBe(false);
  });
});

describe("moving through media", () => {
  it("updates the counter at once and swaps the media when it is decoded", async () => {
    open().show(result(3));
    let release!: (ok: boolean) => void;
    preloader().ensure.mockImplementationOnce(() => new Promise(resolve => release = resolve));
    click("next");
    expect(count()).toBe("2 / 3");
    expect(q(".lp-image")!.getAttribute("src")).toBe("https://x.test/p0");
    vi.advanceTimersByTime(120);
    expect(q(".lp-stage")!.classList.contains("lp-busy")).toBe(true);
    release(true);
    await flush();
    expect(q(".lp-image")!.getAttribute("src")).toBe("https://x.test/p1");
    expect(q(".lp-stage")!.classList.contains("lp-busy")).toBe(false);
    expect(q(".lp-live")!.textContent).toBe("Media 2 of 3");
  });

  it("reports the position for resuming later", async () => {
    const positions: Array<[string, number]> = [];
    viewer.onPosition = (url, index) => positions.push([url, index]);
    open().show(result(3));
    click("next");
    await flush();
    expect(positions).toEqual([["https://forum.test/t/a/1", 1]]);
  });

  it("keeps only the latest of several quick moves", async () => {
    open().show(result(5));
    const releases: Array<(ok: boolean) => void> = [];
    preloader().ensure.mockImplementation(() => new Promise(resolve => releases.push(resolve)));
    click("next");
    click("next");
    expect(count()).toBe("3 / 5");
    releases[0](true);
    await flush();
    expect(q(".lp-image")!.getAttribute("src")).toBe("https://x.test/p0");
    releases[1](true);
    await flush();
    expect(q(".lp-image")!.getAttribute("src")).toBe("https://x.test/p2");
  });

  it("finishes a move even when progress arrives meanwhile, but not when the item changed", async () => {
    open().show(result(3, {complete: false}));
    let release!: (ok: boolean) => void;
    preloader().ensure.mockImplementationOnce(() => new Promise(resolve => release = resolve));
    click("next");
    viewer.show(result(6, {complete: false}));
    release(true);
    await flush();
    expect(count()).toBe("2 / 6");
    preloader().ensure.mockImplementationOnce(() => new Promise(resolve => release = resolve));
    click("next");
    viewer.show({...result(3), url: "https://forum.test/t/z/9"});
    release(true);
    await flush();
    expect(count()).toBe("1 / 3");
  });

  it("shows a helpful message when an image fails to load", async () => {
    open().show(result(2));
    preloader().ensure.mockResolvedValueOnce(false);
    click("next");
    await flush();
    expect(q(".lp-media-error")).not.toBeNull();
    click("open");
    expect(window.open).toHaveBeenCalledWith("https://x.test/o1", "_blank", "noopener");
  });

  it("wraps around, or stops at the ends with a note", async () => {
    open().show(result(2));
    click("previous");
    await flush();
    expect(count()).toBe("2 / 2");
    open({wrapAround: false}).show(result(2));
    click("previous");
    expect(toast()).toBe("First item");
    click("next");
    await flush();
    click("next");
    expect(toast()).toBe("Last item");
    open({wrapAround: false}).show(result(0));
    expect(press("ArrowDown")).toBe(true);
  });

  it("follows trackpad gestures, which stop a running slideshow", async () => {
    open().show(result(6));
    gesture().cb.next(2);
    await flush();
    expect(count()).toBe("3 / 6");
    gesture().cb.previous();
    await flush();
    gesture().cb.next();
    await flush();
    gesture().cb.scrub(-1);
    await flush();
    expect(count()).toBe("6 / 6");
    gesture().cb.scrub(1);
    await flush();
    expect(count()).toBe("3 / 6");
    gesture().cb.previous(2);
    await flush();
    expect(count()).toBe("1 / 6");
  });

  it("resets zoom for each item unless asked to keep it", async () => {
    open().show(result(3));
    viewer.applyZoom(2, 0, 0);
    click("next");
    await flush();
    expect(viewer.zoom).toBe(1);
    open({resetZoomPerImage: false}).show(result(3));
    viewer.applyZoom(2, 0, 0);
    click("next");
    await flush();
    expect(viewer.zoom).toBe(2);
  });
});

describe("the grid", () => {
  it("removes undersized images discovered while viewing the grid", () => {
    open({defaultView: "grid", minWidth: 50}).show(result(2));
    const image = q<HTMLImageElement>(".lp-thumb[data-i='0'] img")!;
    Object.defineProperty(image, "naturalWidth", {configurable: true, value: 45});
    image.dispatchEvent(new Event("load"));
    expect(viewer.result!.items.map(entry => entry.id)).toEqual(["i1"]);
    expect(q(".lp-meta")!.textContent).toBe("1");
    expect(viewer.panel.querySelectorAll(".lp-thumb")).toHaveLength(1);
  });

  it("opens scrolled to the current item and opens a tile in single view", async () => {
    open().show(result(30));
    click("next");
    await flush();
    click("grid");
    expect(viewer.view).toBe("grid");
    expect(q(".lp-thumb[aria-current=true]")!.dataset.i).toBe("1");
    expect(store.viewerState).toMatchObject({view: "grid"});
    q(".lp-thumb[data-i='3']")!.dispatchEvent(new MouseEvent("click", {bubbles: true}));
    expect(viewer.view).toBe("focus");
    expect(count()).toBe("4 / 30");
  });

  it("moves the selection with arrow keys, Home and End, and opens it with Enter", () => {
    open().show(result(10));
    press("g");
    expect(press("ArrowRight")).toBe(true);
    expect(press("ArrowDown")).toBe(true);
    expect(count()).toBe("3 / 10");
    expect(press("End")).toBe(true);
    expect(count()).toBe("10 / 10");
    expect(press("Home")).toBe(true);
    expect(press("ArrowLeft")).toBe(true);
    expect(count()).toBe("1 / 10");
    expect(press("ArrowRight", {ctrlKey: true})).toBe(false);
    expect(press("x")).toBe(false);
    expect(press("Enter")).toBe(true);
    expect(viewer.view).toBe("focus");
  });

  it("steps the selection with the next/previous keys and the buttons", async () => {
    open().show(result(5));
    press("g");
    click("next");
    expect(count()).toBe("2 / 5");
    press("p", {});
    click("previous");
    expect(count()).toBe("1 / 5");
  });

  it("resizes tiles with the buttons and the zoom keys", () => {
    open().show(result(5));
    press("g");
    click("grid-bigger");
    expect(toast()).toBe("136px tiles");
    click("grid-smaller");
    press("-");
    expect(q(".lp-tiles")!.textContent).toBe("104px tiles");
    press("+");
    expect(store.viewerState).toMatchObject({gridThumbSize: 120});
  });

  it("ignores grid keys while the gallery is empty", () => {
    viewer.restoreViewerState({view: "grid"});
    open().show(result(0, {complete: false}));
    expect(press("Home")).toBe(false);
    expect(count()).toBe("0 / 0");
  });
});

describe("keyboard", () => {
  it("never takes keys from the page's text fields", () => {
    open().show(result(2));
    const input = document.createElement("input");
    document.body.append(input);
    const event = new KeyboardEvent("keydown", {key: "g", bubbles: true});
    let handled: boolean | undefined;
    input.addEventListener("keydown", e => handled = viewer.key(e));
    input.dispatchEvent(event);
    expect(handled).toBe(false);
    viewer.close(true);
    expect(press("g")).toBe(false);
  });

  it("closes with Escape or the close key, and lets a GIF take its own keys first", async () => {
    open({shortcuts: {...DEFAULT_SHORTCUTS, close: ["q"]}}).show({...result(1), items: [item(0, "gif")]});
    await flush();
    expect(press(" ")).toBe(true);
    expect(gifPlayers[0].key).toHaveBeenCalled();
    expect(press("q")).toBe(true);
    expect(viewer.isOpen).toBe(false);
    open().show(result(1));
    expect(press("Escape")).toBe(true);
    expect(viewer.isOpen).toBe(false);
  });

  it("opens and closes the help sheet, which captures keys while open", () => {
    open().show(result(2));
    expect(press("?")).toBe(true);
    expect(q(".lp-help")).not.toBeNull();
    expect(q("[data-action=help]")!.getAttribute("aria-expanded")).toBe("true");
    expect(press("g")).toBe(false);
    expect(press("Escape")).toBe(true);
    expect(q(".lp-help")).toBeNull();
    click("help");
    q(".lp-help-close")!.dispatchEvent(new MouseEvent("click", {bubbles: true}));
    expect(viewer.help).toBe(false);
    press("?");
    expect(press("?")).toBe(true);
    press("?");
    expect(press("Escape")).toBe(true);
    expect(viewer.help).toBe(false);
  });

  it("runs every item action from its key", async () => {
    open().show(result(3));
    press("f");
    expect(viewer.panel.classList.contains("lp-expanded")).toBe(true);
    press("p");
    expect(viewer.pinned).toBe(true);
    press("o");
    expect(window.open).toHaveBeenCalledWith("https://x.test/o0", "_blank", "noopener");
    press("d");
    await flush();
    expect(messages).toEqual([{type: "LINKPEEK_DOWNLOAD", url: "https://x.test/o0", filename: "f0"}]);
    expect(toast()).toBe("Downloading…");
    press("b");
    await flush();
    expect(mocks.toggleFavorite).toHaveBeenCalled();
    press("=");
    expect(viewer.zoom).toBeCloseTo(1.2);
    press("-");
    expect(viewer.zoom).toBe(1);
    press("+");
    press("0");
    expect(viewer.zoom).toBe(1);
    press("ArrowDown");
    await flush();
    expect(count()).toBe("2 / 3");
    press("ArrowUp");
    await flush();
    expect(count()).toBe("1 / 3");
    expect(press("z")).toBe(false);
  });
});

describe("panel controls", () => {
  it("expands, restores and remembers", () => {
    open().show(result(2));
    click("expand");
    expect(store.viewerState).toMatchObject({expanded: true});
    expect(q("[data-resize]")).toBeNull();
    click("expand");
    expect(viewer.panel.classList.contains("lp-expanded")).toBe(false);
    expect(q("[data-resize]")).not.toBeNull();
  });

  it("downloads and copies, reporting failures", async () => {
    open().show(result(1));
    (chrome.runtime.sendMessage as ReturnType<typeof vi.fn>).mockResolvedValueOnce({error: "blocked"});
    click("download");
    await flush();
    expect(toast()).toBe("Download failed");
    (chrome.runtime.sendMessage as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("gone"));
    click("download");
    await flush();
    expect(toast()).toBe("Download failed");
    (chrome.runtime.sendMessage as ReturnType<typeof vi.fn>).mockResolvedValueOnce(undefined);
    click("download");
    await flush();
    expect(toast()).toBe("Downloading…");
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal("navigator", {clipboard: {writeText}});
    click("copy");
    await flush();
    expect(writeText).toHaveBeenCalledWith("https://x.test/o0");
    expect(toast()).toBe("Media link copied");
    writeText.mockRejectedValueOnce(new Error("denied"));
    click("copy");
    await flush();
    expect(toast()).toBe("Couldn’t copy the link");
  });

  it("opens the post an item came from", () => {
    open().show({...result(1), items: [item(0, "image", {postNumber: 4})]});
    click("post");
    expect(window.open).toHaveBeenCalledWith("https://x.test/post/0", "_blank", "noopener");
  });

  it("saves and unsaves the link, staying quiet about stale or failed updates", async () => {
    open().show(result(2));
    click("favorite");
    await flush();
    expect(q("[data-action=favorite]")!.textContent).toBe("★");
    expect(toast()).toBe("Link saved");
    mocks.toggleFavorite.mockResolvedValueOnce({saved: false});
    click("favorite");
    await flush();
    expect(toast()).toBe("Saved link removed");
    mocks.toggleFavorite.mockRejectedValueOnce(new Error("quota"));
    click("favorite");
    await flush();
    expect(toast()).toBe("Couldn’t update saved links");
    let finish!: (value: {saved: boolean}) => void;
    mocks.toggleFavorite.mockImplementationOnce(() => new Promise(resolve => finish = resolve));
    click("favorite");
    viewer.show({...result(1), url: "https://forum.test/t/other/2"});
    finish({saved: true});
    await flush();
    expect(q("[data-action=favorite]")!.textContent).toBe("☆");
  });

  it("ignores favorite checks that went stale or failed", async () => {
    let answer!: (value: boolean) => void;
    mocks.isFavorite.mockImplementationOnce(() => new Promise(resolve => answer = resolve));
    open().show(result(2));
    viewer.show({...result(1), url: "https://forum.test/t/other/2"});
    answer(true);
    await flush();
    expect(q("[data-action=favorite]")!.textContent).toBe("☆");
    mocks.isFavorite.mockRejectedValueOnce(new Error("storage"));
    open().show(result(2));
    await flush();
    viewer.close(true);
    await (viewer as unknown as {refreshFavorite: () => Promise<void>}).refreshFavorite();
  });

  it("does nothing for item actions while there is no item", () => {
    open().show(result(0));
    expect((viewer as unknown as {perform: (action: string) => boolean}).perform("open")).toBe(true);
    expect((viewer as unknown as {perform: (action: string) => boolean}).perform("download")).toBe(true);
    expect((viewer as unknown as {perform: (action: string) => boolean}).perform("copy")).toBe(true);
    expect((viewer as unknown as {perform: (action: string) => boolean}).perform("favorite")).toBe(true);
    expect((viewer as unknown as {perform: (action: string) => boolean}).perform("unknown")).toBe(false);
    expect(window.open).not.toHaveBeenCalled();
  });
});

describe("the slideshow", () => {
  it("advances on a timer and stops on any manual move", async () => {
    open({slideshowSeconds: 2}).show(result(3));
    click("slideshow");
    expect(toast()).toBe("Slideshow · every 2s");
    expect(q(".lp-signal")!.textContent).toBe("Slideshow · 2s");
    await vi.advanceTimersByTimeAsync(2000);
    expect(count()).toBe("2 / 3");
    click("next");
    await flush();
    await vi.advanceTimersByTimeAsync(5000);
    expect(count()).toBe("3 / 3");
    expect(q("[data-action=slideshow]")!.getAttribute("aria-pressed")).toBe("false");
  });

  it("can be stopped by its button, switches out of the grid, and ends at the last item without wrapping", async () => {
    viewer.restoreViewerState({view: "grid"});
    open({wrapAround: false, slideshowSeconds: 1}).show(result(2));
    press("s");
    expect(viewer.view).toBe("focus");
    press("s");
    expect(toast()).toBe("Slideshow stopped");
    press("s");
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(1000);
    expect(toast()).toBe("End of gallery");
    expect(q("[data-action=slideshow]")!.getAttribute("aria-pressed")).toBe("false");
  });

  it("does nothing for an empty gallery and stops quietly when the panel closes", async () => {
    open().show(result(0));
    click("slideshow");
    open().show(result(3));
    click("slideshow");
    viewer.close(true);
    await vi.advanceTimersByTimeAsync(10_000);
  });
});

describe("zoom", () => {
  it("zooms around a point, clamps to the maximum and resets past it", () => {
    open({maxZoom: 2}).show(result(1));
    viewer.applyZoom(2, 100, 50);
    expect([viewer.zoom, viewer.tx, viewer.ty]).toEqual([2, -100, -50]);
    expect(q(".lp-image")!.style.transform).toBe("translate(-100px, -50px) scale(2)");
    viewer.applyZoom(2, 0, 0);
    expect([viewer.zoom, viewer.tx]).toEqual([1, 0]);
    viewer.applyZoom(0.5, 0, 0);
    expect(viewer.zoom).toBe(1);
  });

  it("pans only while zoomed", () => {
    open().show(result(1));
    viewer.pan(10, 10);
    expect(viewer.tx).toBe(0);
    gesture().cb.zoom(2, 0, 0);
    expect(gesture().cb.isZoomed()).toBe(true);
    gesture().cb.pan(10, 5);
    expect([viewer.tx, viewer.ty]).toEqual([10, 5]);
  });

  it("does what the double-click setting says", async () => {
    open().show(result(3));
    gesture().cb.doubleClick(10, 10);
    expect(viewer.zoom).toBe(2);
    gesture().cb.doubleClick(10, 10);
    expect([viewer.zoom, toast()]).toEqual([1, "Fit"]);
    open({secondDoubleClick: "increase"}).show(result(3));
    viewer.onDoubleClick(0, 0);
    viewer.onDoubleClick(0, 0);
    expect(viewer.zoom).toBe(4);
    open({doubleClick: "next"}).show(result(3));
    viewer.onDoubleClick(0, 0);
    await flush();
    expect(count()).toBe("2 / 3");
    open({doubleClick: "fullscreen"}).show(result(3));
    viewer.panel.requestFullscreen = vi.fn(async () => undefined);
    viewer.onDoubleClick(0, 0);
    expect(viewer.panel.requestFullscreen).toHaveBeenCalled();
    Object.defineProperty(document, "fullscreenElement", {configurable: true, value: viewer.panel});
    document.exitFullscreen = vi.fn(async () => undefined);
    viewer.onDoubleClick(0, 0);
    expect(document.exitFullscreen).toHaveBeenCalled();
    Object.defineProperty(document, "fullscreenElement", {configurable: true, value: null});
    (viewer.panel as Partial<HTMLElement>).requestFullscreen = undefined;
    viewer.onDoubleClick(0, 0);
  });

  it("zooms from the keyboard around the middle of the stage", () => {
    open().show(result(1));
    viewer.key(new KeyboardEvent("keydown", {key: "+"}));
    expect(viewer.zoom).toBeCloseTo(1.2);
  });
});

describe("GIFs", () => {
  it("mounts the GIF player and prepares the next GIF ahead", async () => {
    open().show({...result(3), items: [item(0, "gif"), item(1, "gif"), item(2)]});
    await flush();
    expect(gifPlayers[0].url).toBe("https://x.test/o0");
    expect(gifPlayers[0].init).toHaveBeenCalled();
    expect(gifModule.prepareGif).toHaveBeenCalledWith("https://x.test/o1", 32);
    gifPlayers[0].notice("GIF too big");
    expect(toast()).toBe("GIF too big");
    click("next");
    await flush();
    expect(gifPlayers[0].destroy).toHaveBeenCalled();
    expect(gifPlayers[1].url).toBe("https://x.test/o1");
  });

  it("does not mount a GIF the person already moved away from", async () => {
    let resolveModule!: (module: GifModule) => void;
    viewer = new Viewer({budget, loadGifPlayer: () => new Promise(resolve => resolveModule = resolve)});
    open().show({...result(2), items: [item(0, "gif"), item(1)]});
    click("next");
    await flush();
    resolveModule(gifModule);
    await flush();
    expect(gifPlayers).toEqual([]);
  });

  it("falls back to native playback when the player cannot load", async () => {
    viewer = new Viewer({budget, loadGifPlayer: async () => {
      throw new Error("player failed");
    }});
    open().show({...result(1), items: [item(0, "gif", {originalUrl: `https://x.test/"a".gif`})]});
    await flush();
    expect(q(".lp-gif-fallback img")!.getAttribute("src")).toBe(`https://x.test/"a".gif`);
    expect(toast()).toBe("player failed");
    viewer = new Viewer({budget, loadGifPlayer: () => Promise.reject("nope")});
    open().show({...result(1), items: [item(0, "gif")]});
    await flush();
    expect(toast()).toBe("GIF controls unavailable");
  });

  it("drops a failed GIF load that went stale, and survives a failed preparation", async () => {
    let fail!: (error: Error) => void;
    viewer = new Viewer({budget, loadGifPlayer: () => new Promise((_, reject) => fail = reject)});
    open().show({...result(2), items: [item(0, "gif"), item(1)]});
    click("grid");
    fail(new Error("late"));
    await flush();
    expect(q(".lp-gif-fallback")).toBeNull();
    gifModule.prepareGif = vi.fn(async () => {
      throw new Error("decode");
    });
    viewer = new Viewer({budget, loadGifPlayer: async () => gifModule});
    open({wrapAround: false}).show({...result(2), items: [item(0), item(1, "gif")]});
    await flush();
    expect(gifModule.prepareGif).toHaveBeenCalled();
  });

  it("uses the real player module by default", async () => {
    viewer = new Viewer({budget});
    open().show({...result(1), items: [item(0, "gif")]});
    await vi.waitFor(() => expect(q(".lp-gif-fallback")).not.toBeNull());
  });
});

describe("moving and resizing the panel", () => {
  const down = (target: Element, init: MouseEventInit = {}) => target.dispatchEvent(new MouseEvent("pointerdown", {bubbles: true, cancelable: true, button: 0, ...init}));

  it("drags by the header and resizes by the edges, then remembers", () => {
    open().show(result(1));
    viewer.panel.getBoundingClientRect = () => ({left: 100, top: 100, width: 400, height: 300, right: 500, bottom: 400, x: 100, y: 100, toJSON: () => ({})});
    down(q(".lp-title")!, {clientX: 0, clientY: 0});
    window.dispatchEvent(new MouseEvent("pointermove", {clientX: 20, clientY: 10}));
    window.dispatchEvent(new MouseEvent("pointerup"));
    expect(store.viewerState).toMatchObject({geometry: {left: 120, top: 110}});
    down(q("[data-resize=se]")!, {clientX: 0, clientY: 0});
    window.dispatchEvent(new MouseEvent("pointermove", {clientX: 30, clientY: 30}));
    window.dispatchEvent(new MouseEvent("pointerup"));
    expect(store.viewerState).toMatchObject({geometry: {width: 430, height: 330}});
  });

  it("does not drag from buttons, other mouse buttons, an expanded panel or when turned off", () => {
    open().show(result(1));
    down(q("[data-action=pin]")!);
    down(q(".lp-title")!, {button: 2});
    down(q(".lp-stage")!);
    expect(viewer.panel.classList.contains("lp-manipulating")).toBe(false);
    open({draggablePanel: false, resizablePanel: false}).show(result(1));
    down(q(".lp-title")!);
    expect(q("[data-resize]")).toBeNull();
    click("expand");
    down(q(".lp-title")!);
    expect(viewer.panel.classList.contains("lp-manipulating")).toBe(false);
  });

  it("forgets the layout on a title double-click, and leaves geometry out when not remembering", () => {
    open().show(result(1));
    viewer.panel.getBoundingClientRect = () => ({left: 100, top: 100, width: 400, height: 300, right: 500, bottom: 400, x: 100, y: 100, toJSON: () => ({})});
    down(q(".lp-title")!, {clientX: 0, clientY: 0});
    window.dispatchEvent(new MouseEvent("pointerup"));
    q(".lp-title")!.dispatchEvent(new MouseEvent("dblclick", {bubbles: true}));
    expect(toast()).toBe("Panel layout reset");
    expect(store.viewerState).not.toHaveProperty("geometry");
    q(".lp-stage")!.dispatchEvent(new MouseEvent("dblclick", {bubbles: true}));
    open({rememberPanelGeometry: false}).show(result(1));
    q(".lp-title")!.dispatchEvent(new MouseEvent("dblclick", {bubbles: true}));
    expect(toast()).toBe("");
  });

  it("keeps a remembered layout on screen when the window shrinks", () => {
    viewer.restoreViewerState({geometry: {left: 900, top: 10, width: 400, height: 300}});
    open().show(result(1));
    window.dispatchEvent(new Event("resize"));
    expect(viewer.panel.style.left).toBe(`${innerWidth - 8 - 400}px`);
    click("expand");
    window.dispatchEvent(new Event("resize"));
    viewer.close(true);
    window.dispatchEvent(new Event("resize"));
  });

  it("survives storage that is gone after an extension reload", () => {
    open().show(result(1));
    (chrome.storage.local.set as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
      throw new Error("Extension context invalidated");
    });
    click("grid");
    (chrome.storage.local.set as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("quota"));
    click("grid");
    expect(viewer.view).toBe("focus");
  });
});

describe("toasts", () => {
  it("fade after a moment and are skipped while closed", () => {
    open().show(result(1));
    viewer.toast("Hello");
    expect(q(".lp-toast")!.classList.contains("lp-on")).toBe(true);
    vi.advanceTimersByTime(900);
    expect(q(".lp-toast")!.classList.contains("lp-on")).toBe(false);
    viewer.close(true);
    viewer.toast("Nobody sees this");
  });

  it("keeps defensive fallbacks harmless when optional UI state disappears", async () => {
    open().show(result(1, {url: "not a url", title: "", postsScanned: undefined, totalPosts: undefined}));
    expect(q(".lp-title")!.textContent).toBe("not a url");

    press("p");
    press("p");
    expect(toast()).toBe("Unpinned");

    press("g");
    (viewer as any).grid = undefined;
    expect(press("ArrowDown")).toBe(true);
    press("g");

    (viewer as any).stage = undefined;
    expect((viewer as any).perform("zoomOut")).toBe(true);
    expect((viewer as any).perform("close")).toBe(true);

    open().show({...result(1), items: [item(0, "gif")]});
    press("?");
    expect(q(".lp-help")!.textContent).toContain("GIF");
    (viewer as any).render();
    press("Escape");

    const decoded = document.createElement("img");
    preloader().isReady.mockReturnValue(true);
    preloader().element.mockReturnValue(decoded);
    viewer.show({...result(1), url: "https://forum.test/other", items: [item(0, "image", {filename: ""})]});
    expect(decoded.alt).toBe("Preview image");

    q(".lp-meta")!.remove();
    (viewer as any).updateChrome();
    q(".lp-media")!.remove();
    (viewer as any).showFocusMedia();

    viewer.close(true);
    await (viewer as any).prepareNextGif();
    (viewer as any).slideshow = true;
    (viewer as any).stopSlideshow();
    await (viewer as any).toggleFavorite();
    open().show(result(1));
    click("slideshow");
    (viewer as any).result = undefined;
    await vi.advanceTimersByTimeAsync(3000);
    (viewer as any).updateChrome();
    open().show(result(1));
    q(".lp-toast")!.remove();
    viewer.toast("gone");
  });
});
