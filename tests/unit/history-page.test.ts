import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {HISTORY_META, HISTORY_PREFIX, type HistoryEntry} from "../../src/shared/history";
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
