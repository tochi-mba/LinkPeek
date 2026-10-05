import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import type {MediaItem} from "../../src/shared/media";
import {VirtualGrid} from "../../src/ui/virtual-grid";

let frames: Array<() => void>, resized: Array<() => void>, disconnected: number;
const items = (count: number): MediaItem[] => Array.from({length: count}, (_, n) => ({
  id: `${n}`, type: n === 1 ? "gif" : n === 2 ? "video" : "image", originalUrl: `o${n}`, previewUrl: `p${n}`,
  posterUrl: n === 2 ? "poster" : undefined, sourceUrl: "s", score: 1
}));

/** A grid container with a fixed 400 x 300 viewport (jsdom has no layout). */
function container() {
  const el = document.createElement("div");
  let scroll = 0;
  Object.defineProperty(el, "clientWidth", {configurable: true, value: 400});
  Object.defineProperty(el, "clientHeight", {configurable: true, value: 300});
  Object.defineProperty(el, "scrollTop", {configurable: true, get: () => scroll, set: value => scroll = value});
  document.body.append(el);
  return el;
}
const tiles = (el: HTMLElement) => [...el.querySelectorAll<HTMLElement>(".lp-thumb")];

beforeEach(() => {
  frames = [];
  resized = [];
  disconnected = 0;
  vi.stubGlobal("requestAnimationFrame", vi.fn((callback: () => void) => frames.push(callback)));
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  vi.stubGlobal("ResizeObserver", class {
    constructor(callback: () => void) {
      resized.push(callback);
    }
    observe() {}
    disconnect() {
      disconnected++;
    }
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

describe("the virtual grid", () => {
  it("renders only the rows on screen plus a small overscan", () => {
    const el = container(), grid = new VirtualGrid(el, items(30), {cell: 100, current: 0, onPick: vi.fn()});
    expect(grid.columns()).toBe(3);
    expect(el.querySelector<HTMLElement>(".lp-grid-spacer")!.style.height).toBe("1070px");
    expect(tiles(el)).toHaveLength(15);
    expect(tiles(el)[0].getAttribute("aria-current")).toBe("true");
    expect(tiles(el)[0].querySelector("img")!.getAttribute("loading")).toBe("eager");
    expect(tiles(el)[9].querySelector("img")!.getAttribute("loading")).toBe("lazy");
    expect(tiles(el)[1].textContent).toContain("GIF");
    expect(tiles(el)[2].querySelector("img")!.getAttribute("src")).toBe("poster");
    expect(tiles(el)[2].textContent).toContain("VIDEO");
  });

  it("shows a play glyph for videos without a poster", () => {
    const el = container(), list = items(3);
    list[2].posterUrl = undefined;
    new VirtualGrid(el, list, {cell: 100, current: 0, onPick: vi.fn()});
    expect(tiles(el)[2].querySelector(".lp-thumb-glyph")).not.toBeNull();
  });

  it("opens centred on the current item", () => {
    const el = container();
    new VirtualGrid(el, items(300), {cell: 100, current: 150, onPick: vi.fn()});
    expect(el.scrollTop).toBe(8 + 50 * 106 - 100);
    expect(tiles(el).some(tile => tile.dataset.i === "150" && tile.getAttribute("aria-current") === "true")).toBe(true);
  });

  it("creates scroll height before setting the initial browser scroll position", () => {
    const el = document.createElement("div");
    let scroll = 0;
    Object.defineProperty(el, "clientWidth", {value: 400});
    Object.defineProperty(el, "clientHeight", {value: 300});
    Object.defineProperty(el, "scrollTop", {
      get: () => scroll,
      set: value => {
        const height = Number.parseFloat(el.querySelector<HTMLElement>(".lp-grid-spacer")?.style.height || "0");
        scroll = height > 300 ? value : 0;
      }
    });
    document.body.append(el);
    new VirtualGrid(el, items(300), {cell: 100, current: 150, onPick: vi.fn()});
    expect(scroll).toBeGreaterThan(0);
    expect(tiles(el).some(tile => tile.dataset.i === "150" && tile.getAttribute("aria-current") === "true")).toBe(true);
  });

  it("re-renders the window on scroll, once per frame, and only when it changed", () => {
    const el = container(), grid = new VirtualGrid(el, items(300), {cell: 100, current: 0, onPick: vi.fn()});
    el.scrollTop = 106 * 20;
    el.dispatchEvent(new Event("scroll"));
    el.dispatchEvent(new Event("scroll"));
    expect(frames).toHaveLength(1);
    frames.shift()!();
    expect(tiles(el)[0].dataset.i).toBe(String(18 * 3));
    const before = el.querySelector(".lp-grid-window")!.innerHTML;
    resized[0]();
    frames.shift()!();
    expect(el.querySelector(".lp-grid-window")!.innerHTML).toBe(before);
    grid.destroy();
    expect(disconnected).toBe(1);
  });

  it("cancels a pending frame when destroyed", () => {
    const el = container(), grid = new VirtualGrid(el, items(10), {cell: 100, current: 0, onPick: vi.fn()});
    el.dispatchEvent(new Event("scroll"));
    grid.destroy();
    expect(cancelAnimationFrame).toHaveBeenCalled();
  });

  it("reports decoded image widths, but not video poster widths", () => {
    const el = container(), onWidth = vi.fn();
    new VirtualGrid(el, items(10), {cell: 100, current: 0, onPick: vi.fn(), onWidth});
    const image = tiles(el)[0].querySelector("img")!;
    Object.defineProperty(image, "naturalWidth", {configurable: true, value: 45});
    image.dispatchEvent(new Event("load"));
    const poster = tiles(el)[2].querySelector("img")!;
    Object.defineProperty(poster, "naturalWidth", {configurable: true, value: 20});
    poster.dispatchEvent(new Event("load"));
    expect(onWidth).toHaveBeenCalledTimes(1);
    expect(onWidth).toHaveBeenCalledWith(0, 45);
  });

  it("opens the tile that was clicked", () => {
    const el = container(), onPick = vi.fn();
    new VirtualGrid(el, items(10), {cell: 100, current: 0, onPick});
    tiles(el)[4].querySelector("img")!.dispatchEvent(new MouseEvent("click", {bubbles: true}));
    el.querySelector(".lp-grid-window")!.dispatchEvent(new MouseEvent("click", {bubbles: true}));
    expect(onPick).toHaveBeenCalledTimes(1);
    expect(onPick).toHaveBeenCalledWith(4);
  });

  it("keeps the scroll position while the gallery grows", () => {
    const el = container(), grid = new VirtualGrid(el, items(30), {cell: 100, current: 0, onPick: vi.fn()});
    el.scrollTop = 212;
    grid.setItems(items(60));
    expect(el.scrollTop).toBe(212);
    expect(el.querySelector<HTMLElement>(".lp-grid-spacer")!.style.height).toBe(`${16 + 20 * 106 - 6}px`);
  });

  it("scrolls the selection into view by the smallest amount", () => {
    const el = container(), grid = new VirtualGrid(el, items(300), {cell: 100, current: 0, onPick: vi.fn()});
    grid.setCurrent(1, "nearest");
    expect(el.scrollTop).toBe(0);
    grid.setCurrent(30, "nearest");
    expect(el.scrollTop).toBe(8 + 10 * 106 + 100 - 300 + 8);
    grid.setCurrent(3, "nearest");
    expect(el.scrollTop).toBe(8 + 106 - 8);
    grid.setCurrent(90, "none");
    expect(el.scrollTop).toBe(106);
    expect(tiles(el).find(tile => tile.getAttribute("aria-current") === "true")).toBeUndefined();
  });

  it("re-centres on the selection when the tile size changes", () => {
    const el = container(), grid = new VirtualGrid(el, items(300), {cell: 100, current: 60, onPick: vi.fn()});
    grid.setCell(20);
    expect(tiles(el)[0].style.width).toBe("48px");
    expect(grid.columns()).toBe(7);
  });

  it("handles an empty gallery", () => {
    const el = container(), grid = new VirtualGrid(el, [], {cell: 100, current: 0, onPick: vi.fn()});
    grid.setCurrent(0, "center");
    expect(tiles(el)).toEqual([]);
  });
});
