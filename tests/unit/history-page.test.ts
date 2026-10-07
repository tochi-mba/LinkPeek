import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";

/** A stand-in rubber band: it records the calls and hands the test its callbacks. */
const bands = vi.hoisted(() => ({all: [] as any[]}));
vi.mock("dragselect", () => ({default: class {
  callbacks = new Map<string, (data: {items: HTMLElement[]}) => void>();
  addSelection = vi.fn();
  removeSelection = vi.fn();
  setSettings = vi.fn();
  stop = vi.fn();
  constructor(public options: unknown) {
    bands.all.push(this);
  }
  subscribe(name: string, callback: (data: {items: HTMLElement[]}) => void) {
    this.callbacks.set(name, callback);
  }
}}));
/** The still maker, under each test's control (jsdom can decode neither GIFs nor video). */
const stillMaker = vi.hoisted(() => ({gif: vi.fn(), video: vi.fn()}));
vi.mock("../../src/pages/stills", async () => ({
  ...await vi.importActual<typeof import("../../src/pages/stills")>("../../src/pages/stills"),
  gifStill: stillMaker.gif,
  videoStill: stillMaker.video
}));
import {HISTORY_META, HISTORY_PREFIX, LIBRARY_CACHE, STILLS_CACHE, type HistoryEntry} from "../../src/shared/history";
import {fakeCaches} from "./fake-caches";
import {loadPage, stubExtension, type PageHarness} from "./page-harness";

/** Timers are fake here (the clear button waits three seconds), so settling advances them instead of waiting. */
async function settle() {
  for (let i = 0; i < 10; i++) await Promise.resolve();
  await vi.advanceTimersByTimeAsync(0);
}

let harness: PageHarness, observed: Array<(entries: Array<{isIntersecting: boolean}>) => void>;
const DAY = 86_400_000;
const entry = (n: number, at: number, patch: Partial<HistoryEntry> = {}): HistoryEntry => ({a: at, o: `https://cdn.test/${n}.jpg`, p: `https://cdn.test/${n}-s.jpg`, t: "image", s: `https://forum.test/t/${n}`, n: `Post ${n}`, ...patch});
const $ = <T extends HTMLElement = HTMLElement>(selector: string) => document.querySelector<T>(selector)!;

async function open(entries: HistoryEntry[] | null) {
  vi.resetModules();
  loadPage("history.html");
  harness = stubExtension({});
  if (entries) {
    harness.store[HISTORY_META] = {first: 0, last: 0};
    harness.store[`${HISTORY_PREFIX}0`] = entries;
  }
  await import("../../src/pages/history");
  await settle();
}

beforeEach(() => {
  vi.useFakeTimers({toFake: ["Date", "setTimeout", "clearTimeout"]});
  vi.setSystemTime(new Date(2026, 9, 6, 12, 0));
  observed = [];
  // Unless a test says otherwise, no still can be made, and nothing reaches the real web.
  stillMaker.gif.mockReset().mockRejectedValue(new Error("no decoder"));
  stillMaker.video.mockReset().mockRejectedValue(new Error("no decoder"));
  vi.stubGlobal("fetch", vi.fn(async () => new Response(new Uint8Array(4), {headers: {"content-type": "image/gif"}})));
  vi.stubGlobal("IntersectionObserver", class {
    constructor(callback: (entries: Array<{isIntersecting: boolean}>) => void) {
      observed.push(callback);
    }
    observe() {}
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("the history page", () => {
  it("lists what was seen newest first, by day, with links to the original and the post", async () => {
    const now = Date.now();
    await open([entry(0, now - 500 * DAY, {p: ""}), entry(1, now - 400 * DAY), entry(2, now - 3 * DAY), entry(3, now - DAY), entry(4, now - 60_000, {t: "gif"}), entry(5, now, {t: "video", p: "", n: undefined})]);
    expect([...document.querySelectorAll(".h-day h2")].map(h => h.textContent)).toEqual(["Today", "Yesterday", expect.stringMatching(/\w/), expect.stringMatching(/2025/), expect.stringMatching(/2025/)]);
    const tiles = [...document.querySelectorAll(".h-tile")];
    expect(tiles).toHaveLength(6);
    expect(tiles[5].querySelector(".h-none")!.textContent).toBe("No preview");
    // A video with no poster and no still to be made shows itself, paused at its stable point.
    await settle();
    expect(tiles[0].querySelector("video.h-still")!.getAttribute("src")).toMatch(/^https:\/\/cdn\.test\/5\.jpg#t=\d\.\d$/);
    expect(tiles[0].querySelector("figcaption a")!.textContent).toBe("5");
    expect(tiles[1].querySelector(".h-badge")!.textContent).toBe("GIF");
    expect(tiles[1].querySelector<HTMLAnchorElement>(".h-media")!.getAttribute("href")).toBe("https://cdn.test/4.jpg");
    expect($("#summary").textContent).toBe("6 items, newest first");
    const search = $<HTMLInputElement>("#search");
    search.value = "forum.test/t/5";
    search.dispatchEvent(new Event("input"));
    expect(document.querySelectorAll(".h-tile")).toHaveLength(1);
  });

  it("grows as it scrolls, and searches titles and addresses", async () => {
    const now = Date.now();
    await open(Array.from({length: 300}, (_, i) => entry(i, now - i * 1000)));
    expect(document.querySelectorAll(".h-tile")).toHaveLength(240);
    observed[0]([{isIntersecting: false}]);
    expect(document.querySelectorAll(".h-tile")).toHaveLength(240);
    observed[0]([{isIntersecting: true}]);
    expect(document.querySelectorAll(".h-tile")).toHaveLength(300);
    observed[0]([{isIntersecting: true}]);
    const search = $<HTMLInputElement>("#search");
    search.value = "post 129";
    search.dispatchEvent(new Event("input"));
    expect($("#summary").textContent).toBe("1 of 300 match “post 129”");
    search.value = "";
    search.dispatchEvent(new Event("input"));
    expect($("#summary").textContent).toBe("300 items, newest first");
  });

  it("warns with exact numbers before clearing, forgets the warning when it lapses, then clears", async () => {
    await open(null);
    expect($("#summary").textContent).toBe("Nothing here yet. What you open in LinkPeek appears here, newest first.");
    await open([entry(1, Date.now())]);
    expect($("#summary").textContent).toBe("1 item, newest first");
    const clear = $<HTMLButtonElement>("#clear");
    clear.click();
    await settle();
    expect(clear.textContent).toBe("Press again to clear");
    // The warning says exactly what will go, and is taken back when the press lapses.
    expect($("#summary").textContent).toBe("About to clear the whole history: 1 entry. Saved files stay.");
    vi.advanceTimersByTime(3001);
    expect(clear.textContent).toBe("Clear history");
    expect($("#summary").textContent).toBe("1 item, newest first");
    clear.click();
    clear.click();
    await settle();
    expect(harness.chrome.runtime.sendMessage).toHaveBeenCalledWith({type: "LINKPEEK_HISTORY_CLEAR"});
    expect(document.querySelectorAll(".h-tile")).toHaveLength(0);
    expect(clear.textContent).toBe("Clear history");
  });

  it("opens even when storage cannot be read", async () => {
    vi.resetModules();
    loadPage("history.html");
    harness = stubExtension({});
    harness.chrome.storage.local.get = vi.fn(async () => Promise.reject(new Error("gone")));
    await import("../../src/pages/history");
    await settle();
    expect($("#summary").textContent).toMatch(/Nothing here yet/);
  });
});

describe("saved media on the history page", () => {
  const view = () => document.getElementById("view")!;
  const stageMedia = () => document.querySelector<HTMLImageElement | HTMLVideoElement>("#viewStage img, #viewStage video");
  let downloads: ReturnType<typeof vi.fn>;

  async function openSaved(entries: HistoryEntry[], savedUrls: string[]) {
    const api = fakeCaches();
    const cache = await api.open(LIBRARY_CACHE);
    for (const url of savedUrls) await cache.put(url, new Response("bytes"));
    let blobs = 0;
    vi.stubGlobal("URL", Object.assign(URL, {createObjectURL: vi.fn(() => `blob:saved-${++blobs}`)}));
    history.replaceState(null, "", "/history.html");
    vi.resetModules();
    loadPage("history.html");
    harness = stubExtension({});
    harness.store[HISTORY_META] = {first: 0, last: 0};
    harness.store[`${HISTORY_PREFIX}0`] = entries;
    downloads = vi.fn(async () => 1);
    harness.chrome.downloads = {download: downloads};
    harness.chrome.runtime.sendMessage.mockImplementation(async (msg: {type: string}) => msg.type === "LINKPEEK_LIBRARY_STATS" ? {count: savedUrls.length, bytes: 5 * 1024 * 1024} : {ok: true});
    await import("../../src/pages/history");
    await settle();
  }

  it("shows thumbnails from the saved copies, and from the web where there are none", async () => {
    const now = Date.now();
    await openSaved([entry(2, now - 1000), entry(1, now, {t: "gif"})], ["https://cdn.test/2-s.jpg"]);
    await settle();
    // The GIF's still could not be made here, so the site's own preview stands in.
    const images = [...document.querySelectorAll<HTMLImageElement>(".h-tile img")];
    expect(images.map(image => image.getAttribute("src"))).toEqual(["https://cdn.test/1-s.jpg", "blob:saved-1"]);
    // The history view is a diary, not a disk: no storage gauge here.
    expect($("#progress").hidden).toBe(true);
  });

  it("opens an item full size, steps through by keys, scroll and mouse buttons, saves it, and closes", async () => {
    const now = Date.now();
    await openSaved([entry(3, now - 2000, {t: "video", p: "", n: undefined}), entry(2, now - 1000), entry(1, now)], ["https://cdn.test/2-s.jpg"]);
    document.querySelector<HTMLElement>('[data-index="0"]')!.dispatchEvent(new MouseEvent("click", {bubbles: true, cancelable: true, button: 0}));
    await settle();
    expect(view().hidden).toBe(false);
    expect(stageMedia()!.getAttribute("src")).toBe("https://cdn.test/1.jpg");
    expect($("#viewMeta").textContent).toMatch(/^1 of 3 · /);
    document.dispatchEvent(new KeyboardEvent("keydown", {key: "ArrowRight"}));
    await settle();
    expect(stageMedia()!.getAttribute("src")).toBe("blob:saved-1");
    expect($("#viewMeta").textContent).toMatch(/saved on this device$/);
    view().dispatchEvent(new WheelEvent("wheel", {deltaY: 100, cancelable: true}));
    await settle();
    expect(stageMedia()!.tagName).toBe("VIDEO");
    expect($("#viewTitle").textContent).toBe("3");
    vi.advanceTimersByTime(300);
    view().dispatchEvent(new WheelEvent("wheel", {deltaY: -100, cancelable: true}));
    await settle();
    expect($("#viewMeta").textContent).toMatch(/^2 of 3/);
    view().dispatchEvent(new MouseEvent("mouseup", {button: 4, bubbles: true}));
    await settle();
    expect(stageMedia()!.tagName).toBe("VIDEO");
    downloads.mockRejectedValueOnce(new Error("blocked"));
    $("#viewSave").click();
    await settle();
    expect(downloads).toHaveBeenLastCalledWith(expect.objectContaining({url: "https://cdn.test/3.jpg"}));
    view().dispatchEvent(new WheelEvent("wheel", {deltaY: 100, cancelable: true}));
    view().dispatchEvent(new WheelEvent("wheel", {deltaY: 0, cancelable: true}));
    view().dispatchEvent(new MouseEvent("mouseup", {button: 3, bubbles: true}));
    await settle();
    expect($("#viewMeta").textContent).toMatch(/^2 of 3/);
    view().dispatchEvent(new MouseEvent("mouseup", {button: 0, bubbles: true}));
    document.querySelector<HTMLButtonElement>('[data-view="next"]')!.click();
    document.querySelector<HTMLButtonElement>('[data-view="prev"]')!.click();
    await settle();
    $("#viewSave").click();
    await settle();
    expect(downloads).toHaveBeenLastCalledWith(expect.objectContaining({url: "blob:saved-1", filename: expect.stringMatching(/^LinkPeek Library\/\d{4}-\d\d-\d\d\/\d\d\.\d\d\.\d\d 2-s\.jpg$/)}));
    document.dispatchEvent(new KeyboardEvent("keydown", {key: "x"}));
    document.dispatchEvent(new KeyboardEvent("keydown", {key: "Escape"}));
    expect(view().hidden).toBe(true);
    document.dispatchEvent(new KeyboardEvent("keydown", {key: "ArrowRight"}));
    view().dispatchEvent(new WheelEvent("wheel", {deltaY: 100}));
    document.querySelector<HTMLElement>('[data-index="1"]')!.dispatchEvent(new MouseEvent("click", {bubbles: true, cancelable: true, ctrlKey: true}));
    expect(view().hidden).toBe(true);
    document.querySelector<HTMLElement>('[data-index="1"]')!.dispatchEvent(new MouseEvent("click", {bubbles: true, cancelable: true}));
    await settle();
    view().dispatchEvent(new MouseEvent("click", {bubbles: true}));
    expect(view().hidden).toBe(true);
    document.querySelector<HTMLElement>('[data-index="1"]')!.dispatchEvent(new MouseEvent("click", {bubbles: true, cancelable: true}));
    await settle();
    document.querySelector<HTMLButtonElement>('[data-view="close"]')!.click();
    expect(view().hidden).toBe(true);
    $("#days").dispatchEvent(new MouseEvent("click", {bubbles: true}));
  });

  it("saves picked files into Downloads from the selection bar, web originals where no copy is kept", async () => {
    const now = Date.now();
    await openSaved([entry(3, now - 2000), entry(2, now - 1000), entry(1, now)], ["https://cdn.test/2-s.jpg", "https://cdn.test/1-s.jpg"]);
    document.querySelectorAll<HTMLButtonElement>("[data-pick]")[0].click();
    await settle();
    $("#selAll").click();
    await settle();
    $("#selSave").click();
    await settle();
    expect(downloads).toHaveBeenCalledTimes(3);
    expect(downloads.mock.calls.map(([options]: any[]) => options.url)).toEqual(["blob:saved-1", "blob:saved-2", "https://cdn.test/3.jpg"]);
    expect([$("#summary").textContent, $("#selbar").hidden]).toEqual(["Saved 3 to Downloads / LinkPeek Library", true]);
  });
});

describe("the saved view", () => {
  const LIB = "mediaIndex";
  const chip = (selector: string) => document.querySelector<HTMLButtonElement>(selector)!;

  async function openLibrary(index: unknown, search = "") {
    const api = fakeCaches();
    vi.stubGlobal("URL", Object.assign(URL, {createObjectURL: vi.fn(() => "blob:saved")}));
    history.replaceState(null, "", `/history.html${search}`);
    vi.resetModules();
    loadPage("history.html");
    harness = stubExtension({});
    harness.store[LIB] = index;
    await import("../../src/pages/history");
    await settle();
    return api;
  }

  it("opens straight on what was preloaded and not seen yet, from the address", async () => {
    const now = Date.now();
    await openLibrary([
      ["https://cdn.test/new.jpg", {bytes: 1, at: now, seen: false, type: "image", source: "https://forum.test/a", title: "Prepared"}],
      ["https://cdn.test/old.jpg", {bytes: 1, at: now - 1000}],
      ["https://cdn.test/clip.mp4", {bytes: 1, at: now - 2000, seen: false, type: "video", source: "https://forum.test/b", preview: "https://cdn.test/clip.jpg", original: "https://cdn.test/clip.mp4"}],
      ["https://cdn.test/anim.gif", {bytes: 1, at: now - 3000, seen: true}]
    ], "?view=saved&filter=unseen");
    expect([chip('[data-show="saved"]').getAttribute("aria-pressed"), chip('[data-filter="unseen"]').getAttribute("aria-pressed"), $("#filters").hidden]).toEqual(["true", "true", false]);
    const tiles = [...document.querySelectorAll(".h-tile")];
    expect(tiles.map(t => t.querySelector("figcaption a")!.textContent)).toEqual(["Prepared", "b"]);
    expect(tiles.every(t => t.querySelector(".h-new")!.textContent === "Not seen yet")).toBe(true);
    expect(tiles[1].querySelector("img")!.getAttribute("src")).toBe("https://cdn.test/clip.jpg");
    expect($("#summary").textContent).toBe("2 files, newest first · 1 KB on this device");
    expect($("#clear").textContent).toBe("Delete saved files");
    // The gauge shows how much of the budget the saved files use.
    expect($("#progress").hidden).toBe(false);
    expect($("#progress").title).toContain("of the 2.0 GB");
    expect(document.getElementById("progressFill")!.style.width).toBe("0%");
  });

  it("switches views and filters, keeping them in the address", async () => {
    const now = Date.now();
    await openLibrary([["https://cdn.test/a.jpg", {bytes: 1, at: now, seen: true}], ["https://cdn.test/anim.gif", {bytes: 1, at: now - 5, seen: false}]]);
    expect([$("#filters").hidden, $("#clear").textContent]).toEqual([true, "Clear history"]);
    chip('[data-show="saved"]').click();
    await settle();
    expect([location.search, document.querySelectorAll(".h-tile").length]).toEqual(["?view=saved", 2]);
    expect(document.querySelector(".h-badge")!.textContent).toBe("GIF");
    chip('[data-filter="seen"]').click();
    await settle();
    expect([location.search, document.querySelectorAll(".h-tile").length]).toEqual(["?view=saved&filter=seen", 1]);
    chip('[data-filter="unseen"]').click();
    await settle();
    expect(document.querySelectorAll(".h-tile").length).toBe(1);
    document.querySelector<HTMLElement>(".history-head h1")!.click();
    chip('[data-show="seen"]').click();
    await settle();
    expect(location.search).toBe("");
  });

  it("explains an empty library or an empty preloaded list, and deletes saved media after a second press", async () => {
    await openLibrary(undefined, "?view=saved");
    expect($("#summary").textContent).toMatch(/^Nothing is saved on this device yet/);
    await openLibrary([["https://cdn.test/a.jpg", {bytes: 1, at: Date.now(), seen: true}]], "?view=saved&filter=unseen");
    expect($("#summary").textContent).toBe("Nothing preloaded is waiting: everything saved has been seen.");
    chip('[data-filter="all"]').click();
    await settle();
    $("#clear").click();
    await settle();
    expect($("#clear").textContent).toBe("Press again to delete");
    expect($("#summary").textContent).toBe("About to delete every saved file: 1 file (1 KB), Downloads copies included.");
    $("#clear").click();
    await settle();
    expect(harness.chrome.runtime.sendMessage).toHaveBeenCalledWith({type: "LINKPEEK_LIBRARY_CLEAR"});
    expect(document.querySelectorAll(".h-tile")).toHaveLength(0);
    expect($("#clear").textContent).toBe("Delete saved files");
    await openLibrary("corrupt", "?view=saved&filter=bogus");
    expect(chip('[data-filter="all"]').getAttribute("aria-pressed")).toBe("true");
  });

  it("filters by kind of media in both views, keeping it in the address", async () => {
    const now = Date.now();
    await openLibrary([
      ["https://cdn.test/a.jpg", {bytes: 1, at: now, seen: true, type: "image"}],
      ["https://cdn.test/anim.gif", {bytes: 1, at: now - 5, seen: true, type: "gif"}],
      ["https://cdn.test/clip.mp4", {bytes: 1, at: now - 9, seen: true, type: "video"}]
    ], "?view=saved&media=gif");
    expect([chip('[data-kind="gif"]').getAttribute("aria-pressed"), document.querySelectorAll(".h-tile").length]).toEqual(["true", 1]);
    expect($("#summary").textContent).toBe("1 GIF, newest first · 1 KB on this device");
    chip('[data-kind="video"]').click();
    await settle();
    expect([location.search, document.querySelectorAll(".h-tile").length]).toEqual(["?view=saved&media=video", 1]);
    chip('[data-show="seen"]').click();
    await settle();
    // The kind follows across views; the history holds no videos at all.
    expect([location.search, $("#summary").textContent]).toEqual(["?media=video", "No videos in the history yet."]);
    // The check covers every saved file, so it is on hand in both views.
    expect($("#audit").hidden).toBe(false);
    chip('[data-kind="all"]').click();
    await settle();
    expect(location.search).toBe("");
    await openLibrary([["https://cdn.test/a.jpg", {bytes: 1, at: now, seen: true, type: "image"}]], "?view=saved&media=video");
    expect($("#summary").textContent).toBe("No videos among the saved files yet.");
  });

  it("checks the saved files on request and reports what was done", async () => {
    await openLibrary([["https://cdn.test/tiny.jpg", {bytes: 1, at: Date.now(), seen: false, type: "image"}]], "?view=saved");
    expect($("#audit").hidden).toBe(false);
    harness.chrome.runtime.sendMessage.mockImplementation(async (msg: {type: string}) => {
      if (msg.type !== "LINKPEEK_LIBRARY_AUDIT") return {ok: true};
      harness.store[LIB] = [];
      return {checked: 1, removed: 1, mirrored: 0};
    });
    $("#audit").click();
    await settle();
    expect($("#summary").textContent).toBe("Checked every saved file: removed 1 below your minimum size, added 0 to Downloads / LinkPeek Library.");
    expect(document.querySelectorAll(".h-tile")).toHaveLength(0);
    // When the worker cannot answer, the page says so instead of staying stuck on "checking".
    harness.chrome.runtime.sendMessage.mockRejectedValueOnce(new Error("gone"));
    $("#audit").click();
    await settle();
    expect($("#summary").textContent).toBe("Couldn’t check the saved files.");
  });

  it("shows a saved file's measurements, and skips files already in Downloads when saving all", async () => {
    const now = Date.now();
    const api = await openLibrary([
      ["https://cdn.test/a.jpg", {bytes: 2 * 1024 * 1024, at: now, seen: true, type: "image", w: 1920, h: 1080, dl: 5}],
      ["https://cdn.test/b.jpg", {bytes: 512, at: now - 5, seen: true, type: "image"}]
    ], "?view=saved");
    const cache = await api.open(LIBRARY_CACHE);
    await cache.put("https://cdn.test/a.jpg", new Response("bytes"));
    await cache.put("https://cdn.test/b.jpg", new Response("bytes"));
    const download = vi.fn(async (options: {filename: string}) => options && 1);
    harness.chrome.downloads = {download, search: vi.fn(async () => [{id: 5, exists: true}, {id: 9, exists: false}])};
    document.querySelector<HTMLElement>('[data-index="0"]')!.dispatchEvent(new MouseEvent("click", {bubbles: true, cancelable: true, button: 0}));
    await settle();
    expect($("#viewMeta").textContent).toMatch(/^1 of 2 · 1920×1080 · 2\.0 MB · /);
    document.dispatchEvent(new KeyboardEvent("keydown", {key: "Escape"}));
    // A thumbnail that knows its shape reserves it, so the collage never jumps.
    expect(document.querySelector('[data-row="0"] img')!.getAttribute("style")).toContain("aspect-ratio: 1920 / 1080");
    document.querySelector<HTMLElement>('[data-index="0"]')!.dispatchEvent(new MouseEvent("click", {bubbles: true, cancelable: true, button: 0}));
    await settle();
    document.dispatchEvent(new KeyboardEvent("keydown", {key: "ArrowRight"}));
    await settle();
    expect($("#viewMeta").textContent).toMatch(/^2 of 2 · 1 KB · /);
    document.dispatchEvent(new KeyboardEvent("keydown", {key: "Escape"}));
    $("#select").click();
    $("#selAll").click();
    await settle();
    $("#selSave").click();
    await settle();
    expect(download).toHaveBeenCalledTimes(1);
    expect(download.mock.calls[0][0]).toMatchObject({filename: expect.stringContaining("b.jpg")});
    expect($("#summary").textContent).toBe("Saved 1 to Downloads / LinkPeek Library (1 already there)");
    // With nothing picked, the save button does nothing.
    $("#select").click();
    $("#selSave").click();
    await settle();
    expect(download).toHaveBeenCalledTimes(1);
  });

  it("says when everything picked is already in Downloads", async () => {
    const api = await openLibrary([["https://cdn.test/a.jpg", {bytes: 9, at: Date.now(), seen: true, type: "image", dl: 5}]], "?view=saved");
    await (await api.open(LIBRARY_CACHE)).put("https://cdn.test/a.jpg", new Response("bytes"));
    harness.chrome.downloads = {download: vi.fn(), search: vi.fn(async () => [{id: 5, exists: true}])};
    document.querySelector<HTMLButtonElement>("[data-pick]")!.click();
    await settle();
    $("#selSave").click();
    await settle();
    expect([$("#summary").textContent, $("#selbar").hidden]).toEqual(["Everything picked is already in Downloads / LinkPeek Library.", true]);
    expect(harness.chrome.downloads.download).not.toHaveBeenCalled();
  });
});

describe("selecting many at once, and the live check line", () => {
  const LIB = "mediaIndex";
  const chip = (selector: string) => document.querySelector<HTMLButtonElement>(selector)!;

  async function openLibrary(index: unknown, search = "") {
    bands.all.length = 0;
    fakeCaches();
    vi.stubGlobal("URL", Object.assign(URL, {createObjectURL: vi.fn(() => "blob:saved")}));
    history.replaceState(null, "", `/history.html${search}`);
    vi.resetModules();
    loadPage("history.html");
    harness = stubExtension({});
    harness.store[LIB] = index;
    await import("../../src/pages/history");
    await settle();
  }

  const rows = () => {
    const now = Date.now();
    return [
      ["https://cdn.test/a.jpg", {bytes: 1, at: now - 1, seen: true, type: "image", title: "First one"}],
      ["https://cdn.test/b.jpg", {bytes: 1, at: now - 2, seen: true, type: "image", title: "Second one"}],
      ["https://cdn.test/c.gif", {bytes: 1, at: now - 3, seen: true, type: "gif", title: "Third one"}]
    ];
  };
  const pick = (at: number) => document.querySelectorAll<HTMLButtonElement>("[data-pick]")[at];
  const tile = (at: number) => document.querySelectorAll<HTMLElement>(".h-tile")[at];

  it("selects by checkmark, drag or ctrl-click, counts in the bar, and leaves on Escape or Cancel", async () => {
    await openLibrary(rows(), "?view=saved");
    expect($("#selbar").hidden).toBe(true);
    pick(0).click();
    await settle();
    expect([$("#selbar").hidden, $("#selCount").textContent]).toEqual([false, "1 selected"]);
    expect(tile(0).classList.contains("h-selected")).toBe(true);
    expect(document.body.classList.contains("h-selecting")).toBe(true);
    const band = bands.all[0];
    expect(band.addSelection).toHaveBeenCalledWith(tile(0));
    // The same checkmark unpicks.
    pick(0).click();
    await settle();
    expect([$("#selCount").textContent, tile(0).classList.contains("h-selected")]).toEqual(["0 selected", false]);
    expect(band.removeSelection).toHaveBeenCalledWith(tile(0));
    // A drag of the band settles the whole selection.
    band.callbacks.get("DS:end")!({items: [tile(1), tile(2)]});
    expect($("#selCount").textContent).toBe("2 selected");
    // Select all, then Escape leaves the mode entirely.
    $("#selAll").click();
    expect($("#selCount").textContent).toBe("3 selected");
    document.dispatchEvent(new KeyboardEvent("keydown", {key: "Escape"}));
    expect([$("#selbar").hidden, band.stop.mock.calls.length, document.body.classList.contains("h-selecting")]).toEqual([true, 1, false]);
    // Ctrl-click on a tile starts selecting instead of opening.
    tile(1).querySelector<HTMLElement>("[data-index]")!.dispatchEvent(new MouseEvent("click", {bubbles: true, cancelable: true, ctrlKey: true}));
    await settle();
    expect([$("#view").hidden, $("#selCount").textContent]).toEqual([true, "1 selected"]);
    // In the mode, a plain click on a tile toggles it too.
    tile(2).querySelector<HTMLElement>("[data-index]")!.dispatchEvent(new MouseEvent("click", {bubbles: true, cancelable: true, button: 0}));
    await settle();
    expect($("#selCount").textContent).toBe("2 selected");
    $("#selCancel").click();
    expect($("#selbar").hidden).toBe(true);
  });

  it("deletes picked files after a second press, Downloads copies included", async () => {
    await openLibrary(rows(), "?view=saved");
    // A middle-click neither opens nor picks.
    tile(0).querySelector<HTMLElement>("[data-index]")!.dispatchEvent(new MouseEvent("click", {bubbles: true, cancelable: true, button: 1}));
    expect($("#view").hidden).toBe(true);
    pick(0).click();
    pick(1).click();
    await settle();
    // Refiltering re-renders the surviving picks as already selected.
    chip('[data-kind="image"]').click();
    await settle();
    expect([$("#selCount").textContent, tile(0).classList.contains("h-selected")]).toEqual(["2 selected", true]);
    $("#selDelete").click();
    await settle();
    expect($("#selDelete").textContent).toBe("Press again to remove 2 files");
    expect($("#summary").textContent).toBe("About to remove 2 files from this device and Downloads: a.jpg, b.jpg");
    // Letting the press lapse takes the warning back.
    vi.advanceTimersByTime(3001);
    expect($("#summary").textContent).toMatch(/newest first/);
    $("#selDelete").click();
    await settle();
    $("#selDelete").click();
    await settle();
    expect(harness.messages).toContainEqual({type: "LINKPEEK_LIBRARY_REMOVE", urls: ["https://cdn.test/a.jpg", "https://cdn.test/b.jpg"]});
    // Both pictures are gone; the GIF survives behind the picture filter.
    expect(document.querySelectorAll(".h-tile")).toHaveLength(0);
    expect([$("#summary").textContent, $("#selbar").hidden]).toEqual(["Deleted 2 files, Downloads copies included", true]);
    // The first press's lapsed timer finds the step already used and leaves the outcome alone.
    vi.advanceTimersByTime(3001);
    expect($("#summary").textContent).toBe("Deleted 2 files, Downloads copies included");
    chip('[data-kind="all"]').click();
    await settle();
    expect(document.querySelectorAll(".h-tile")).toHaveLength(1);
    // With nothing picked, Delete does nothing.
    $("#select").click();
    $("#selDelete").click();
    await settle();
    expect(harness.messages.filter((msg: any) => msg.type === "LINKPEEK_LIBRARY_REMOVE")).toHaveLength(1);
    $("#select").click();
    expect($("#selbar").hidden).toBe(true);
  });

  it("names everything a big delete will take, up to a handful", async () => {
    const now = Date.now();
    await openLibrary(Array.from({length: 7}, (_, i) => [`https://cdn.test/m${i}.jpg`, {bytes: 1, at: now - i, seen: true, type: "image", title: `M ${i}`}]), "?view=saved");
    document.querySelector<HTMLButtonElement>("[data-pick]")!.click();
    await settle();
    $("#selAll").click();
    $("#selDelete").click();
    await settle();
    expect($("#summary").textContent).toBe("About to remove 7 files from this device and Downloads: m0.jpg, m1.jpg, m2.jpg, m3.jpg, m4.jpg and 2 more");
    $("#selCancel").click();
  });

  it("removes picked entries from the history in the seen view, and forgets picks that filters hide", async () => {
    const now = Date.now();
    vi.resetModules();
    bands.all.length = 0;
    fakeCaches();
    vi.stubGlobal("URL", Object.assign(URL, {createObjectURL: vi.fn(() => "blob:saved")}));
    history.replaceState(null, "", "/history.html");
    loadPage("history.html");
    harness = stubExtension({});
    harness.store[HISTORY_META] = {first: 0, last: 0};
    harness.store[`${HISTORY_PREFIX}0`] = [entry(1, now - 1), entry(2, now - 2, {t: "gif"})];
    await import("../../src/pages/history");
    await settle();
    pick(0).click();
    await settle();
    expect($("#selDelete").textContent).toBe("Remove from history");
    // A filter that hides the picked row also unpicks it.
    chip('[data-kind="gif"]').click();
    await settle();
    expect([$("#selCount").textContent, $("#selbar").hidden]).toEqual(["0 selected", false]);
    pick(0).click();
    await settle();
    $("#selDelete").click();
    await settle();
    $("#selDelete").click();
    await settle();
    expect(harness.messages).toContainEqual({type: "LINKPEEK_HISTORY_REMOVE", entries: [{a: now - 2, o: "https://cdn.test/2.jpg"}]});
    expect($("#summary").textContent).toBe("Removed 1 from the history");
    // Switching views leaves selection mode.
    pick(0)?.click();
    chip('[data-show="saved"]').click();
    await settle();
    expect($("#selbar").hidden).toBe(true);
  });

  it("plays a GIF tile only while hovered when that setting is on, and not at all when off", async () => {
    const now = Date.now();
    const openWith = async (settings: Record<string, unknown>) => {
      bands.all.length = 0;
      const api = fakeCaches();
      vi.stubGlobal("URL", Object.assign(URL, {createObjectURL: vi.fn(() => "blob:gif")}));
      history.replaceState(null, "", "/history.html?view=saved");
      vi.resetModules();
      loadPage("history.html");
      harness = stubExtension(settings);
      harness.store[LIB] = [
        ["https://cdn.test/anim.gif", {bytes: 1, at: now, seen: true, type: "gif", title: "Anim", preview: "https://cdn.test/anim-s.jpg", original: "https://x.test/anim.gif"}],
        ["https://cdn.test/pic.jpg", {bytes: 1, at: now - 1, seen: true, type: "image", title: "Pic"}],
        ["https://cdn.test/bare.gif", {bytes: 1, at: now - 2, seen: true, type: "gif", title: "Bare"}],
        ["https://cdn.test/web.gif", {bytes: 1, at: now - 3, seen: true, type: "gif", title: "Web", preview: "https://cdn.test/web-s.jpg", original: "https://x.test/web.gif"}],
        ["https://cdn.test/clip.mp4", {bytes: 1, at: now - 4, seen: true, type: "video", title: "Clip", preview: "https://cdn.test/clip-s.jpg", original: "https://x.test/clip.mp4"}],
        ["https://cdn.test/bare.mp4", {bytes: 1, at: now - 5, seen: true, type: "video", title: "Bare clip", original: "https://x.test/bare.mp4"}]
      ];
      await (await api.open(LIBRARY_CACHE)).put("https://cdn.test/anim.gif", new Response("gifbytes"));
      await import("../../src/pages/history");
      await settle();
      return [...document.querySelectorAll<HTMLElement>(".h-tile")];
    };
    const tiles = await openWith({libraryGifHover: true});
    const img = tiles[0].querySelector("img")!;
    expect(img.getAttribute("src")).toBe("https://cdn.test/anim-s.jpg");
    tiles[0].dispatchEvent(new MouseEvent("mouseover", {bubbles: true}));
    await settle();
    expect(img.getAttribute("src")).toBe("blob:gif");
    // Hovering again keeps the remembered still; moving within the tile changes nothing; leaving stills it.
    tiles[0].dispatchEvent(new MouseEvent("mouseover", {bubbles: true}));
    tiles[0].dispatchEvent(new MouseEvent("mouseover", {bubbles: true, relatedTarget: img}));
    tiles[0].dispatchEvent(new MouseEvent("mouseout", {bubbles: true}));
    await settle();
    expect(img.getAttribute("src")).toBe("https://cdn.test/anim-s.jpg");
    // A GIF without a saved copy animates from the web instead.
    tiles[3].dispatchEvent(new MouseEvent("mouseover", {bubbles: true}));
    await settle();
    expect(tiles[3].querySelector("img")!.getAttribute("src")).toBe("https://x.test/web.gif");
    // Leaving without having hovered, plain pictures, previewless GIFs and stale tiles are all left alone.
    tiles[0].dispatchEvent(new MouseEvent("mouseout", {bubbles: true}));
    tiles[1].dispatchEvent(new MouseEvent("mouseover", {bubbles: true}));
    tiles[2].dispatchEvent(new MouseEvent("mouseover", {bubbles: true}));
    tiles[1].dataset.row = "99";
    tiles[1].dispatchEvent(new MouseEvent("mouseover", {bubbles: true}));
    $("#days").dispatchEvent(new MouseEvent("mouseover", {bubbles: true}));
    await settle();
    expect(tiles[1].querySelector("img")!.getAttribute("src")).toBe("https://cdn.test/pic.jpg");
    // With the GIF setting off, GIFs play in place and hovering changes nothing.
    const off = await openWith({libraryGifHover: false});
    off[0].dispatchEvent(new MouseEvent("mouseover", {bubbles: true}));
    await settle();
    expect(off[0].querySelector("img")!.getAttribute("src")).toBe("blob:gif");
    // Videos play on hover by default: muted, looping, over the still, and gone again on leave.
    const clip = off[4];
    clip.dispatchEvent(new MouseEvent("mouseover", {bubbles: true}));
    await settle();
    const playing = clip.querySelector<HTMLVideoElement>("video.h-hoverplay")!;
    expect([playing.getAttribute("src"), playing.muted, playing.loop]).toEqual(["https://x.test/clip.mp4", true, true]);
    expect(clip.querySelector("img")!.getAttribute("src")).toBe("https://cdn.test/clip-s.jpg");
    clip.dispatchEvent(new MouseEvent("mouseout", {bubbles: true}));
    expect(clip.querySelector("video")).toBeNull();
    // A video without a still plays over its placeholder just the same.
    off[5].dispatchEvent(new MouseEvent("mouseover", {bubbles: true}));
    await settle();
    expect(off[5].querySelector("video.h-hoverplay")).not.toBeNull();
    off[5].dispatchEvent(new MouseEvent("mouseout", {bubbles: true}));
    // Leaving before the file is ready: nothing starts playing afterwards.
    clip.dispatchEvent(new MouseEvent("mouseover", {bubbles: true}));
    clip.dispatchEvent(new MouseEvent("mouseout", {bubbles: true}));
    await settle();
    expect(clip.querySelector("video")).toBeNull();
    // With the video setting off, nothing plays.
    const quiet = await openWith({libraryVideoHover: false});
    quiet[4].dispatchEvent(new MouseEvent("mouseover", {bubbles: true}));
    await settle();
    expect(quiet[4].querySelector("video")).toBeNull();
  });

  it("gives every GIF and video tile a still of its own, keeps it on this device, and reuses it", async () => {
    const now = Date.now();
    let blobs = 0;
    const rows = [
      ["https://cdn.test/kept.gif", {bytes: 1, at: now, seen: true, type: "gif", title: "Kept gif", original: "https://x.test/kept.gif"}],
      ["https://cdn.test/web.gif", {bytes: 1, at: now - 1, seen: true, type: "gif", title: "Web gif", original: "https://x.test/web.gif"}],
      ["https://cdn.test/clip.mp4", {bytes: 1, at: now - 2, seen: true, type: "video", title: "Clip", original: "https://x.test/clip.mp4"}],
      ["https://cdn.test/gone.gif", {bytes: 1, at: now - 3, seen: true, type: "gif", title: "Gone gif", original: "https://x.test/gone.gif"}]
    ];
    const openStillsPage = async () => {
      bands.all.length = 0;
      const api = fakeCaches();
      vi.stubGlobal("URL", Object.assign(URL, {createObjectURL: vi.fn(() => `blob:${++blobs}`)}));
      history.replaceState(null, "", "/history.html?view=saved");
      vi.resetModules();
      loadPage("history.html");
      harness = stubExtension({});
      harness.store[LIB] = rows;
      await (await api.open(LIBRARY_CACHE)).put("https://cdn.test/kept.gif", new Response("gifbytes"));
      return api;
    };
    stillMaker.gif.mockResolvedValue(new Blob(["still"], {type: "image/jpeg"}));
    stillMaker.video.mockResolvedValue(new Blob(["frame"], {type: "image/jpeg"}));
    vi.stubGlobal("fetch", vi.fn(async (url: string) => url.includes("gone") ? new Response("", {status: 404}) : new Response("webbytes")));
    const api = await openStillsPage();
    await import("../../src/pages/history");
    for (let i = 0; i < 4; i++) await settle();
    const srcs = () => [...document.querySelectorAll(".h-tile .h-media")].map(media => media.querySelector("img")?.getAttribute("src") ?? media.textContent);
    // Saved GIFs are read from this device, others from the web; the video gets a frame; a GIF that cannot be read says so.
    expect(srcs()).toEqual([expect.stringMatching(/^blob:/), expect.stringMatching(/^blob:/), expect.stringMatching(/^blob:/), "GIFGIF"]);
    // The saved GIF was read from this device; only the unsaved ones went to the web.
    const fetched = (fetch as ReturnType<typeof vi.fn>).mock.calls.map(([url]) => String(url));
    expect(fetched.sort()).toEqual(["https://x.test/gone.gif", "https://x.test/web.gif"]);
    expect(stillMaker.gif).toHaveBeenCalledTimes(2);
    expect(stillMaker.video).toHaveBeenCalledWith("https://x.test/clip.mp4", "https://cdn.test/clip.mp4");
    const stills = api.stores.get(STILLS_CACHE)!;
    expect([...stills.keys()].sort()).toEqual(["https://cdn.test/clip.mp4", "https://cdn.test/kept.gif", "https://cdn.test/web.gif"]);
    // Reopened: every still comes from this device, nothing is made again.
    stillMaker.gif.mockClear();
    stillMaker.video.mockClear();
    bands.all.length = 0;
    history.replaceState(null, "", "/history.html?view=saved");
    vi.resetModules();
    loadPage("history.html");
    harness = stubExtension({});
    harness.store[LIB] = rows;
    await import("../../src/pages/history");
    for (let i = 0; i < 4; i++) await settle();
    expect([stillMaker.gif.mock.calls.length, stillMaker.video.mock.calls.length]).toEqual([0, 0]);
    expect(srcs().slice(0, 3)).toEqual([expect.stringMatching(/^blob:/), expect.stringMatching(/^blob:/), expect.stringMatching(/^blob:/)]);
    // Redrawing reuses what is in memory, and an unreadable GIF is not fetched again this visit.
    const goneFetches = () => (fetch as ReturnType<typeof vi.fn>).mock.calls.filter(([url]) => String(url).includes("gone")).length;
    const before = goneFetches();
    chip('[data-kind="gif"]').click();
    await settle();
    chip('[data-kind="all"]').click();
    for (let i = 0; i < 4; i++) await settle();
    expect([stillMaker.gif.mock.calls.length, goneFetches()]).toEqual([0, before]);
  });

  it("keeps rare and destructive actions in a menu that closes on a click outside or Escape", async () => {
    await openLibrary(rows(), "?view=saved");
    const menu = $<HTMLDetailsElement>("#more");
    menu.open = true;
    // Working inside the menu (the two-press delete) keeps it open.
    $("#clear").click();
    await settle();
    expect([menu.open, $("#clear").textContent]).toEqual([true, "Press again to delete"]);
    document.body.click();
    expect(menu.open).toBe(false);
    menu.open = true;
    document.dispatchEvent(new KeyboardEvent("keydown", {key: "Escape"}));
    expect(menu.open).toBe(false);
    // With it closed, Escape moves on to what else is open.
    document.dispatchEvent(new KeyboardEvent("keydown", {key: "Escape"}));
    document.body.click();
    expect(menu.open).toBe(false);
  });

  it("makes stills a couple at a time, and skips any whose tile was redrawn away while it waited", async () => {
    const now = Date.now(), finishers: Array<(blob: Blob) => void> = [];
    stillMaker.video.mockImplementation(() => new Promise<Blob>(resolve => finishers.push(resolve)));
    await openLibrary(["a", "b", "c"].map((name, i) => [`https://cdn.test/${name}.mp4`, {bytes: 1, at: now - i, seen: true, type: "video", title: `Clip ${name}`}]), "?view=saved");
    await settle();
    // Two at a time: the third waits its turn.
    expect(stillMaker.video).toHaveBeenCalledTimes(2);
    chip('[data-kind="gif"]').click();
    await settle();
    for (const finish of finishers) finish(new Blob(["frame"], {type: "image/jpeg"}));
    for (let i = 0; i < 4; i++) await settle();
    // The third tile is gone from the page, so its still is never made.
    expect(stillMaker.video).toHaveBeenCalledTimes(2);
  });

  it("lets go of the stills when the history is cleared", async () => {
    const api = fakeCaches();
    await (await api.open(STILLS_CACHE)).put("https://cdn.test/x.gif", new Response("still"));
    history.replaceState(null, "", "/history.html");
    await open([entry(1, Date.now(), {t: "gif"})]);
    $("#clear").click();
    await settle();
    $("#clear").click();
    await settle();
    expect(api.delete).toHaveBeenCalledWith(STILLS_CACHE);
  });

  it("narrates the saved-files check on one line as the worker reports it", async () => {
    await openLibrary(rows(), "?view=saved");
    const tick = (patch: Record<string, unknown>) => {
      for (const listener of harness.runtimeListeners) listener({type: "LINKPEEK_AUDIT_TICK", checked: 142, total: 384, removed: 3, mirrored: 12, url: "https://cdn.test/folder/beach.jpg?x=1", resting: 0, ...patch});
    };
    // Too early for an estimate.
    tick({checked: 2, removed: 0, mirrored: 0});
    expect($("#summary").textContent).toBe("Checking saved files · 1% · 2 of 384 · 0 removed · 0 added to Downloads · beach.jpg");
    tick({});
    expect($("#summary").textContent).toBe("Checking saved files · 37% · 142 of 384 · 3 removed · 12 added to Downloads · beach.jpg · about 1s left");
    expect([$("#progress").classList.contains("h-bar-live"), document.getElementById("progressFill")!.style.width]).toEqual([true, "37%"]);
    // Under load it says it is easing off; an address with no file name shows whole.
    tick({resting: 800, url: "https://cdn.test/"});
    expect($("#summary").textContent).toBe("Checking saved files · 37% · 142 of 384 · 3 removed · 12 added to Downloads · https://cdn.test/ · about 1s left · easing off to spare the browser");
    // The estimate follows the measured pace.
    vi.advanceTimersByTime(10_000);
    tick({checked: 284});
    expect($("#summary").textContent).toContain("about 4s left");
    // The last file hands the bar back to the storage gauge.
    tick({checked: 384});
    expect($("#summary").textContent).not.toContain("left");
    expect($("#progress").classList.contains("h-bar-live")).toBe(false);
    expect($("#progress").title).toContain("of the 2.0 GB");
    // A slow crawl is told in minutes.
    tick({checked: 10, removed: 0, mirrored: 0});
    vi.advanceTimersByTime(200_000);
    tick({checked: 20, removed: 0, mirrored: 0});
    expect($("#summary").textContent).toContain("min left");
    for (const listener of harness.runtimeListeners) listener({type: "OTHER"});
  });
});

describe("tags, order and the slideshow", () => {
  const LIB = "mediaIndex";
  const chip = (selector: string) => document.querySelector<HTMLButtonElement>(selector)!;

  async function openLibrary(index: unknown, search = "") {
    const api = fakeCaches();
    vi.stubGlobal("URL", Object.assign(URL, {createObjectURL: vi.fn(() => "blob:saved")}));
    history.replaceState(null, "", `/history.html${search}`);
    vi.resetModules();
    loadPage("history.html");
    harness = stubExtension({});
    harness.store[LIB] = index;
    await import("../../src/pages/history");
    await settle();
    return api;
  }

  const now = () => Date.now();
  const aliceRows = () => [
    ["https://cdn.test/anim.gif", {bytes: 1, at: now() - 1, seen: false, type: "gif", title: "Alice anim run", original: "https://x.test/anim.gif", source: "https://forum.test/t/a", preview: "https://cdn.test/anim-s.jpg"}],
    ["https://cdn.test/beach.jpg", {bytes: 1, at: now() - 2, seen: false, type: "image", title: "Alice beach walk", original: "https://x.test/beach.jpg", source: "https://forum.test/t/b"}],
    ["https://cdn.test/town.jpg", {bytes: 1, at: now() - 3, seen: true, type: "image", title: "Alice town pose"}],
    ["https://cdn.test/zed.jpg", {bytes: 1, at: now() - 4, seen: false, type: "image", title: "Zed misc shot"}],
    ["https://cdn.test/b1.jpg", {bytes: 1, at: now() - 5, seen: true, type: "image", title: "Bob first walkabout"}],
    ["https://cdn.test/b2.jpg", {bytes: 1, at: now() - 6, seen: true, type: "image", title: "Bob second try"}],
    ["https://cdn.test/b3.jpg", {bytes: 1, at: now() - 7, seen: true, type: "image", title: "Bob third day"}],
    ["https://cdn.test/untitled.jpg", {bytes: 1, at: now() - 8, seen: true, type: "image"}]
  ];

  it("mines tag chips from titles, filters by one, and keeps it in the address", async () => {
    await openLibrary(aliceRows(), "?view=saved");
    const chips = () => [...document.querySelectorAll<HTMLButtonElement>("#tags [data-tag]")];
    expect(chips().map(button => button.textContent)).toEqual(["Alice", "Bob"]);
    chips()[0].click();
    await settle();
    expect([location.search, document.querySelectorAll(".h-tile").length]).toEqual(["?view=saved&tag=alice", 3]);
    // The picked tag stays, pressed; nothing else from these titles leads anywhere.
    expect(chips().map(button => [button.textContent, button.getAttribute("aria-pressed")])).toEqual([["Alice", "true"]]);
    // The same press clears it again.
    chip('#tags [data-tag="alice"]').click();
    await settle();
    expect([location.search, document.querySelectorAll(".h-tile").length]).toEqual(["?view=saved", 8]);
    expect(chips().map(button => button.textContent)).toEqual(["Alice", "Bob"]);
    // A click beside the chips changes nothing.
    document.querySelector("#tags")!.dispatchEvent(new MouseEvent("click", {bubbles: true}));
    await settle();
    expect(location.search).toBe("?view=saved");
    // A tag with nothing behind it says so.
    chip('#tags [data-tag="alice"]').click();
    chip('[data-kind="video"]').click();
    await settle();
    expect($("#summary").textContent).toBe("Nothing here carries \u201calice\u201d.");
  });

  it("stacks tags, each pick narrowing the chips to what still has results", async () => {
    const now = Date.now();
    await openLibrary([
      ["https://cdn.test/ab1.jpg", {bytes: 1, at: now - 1, seen: true, type: "image", title: "Alice beach aa"}],
      ["https://cdn.test/ab2.jpg", {bytes: 1, at: now - 2, seen: true, type: "image", title: "Alice beach bb"}],
      ["https://cdn.test/at.jpg", {bytes: 1, at: now - 3, seen: true, type: "image", title: "Alice town cc"}],
      ["https://cdn.test/b1.jpg", {bytes: 1, at: now - 4, seen: true, type: "image", title: "Bob dd"}],
      ["https://cdn.test/b2.jpg", {bytes: 1, at: now - 5, seen: true, type: "image", title: "Bob ee"}],
      ["https://cdn.test/b3.jpg", {bytes: 1, at: now - 6, seen: true, type: "image", title: "Bob ff"}]
    ], "?view=saved");
    const chips = () => [...document.querySelectorAll<HTMLButtonElement>("#tags [data-tag]")];
    chip('#tags [data-tag="alice"]').click();
    await settle();
    // Only tags that still have results within the pick are offered next to it.
    expect(chips().map(button => button.dataset.tag)).toEqual(["alice", "alice beach"]);
    chip('#tags [data-tag="alice beach"]').click();
    await settle();
    expect(new URLSearchParams(location.search).get("tag")).toBe("alice,alice beach");
    expect(document.querySelectorAll(".h-tile")).toHaveLength(2);
    // Dropping the broader tag keeps the narrower one working.
    chip('#tags [data-tag="alice"]').click();
    await settle();
    expect([new URLSearchParams(location.search).get("tag"), document.querySelectorAll(".h-tile").length]).toEqual(["alice beach", 2]);
  });

  it("remembers the preview size on this device", async () => {
    localStorage.removeItem("libraryTile");
    await openLibrary(aliceRows(), "?view=saved");
    const slider = $<HTMLInputElement>("#tileSize");
    expect([slider.value, $("#days").style.getPropertyValue("--tile")]).toEqual(["220", "220px"]);
    slider.value = "320";
    slider.dispatchEvent(new Event("input"));
    expect($("#days").style.getPropertyValue("--tile")).toBe("320px");
    await openLibrary(aliceRows(), "?view=saved");
    expect($<HTMLInputElement>("#tileSize").value).toBe("320");
  });

  it("keeps every tag behind one chip, with a filter, instead of crowding the row", async () => {
    const now = Date.now();
    const many = Array.from({length: 27}, (_, i) => {
      const name = `subj${String(i).padStart(2, "0")}`;
      return [
        [`https://cdn.test/${name}a.jpg`, {bytes: 1, at: now - i * 2, seen: true, type: "image", title: `${name} aa${i}`}],
        [`https://cdn.test/${name}b.jpg`, {bytes: 1, at: now - i * 2 - 1, seen: true, type: "image", title: `${name} bb${i}`}]
      ];
    }).flat();
    await openLibrary(many, "?view=saved");
    expect(document.querySelectorAll("#tags [data-tag]")).toHaveLength(24);
    const more = () => document.getElementById("tagsMore")!;
    expect(more().textContent).toBe("All tags (27) ▾");
    expect($("#tagsAll").hidden).toBe(true);
    more().click();
    await settle();
    expect($("#tagsAll").hidden).toBe(false);
    expect(document.querySelectorAll("#tagsAllList [data-tag]")).toHaveLength(27);
    expect(more().textContent).toBe("Fewer tags ▴");
    // The filter narrows the panel as you type.
    const find = $<HTMLInputElement>("#tagsFind");
    find.value = "subj26";
    find.dispatchEvent(new Event("input"));
    expect(document.querySelectorAll("#tagsAllList [data-tag]")).toHaveLength(1);
    find.value = "zzz";
    find.dispatchEvent(new Event("input"));
    expect($("#tagsAllList").textContent).toContain("No tag matches");
    find.value = "";
    find.dispatchEvent(new Event("input"));
    // Picking from the panel works like the row; the panel folds once few tags remain.
    document.querySelector<HTMLButtonElement>('#tagsAllList [data-tag="subj26"]')!.click();
    await settle();
    expect([new URLSearchParams(location.search).get("tag"), document.querySelectorAll(".h-tile").length]).toEqual(["subj26", 2]);
    expect([$("#tagsAll").hidden, document.getElementById("tagsMore")]).toEqual([true, null]);
    // Escape closes a reopened panel before it touches anything else.
    document.querySelector<HTMLButtonElement>('#tags [data-tag="subj26"]')!.click();
    await settle();
    more().click();
    await settle();
    expect($("#tagsAll").hidden).toBe(false);
    document.dispatchEvent(new KeyboardEvent("keydown", {key: "Escape"}));
    expect($("#tagsAll").hidden).toBe(true);
  });

  it("stores the mined tags on this device, and reuses them while the titles are unchanged", async () => {
    await openLibrary(aliceRows(), "?view=saved");
    // Written once things settle, not on every change.
    expect(harness.chrome.storage.local.set.mock.calls.some(([values]: any[]) => values.libraryTags)).toBe(false);
    await vi.advanceTimersByTimeAsync(1000);
    const write = harness.chrome.storage.local.set.mock.calls.find(([values]: any[]) => values.libraryTags);
    const entries = write[0].libraryTags as Array<{key: string; tags: Array<{key: string}>}>;
    expect(entries.some(entry => entry.tags.map(tag => tag.key).join() === "alice,bob")).toBe(true);
    const cached = harness.store.libraryTags;
    // Reopened with the same titles: the stored copy serves, and nothing is rewritten.
    bands.all.length = 0;
    fakeCaches();
    vi.stubGlobal("URL", Object.assign(URL, {createObjectURL: vi.fn(() => "blob:saved")}));
    history.replaceState(null, "", "/history.html?view=saved");
    vi.resetModules();
    loadPage("history.html");
    harness = stubExtension({}, {libraryTags: cached, mediaIndex: aliceRows()});
    await import("../../src/pages/history");
    await settle();
    await vi.advanceTimersByTimeAsync(1000);
    expect(harness.chrome.storage.local.set.mock.calls.some(([values]: any[]) => values.libraryTags)).toBe(false);
    expect([...document.querySelectorAll<HTMLButtonElement>("#tags [data-tag]")].map(button => button.textContent)).toEqual(["Alice", "Bob"]);
  });

  it("ignores a stored cache it cannot use, and keeps only the most recent minings", async () => {
    // An older format, a broken entry: both ignored, and mining works as usual.
    bands.all.length = 0;
    fakeCaches();
    history.replaceState(null, "", "/history.html?view=saved");
    vi.resetModules();
    loadPage("history.html");
    harness = stubExtension({}, {libraryTags: [{key: 5}, null], mediaIndex: aliceRows()});
    await import("../../src/pages/history");
    await settle();
    expect([...document.querySelectorAll<HTMLButtonElement>("#tags [data-tag]")].map(button => button.textContent)).toEqual(["Alice", "Bob"]);
  });

  it("keeps only the most recent minings, however many views are visited", async () => {
    const now = Date.now();
    const subjects = Array.from({length: 14}, (_, i) => `subj${String(i).padStart(2, "0")}`);
    await openLibrary(subjects.flatMap((name, i) => [
      [`https://cdn.test/${name}a.jpg`, {bytes: 1, at: now - i * 2, seen: true, type: "image", title: `${name} aa${i}`}],
      [`https://cdn.test/${name}b.jpg`, {bytes: 1, at: now - i * 2 - 1, seen: true, type: "image", title: `${name} bb${i}`}]
    ]), "?view=saved");
    // Each tag alone narrows to a different set of titles, mined once each.
    for (const name of subjects) {
      chip(`#tags [data-tag="${name}"]`).click();
      await settle();
      chip(`#tags [data-tag="${name}"]`).click();
      await settle();
    }
    await vi.advanceTimersByTimeAsync(1000);
    expect((harness.store.libraryTags as unknown[]).length).toBe(12);
  });

  it("combines picked tags as all or any, and plays exactly what the tags let through", async () => {
    const now = Date.now();
    await openLibrary([
      ["https://cdn.test/ab.jpg", {bytes: 1, at: now - 1, seen: false, type: "image", title: "Alice Bob duo"}],
      ["https://cdn.test/a1.mp4", {bytes: 1, at: now - 2, seen: false, type: "video", title: "Alice solo one"}],
      ["https://cdn.test/a2.gif", {bytes: 1, at: now - 3, seen: false, type: "gif", title: "Alice solo two"}],
      ["https://cdn.test/b1.jpg", {bytes: 1, at: now - 4, seen: false, type: "image", title: "Bob alone one"}],
      ["https://cdn.test/b2.jpg", {bytes: 1, at: now - 5, seen: true, type: "image", title: "Bob alone two"}],
      ["https://cdn.test/c1.jpg", {bytes: 1, at: now - 6, seen: false, type: "image", title: "Carol here one"}],
      ["https://cdn.test/c2.jpg", {bytes: 1, at: now - 7, seen: false, type: "image", title: "Carol here two"}]
    ], "?view=saved&tag=alice,bob");
    // Two tags on: they must both be carried, and a chip says so.
    expect([chip("#tagMode").textContent, document.querySelectorAll(".h-tile").length]).toEqual(["Match all", 1]);
    expect($("#play").textContent).toBe("▶ Play unseen · 1");
    chip("#tagMode").click();
    await settle();
    expect(new URLSearchParams(location.search).get("match")).toBe("any");
    expect([chip("#tagMode").textContent, document.querySelectorAll(".h-tile").length]).toEqual(["Match any", 5]);
    // Matching any, the rest of the collection's tags stay on offer for widening.
    expect([...document.querySelectorAll<HTMLElement>("#tags [data-tag]")].map(button => button.dataset.tag)).toContain("carol here");
    // The play button counts only what is unseen among them.
    expect($("#play").textContent).toBe("▶ Play unseen · 4");
    $("#play").click();
    await settle();
    // Moving media leads: the GIF, then the video, then the pictures.
    const order: string[] = [];
    for (let i = 0; i < 4; i++) {
      order.push($("#viewTitle").textContent!);
      document.dispatchEvent(new KeyboardEvent("keydown", {key: "ArrowRight"}));
      await settle();
    }
    expect(order.slice(0, 2)).toEqual(["Alice solo two", "Alice solo one"]);
    expect(new Set(order.slice(2))).toEqual(new Set(["Alice Bob duo", "Bob alone one"]));
    document.dispatchEvent(new KeyboardEvent("keydown", {key: "Escape"}));
    await settle();
    // Everything that played is seen now, so nothing is left to count.
    expect($("#play").textContent).toBe("▶ Play unseen");
    expect($("#summary").textContent).not.toContain("Nothing");
    // With nothing at all carrying the tags, the empty state says how they combine.
    chip('[data-kind="video"]').click();
    chip('[data-filter="unseen"]').click();
    await settle();
    expect($("#summary").textContent).toBe("Nothing here carries \u201calice\u201d or \u201cbob\u201d.");
    // Back to one tag, the mode chip goes and the address forgets the mode.
    chip('#tags [data-tag="bob"]').click();
    await settle();
    expect([document.getElementById("tagMode"), new URLSearchParams(location.search).get("match")]).toEqual([null, null]);
  });

  it("opens straight into match-any from the address, and flips back to match-all", async () => {
    await openLibrary(aliceRows(), "?view=saved&tag=alice,bob&match=any");
    expect([chip("#tagMode").textContent, document.querySelectorAll(".h-tile").length]).toEqual(["Match any", 6]);
    chip("#tagMode").click();
    await settle();
    expect([chip("#tagMode").textContent, new URLSearchParams(location.search).get("match"), document.querySelectorAll(".h-tile").length]).toEqual(["Match all", null, 0]);
  });

  it("keeps an address tag as a pressed chip even when nothing offers it, and hides an empty row", async () => {
    await openLibrary(aliceRows(), "?view=saved&tag=zzz");
    // The stray tag shows exactly what is filtering, and a press takes it off.
    expect($("#summary").textContent).toBe("Nothing here carries \u201czzz\u201d.");
    const stray = chip('#tags [data-tag="zzz"]');
    expect(stray.getAttribute("aria-pressed")).toBe("true");
    stray.click();
    await settle();
    expect([location.search, document.querySelectorAll(".h-tile").length]).toEqual(["?view=saved", 8]);
    await openLibrary([["https://cdn.test/x.jpg", {bytes: 1, at: now(), seen: true, title: "Lone title"}]], "?view=saved");
    expect($("#tags").hidden).toBe(true);
  });

  it("orders by date, title or size, with headings to match", async () => {
    await openLibrary([
      ["https://cdn.test/big.jpg", {bytes: 12 * 1024 * 1024, at: now() - 1000, seen: true, type: "image", title: "Zebra big"}],
      ["https://cdn.test/mid.jpg", {bytes: 2 * 1024 * 1024, at: now() - 2000, seen: true, type: "image", title: "apple mid"}],
      ["https://cdn.test/mid2.jpg", {bytes: 2 * 1024 * 1024 + 5, at: now() - 3000, seen: true, type: "image", title: "apple mid"}],
      ["https://cdn.test/wee.jpg", {bytes: 100, at: now() - 400, seen: true, type: "image", title: "1 numbers"}],
      ["https://cdn.test/wee2.jpg", {bytes: 100, at: now() - 500, seen: true, type: "image", title: "1 numbers"}]
    ], "?view=saved&sort=largest");
    const order = $<HTMLSelectElement>("#sort");
    expect(order.value).toBe("largest");
    expect([...document.querySelectorAll(".h-day h2")].map(heading => heading.textContent)).toEqual(["10 MB and up", "1 to 10 MB", "Under 1 MB"]);
    expect([...document.querySelectorAll(".h-tile figcaption a")].map(link => link.textContent))
      .toEqual(["Zebra big", "apple mid", "apple mid", "1 numbers", "1 numbers"]);
    order.value = "title";
    order.dispatchEvent(new Event("change"));
    await settle();
    expect(location.search).toBe("?view=saved&sort=title");
    expect([...document.querySelectorAll(".h-day h2")].map(heading => heading.textContent)).toEqual(["#", "A", "Z"]);
    order.value = "oldest";
    order.dispatchEvent(new Event("change"));
    await settle();
    expect([...document.querySelectorAll(".h-tile figcaption a")].map(link => link.textContent))
      .toEqual(["apple mid", "apple mid", "Zebra big", "1 numbers", "1 numbers"]);
    // The seen view cannot order by size; switching resets to newest.
    order.value = "largest";
    order.dispatchEvent(new Event("change"));
    await settle();
    chip('[data-show="seen"]').click();
    await settle();
    expect([order.value, order.querySelector<HTMLOptionElement>('option[value="largest"]')!.disabled]).toEqual(["newest", true]);
  });

  it("plays only what was never seen, GIFs first, marking each slide seen everywhere", async () => {
    await openLibrary(aliceRows(), "?view=saved&tag=alice");
    $("#play").click();
    await settle();
    expect($("#view").hidden).toBe(false);
    // The GIF leads although both unseen files carry the tag.
    expect($("#viewTitle").textContent).toBe("Alice anim run");
    expect($("#viewMeta").textContent).toMatch(/1 of 2 .*· slideshow · about 3s left$/);
    expect(harness.messages).toContainEqual(expect.objectContaining({type: "LINKPEEK_HISTORY_ADD", entry: expect.objectContaining({o: "https://x.test/anim.gif"})}));
    await vi.advanceTimersByTimeAsync(3000);
    await settle();
    expect($("#viewTitle").textContent).toBe("Alice beach walk");
    expect(harness.messages).toContainEqual(expect.objectContaining({type: "LINKPEEK_HISTORY_ADD", entry: expect.objectContaining({o: "https://x.test/beach.jpg"})}));
    // The queue ends by saying so instead of looping back round.
    await vi.advanceTimersByTimeAsync(3000);
    await settle();
    expect($("#viewMeta").textContent).toMatch(/all caught up$/);
    document.dispatchEvent(new KeyboardEvent("keydown", {key: "Escape"}));
    await settle();
    // Both slides now count as seen, so another run has nothing left.
    $("#play").click();
    await settle();
    expect($("#summary").textContent).toBe("Nothing new to play: everything saved that matches has been seen.");
    expect(document.querySelectorAll('.h-tile .h-new')).toHaveLength(0);
  });

  it("pauses with the button or Space, still stepping by hand, and honours kind and search", async () => {
    await openLibrary([
      ["https://cdn.test/one.jpg", {bytes: 1, at: now() - 1, seen: false, type: "image", title: "One thing"}],
      ["https://cdn.test/two.jpg", {bytes: 1, at: now() - 2, seen: false, type: "image", title: "Two thing"}],
      ["https://cdn.test/odd.gif", {bytes: 1, at: now() - 3, seen: false, type: "gif", title: "Elsewhere entirely"}]
    ], "?view=saved&media=image");
    const search = $<HTMLInputElement>("#search");
    search.value = "thing";
    search.dispatchEvent(new Event("input"));
    await settle();
    $("#play").click();
    await settle();
    const first = $("#viewTitle").textContent;
    expect($("#viewMeta").textContent).toMatch(/1 of 2/);
    $("#viewPause").click();
    expect($("#viewPause").textContent).toBe("Resume");
    expect($("#viewMeta").textContent).toMatch(/slideshow paused$/);
    await vi.advanceTimersByTimeAsync(10_000);
    await settle();
    expect($("#viewTitle").textContent).toBe(first);
    // Stepping by hand still works while paused, without restarting the clock.
    document.dispatchEvent(new KeyboardEvent("keydown", {key: "ArrowRight"}));
    await settle();
    expect($("#viewTitle").textContent).not.toBe(first);
    document.dispatchEvent(new KeyboardEvent("keydown", {key: " "}));
    await settle();
    expect($("#viewPause").textContent).toBe("Pause");
    await vi.advanceTimersByTimeAsync(3000);
    await settle();
    expect($("#viewMeta").textContent).toMatch(/all caught up$/);
    document.dispatchEvent(new KeyboardEvent("keydown", {key: "Escape"}));
    await settle();
    // In the plain viewer, Space simply steps.
    document.querySelector<HTMLElement>('[data-index="0"]')!.dispatchEvent(new MouseEvent("click", {bubbles: true, cancelable: true, button: 0}));
    await settle();
    document.dispatchEvent(new KeyboardEvent("keydown", {key: " "}));
    await settle();
    expect($("#viewMeta").textContent).toMatch(/^2 of 2/);
  });

  it("lets a video slide play itself out, staying put while paused", async () => {
    await openLibrary([
      ["https://cdn.test/clip.mp4", {bytes: 1, at: now(), seen: false, type: "video", title: "Clip night", preview: "https://cdn.test/clip-s.jpg"}]
    ], "?view=saved");
    $("#play").click();
    await settle();
    const video = document.querySelector<HTMLVideoElement>("#viewStage video")!;
    // A slideshow's video plays once rather than looping.
    expect(video.hasAttribute("loop")).toBe(false);
    $("#viewPause").click();
    video.dispatchEvent(new Event("ended"));
    await settle();
    expect($("#viewMeta").textContent).toMatch(/slideshow paused$/);
    document.dispatchEvent(new KeyboardEvent("keydown", {key: " "}));
    await vi.advanceTimersByTimeAsync(60_000);
    await settle();
    expect($("#viewMeta").textContent).toMatch(/all caught up/);
    expect($("#viewPause").hidden).toBe(true);
    // The pause button does nothing once the slideshow is over.
    $("#viewPause").click();
    expect($("#viewPause").hidden).toBe(true);
  });
});
