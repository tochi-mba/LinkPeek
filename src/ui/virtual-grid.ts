/**
 * A virtualized thumbnail grid: only rows on screen (plus a small overscan)
 * exist in the DOM, so a 2,000-item gallery scrolls as smoothly as a 20-item one.
 * Thumbnails on screen load eagerly at normal priority; overscan rows are lazy.
 */
import {escapeHtml} from "../shared/dom";
import type {MediaItem} from "../shared/media";

const GAP = 6;
const PAD = 8;
const OVERSCAN_ROWS = 2;
const MIN_CELL = 48;

export type ScrollMode = "center" | "nearest" | "none";

export interface GridOptions {
  cell: number;
  current: number;
  onPick: (index: number) => void;
  onWidth?: (index: number, width: number) => void;
}

function tileMarkup(item: MediaItem, index: number, total: number, current: boolean, visible: boolean, style: string) {
  const image = item.type === "video" ? item.posterUrl : item.previewUrl;
  const media = image
    ? `<img src="${escapeHtml(image)}" alt="" loading="${visible ? "eager" : "lazy"}" decoding="async" fetchpriority="${visible ? "auto" : "low"}">`
    : `<span class="lp-thumb-glyph" aria-hidden="true">▶</span>`;
  const badge = item.type === "gif" ? `<span class="lp-thumb-kind">GIF</span>` : item.type === "video" ? `<span class="lp-thumb-kind">▶ VIDEO</span>` : "";
  return `<button class="lp-thumb" type="button" data-i="${index}" aria-current="${current}" aria-label="Open media ${index + 1} of ${total}" style="${style}">${media}${badge}<span class="lp-thumb-n">${index + 1}</span></button>`;
}

export class VirtualGrid {
  private raf = 0;
  private lastKey = "";
  private observer: ResizeObserver;
  private items: MediaItem[] = [];
  private current: number;
  private cell: number;
  private spacer: HTMLElement;
  private windowEl: HTMLElement;

  constructor(private container: HTMLElement, items: MediaItem[], private options: GridOptions) {
    this.items = items;
    this.current = options.current;
    this.cell = Math.max(MIN_CELL, options.cell);
    container.innerHTML = `<div class="lp-grid-spacer"></div><div class="lp-grid-window"></div>`;
    this.spacer = container.firstElementChild as HTMLElement;
    this.windowEl = container.lastElementChild as HTMLElement;
    container.addEventListener("scroll", this.onScroll, {passive: true});
    container.addEventListener("click", this.onClick);
    container.addEventListener("load", this.onLoad, true);
    this.observer = new ResizeObserver(() => this.schedule());
    this.observer.observe(container);
    // Browsers clamp scrollTop while scrollHeight is still zero. Paint the
    // spacer first, then centre the current item and paint that window.
    this.render();
    this.scrollToIndex(this.current, "center");
    this.lastKey = "";
    this.render();
  }

  columns() {
    const inner = Math.max(this.cell, this.container.clientWidth - PAD * 2);
    return Math.max(1, Math.floor((inner + GAP) / (this.cell + GAP)));
  }

  /** Updates the items (a progressive scan grew the gallery) without moving the scroll position. */
  setItems(items: MediaItem[]) {
    this.items = items;
    this.lastKey = "";
    this.render();
  }

  setCurrent(index: number, scroll: ScrollMode = "nearest") {
    this.current = index;
    this.lastKey = "";
    this.scrollToIndex(index, scroll);
    this.render();
  }

  setCell(size: number) {
    const anchor = this.current;
    this.cell = Math.max(MIN_CELL, size);
    this.lastKey = "";
    this.scrollToIndex(anchor, "center");
    this.render();
  }

  /** Scrolls so `index` is in view: centred, or by the smallest amount ("nearest"). */
  scrollToIndex(index: number, mode: ScrollMode) {
    if (mode === "none" || !this.items.length) return;
    const rowHeight = this.cell + GAP, row = Math.floor(index / this.columns());
    const top = PAD + row * rowHeight, bottom = top + this.cell, view = this.container.clientHeight;
    if (mode === "center") this.container.scrollTop = Math.max(0, top - (view - this.cell) / 2);
    else if (top < this.container.scrollTop) this.container.scrollTop = Math.max(0, top - PAD);
    else if (bottom > this.container.scrollTop + view) this.container.scrollTop = bottom - view + PAD;
  }

  destroy() {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.observer.disconnect();
    this.container.removeEventListener("scroll", this.onScroll);
    this.container.removeEventListener("click", this.onClick);
    this.container.removeEventListener("load", this.onLoad, true);
  }

  private onScroll = () => this.schedule();

  private onClick = (event: Event) => {
    const tile = (event.target as Element).closest?.<HTMLElement>(".lp-thumb");
    if (tile) this.options.onPick(Number(tile.dataset.i));
  };

  private onLoad = (event: Event) => {
    const image = event.target as HTMLImageElement;
    const tile = image.closest?.<HTMLElement>(".lp-thumb"), index = Number(tile?.dataset.i);
    if (tile && this.items[index]?.type !== "video" && image.naturalWidth) this.options.onWidth?.(index, image.naturalWidth);
  };

  private schedule() {
    this.raf ||= requestAnimationFrame(() => {
      this.raf = 0;
      this.render();
    });
  }

  private render() {
    const cols = this.columns(), rowHeight = this.cell + GAP, rows = Math.ceil(this.items.length / cols);
    this.spacer.style.height = `${PAD * 2 + Math.max(0, rows * rowHeight - GAP)}px`;
    const scrollTop = this.container.scrollTop, view = this.container.clientHeight;
    const firstVisible = Math.max(0, Math.floor(scrollTop / rowHeight)), lastVisible = Math.min(rows, Math.ceil((scrollTop + view) / rowHeight));
    const firstRow = Math.max(0, firstVisible - OVERSCAN_ROWS), lastRow = Math.min(rows, lastVisible + OVERSCAN_ROWS);
    const start = firstRow * cols, end = Math.min(this.items.length, lastRow * cols);
    const key = `${start}:${end}:${cols}:${this.cell}:${this.items.length}`;
    if (key === this.lastKey) return;
    this.lastKey = key;
    const tiles: string[] = [];
    for (let n = start; n < end; n++) {
      const row = Math.floor(n / cols), col = n % cols;
      const style = `left:${PAD + col * (this.cell + GAP)}px;top:${PAD + row * rowHeight}px;width:${this.cell}px;height:${this.cell}px`;
      tiles.push(tileMarkup(this.items[n], n, this.items.length, n === this.current, row >= firstVisible && row < lastVisible, style));
    }
    this.windowEl.innerHTML = tiles.join("");
  }
}
