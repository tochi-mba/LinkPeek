/**
 * Where the preview panel sits: next to the pointer by default, or wherever the
 * person last dragged and resized it. Geometry is always clamped into the
 * viewport, including after the window shrinks.
 */
import type {LinkPeekSettings} from "../shared/settings";

export type Geometry = {left: number; top: number; width: number; height: number};
export type ResizeEdge = "move" | "n" | "e" | "s" | "w" | "ne" | "se" | "sw" | "nw";
export const RESIZE_EDGES: readonly ResizeEdge[] = ["n", "e", "s", "w", "ne", "se", "sw", "nw"];

const MARGIN = 8;
const MIN_WIDTH = 280;
const MIN_HEIGHT = 220;
const ASSUMED_HEIGHT = 480;

export function validGeometry(value: unknown): Geometry | undefined {
  const g = value as Partial<Geometry> | undefined;
  if (!g || ![g.left, g.top, g.width, g.height].every(Number.isFinite)) return undefined;
  return {left: Number(g.left), top: Number(g.top), width: Number(g.width), height: Number(g.height)};
}

export class PanelGeometry {
  remembered?: Geometry;
  private stopDrag?: () => void;

  constructor(private panel: HTMLElement, private onCommit: () => void) {}

  get manipulating() {
    return this.panel.classList.contains("lp-manipulating");
  }

  /** Positions a freshly opened panel. */
  place(x: number, y: number, settings: LinkPeekSettings) {
    if (settings.rememberPanelGeometry && this.remembered) {
      this.apply(this.remembered);
      return;
    }
    const style = this.panel.style, width = Math.min(settings.panelWidth, innerWidth - MARGIN * 2), height = Math.min(ASSUMED_HEIGHT, innerHeight - MARGIN * 2), gap = settings.pointerGap;
    style.width = style.height = style.maxHeight = "";
    let left = x + gap, top = y + gap;
    if (settings.placement === "left") left = x - width - gap;
    else if (settings.placement === "above") top = y - height - gap;
    else if (settings.placement === "auto") {
      if (left + width > innerWidth - 12) left = x - width - gap;
      if (top + height > innerHeight - 12) top = y - height - gap;
    }
    style.left = `${Math.max(MARGIN, Math.min(innerWidth - width - MARGIN, left))}px`;
    style.top = `${Math.max(MARGIN, Math.min(innerHeight - height - MARGIN, top))}px`;
    style.setProperty("--lp-width", `${width}px`);
  }

  /** Applies geometry clamped into the viewport and remembers it. */
  apply(value: Geometry) {
    const maxWidth = Math.max(1, innerWidth - MARGIN * 2), maxHeight = Math.max(1, innerHeight - MARGIN * 2);
    const width = Math.max(Math.min(MIN_WIDTH, maxWidth), Math.min(maxWidth, value.width));
    const height = Math.max(Math.min(MIN_HEIGHT, maxHeight), Math.min(maxHeight, value.height));
    const left = Math.max(MARGIN, Math.min(innerWidth - MARGIN - width, value.left));
    const top = Math.max(MARGIN, Math.min(innerHeight - MARGIN - height, value.top));
    this.remembered = {left, top, width, height};
    const style = this.panel.style;
    style.left = `${left}px`;
    style.top = `${top}px`;
    style.width = `${width}px`;
    style.height = `${height}px`;
    style.maxHeight = `calc(100vh - ${MARGIN * 2}px)`;
    style.setProperty("--lp-width", `${width}px`);
  }

  /** Starts dragging (edge "move") or resizing from an edge or corner. */
  begin(event: PointerEvent, edge: ResizeEdge) {
    event.preventDefault();
    event.stopPropagation();
    this.stopDrag?.();
    this.panel.classList.add("lp-manipulating");
    const rect = this.panel.getBoundingClientRect(), startX = event.clientX, startY = event.clientY;
    const initial = {left: rect.left, top: rect.top, width: rect.width, height: rect.height};
    const move = (e: PointerEvent) => {
      const dx = e.clientX - startX, dy = e.clientY - startY;
      let {left, top, width, height} = initial;
      if (edge === "move") {
        left += dx;
        top += dy;
      } else {
        if (edge.includes("e")) width += dx;
        if (edge.includes("s")) height += dy;
        if (edge.includes("w")) {
          left += dx;
          width -= dx;
        }
        if (edge.includes("n")) {
          top += dy;
          height -= dy;
        }
      }
      this.apply({left, top, width, height});
    };
    const end = () => {
      this.stopDrag?.();
      this.onCommit();
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
    this.stopDrag = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
      this.panel.classList.remove("lp-manipulating");
      this.stopDrag = undefined;
    };
  }

  /** Abandons a drag in progress (the panel closed under it). */
  cancel() {
    this.stopDrag?.();
  }

  /** Keeps a remembered layout inside a smaller window. */
  reclamp(settings: LinkPeekSettings | undefined) {
    if (settings?.rememberPanelGeometry && this.remembered) this.apply(this.remembered);
  }
}
