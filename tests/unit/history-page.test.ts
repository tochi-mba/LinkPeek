import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {HISTORY_META, HISTORY_PREFIX, LIBRARY_CACHE, type HistoryEntry} from "../../src/shared/history";
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
  vi.useFakeTimers({toFake: ["Date", "setTimeout"]});
  vi.setSystemTime(new Date(2026, 9, 6, 12, 0));
  observed = [];
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
    expect(tiles[0].querySelector(".h-none")!.textContent).toBe("Video");
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

  it("explains an empty history, and clears after a second press", async () => {
    await open(null);
    expect($("#summary").textContent).toBe("Nothing here yet. What you open in LinkPeek appears here, newest first.");
    await open([entry(1, Date.now())]);
    expect($("#summary").textContent).toBe("1 item, newest first");
    const clear = $<HTMLButtonElement>("#clear");
    clear.click();
    await settle();
    expect(clear.textContent).toBe("Press again to clear");
    vi.advanceTimersByTime(3001);
    expect(clear.textContent).toBe("Clear history");
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
    const images = [...document.querySelectorAll<HTMLImageElement>(".h-tile img")];
    expect(images.map(image => image.getAttribute("src"))).toEqual(["https://cdn.test/1-s.jpg", "blob:saved-1"]);
    expect($("#saveAll").title).toMatch(/^1 files kept on this device \(5 MB\)/);
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

  it("saves every kept file into Downloads after a second press, and says when nothing is kept", async () => {
    const now = Date.now();
    await openSaved([entry(2, now - 1000), entry(1, now)], ["https://cdn.test/2-s.jpg", "https://cdn.test/1-s.jpg"]);
    $("#saveAll").click();
    await settle();
    expect($("#saveAll").textContent).toBe("Press again to save 2 files");
    vi.advanceTimersByTime(3001);
    expect($("#saveAll").textContent).toBe("Save all to Downloads");
    $("#saveAll").click();
    await settle();
    vi.advanceTimersByTime(1000);
    $("#saveAll").click();
    await settle();
    expect(downloads).toHaveBeenCalledTimes(2);
    // The first press's timer finds the button already used, and leaves it alone.
    vi.advanceTimersByTime(3000);
    expect($("#summary").textContent).toBe("Saved 2 files to Downloads / LinkPeek Library");
    await openSaved([entry(1, now)], []);
    $("#saveAll").click();
    await settle();
    expect($("#summary").textContent).toMatch(/^Nothing is saved on this device yet/);
  });
});
