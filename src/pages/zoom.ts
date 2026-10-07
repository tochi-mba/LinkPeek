/**
 * Zoom and pan for one piece of media centred in a stage: a picture, a GIF or
 * a video alike. Zooming keeps the point under the pointer still; panning is
 * held to the media's edges, and media smaller than the stage stays centred.
 */

/** One step of +, - or Ctrl+scroll. */
export const ZOOM_STEP = 1.25;
export const MAX_ZOOM = 8;

export class ZoomPan {
  zoom = 1;
  private x = 0;
  private y = 0;

  constructor(private stage: HTMLElement, private media: () => HTMLElement | null, private onChange: (zoom: number) => void) {}

  get zoomed() {
    return this.zoom > 1;
  }

  /** Back to fitting the stage. */
  reset() {
    this.zoom = 1;
    this.x = this.y = 0;
    this.paint();
  }

  /** Zooms by `factor`, keeping the stage point (clientX, clientY) still; the middle of the stage when none is given. */
  zoomBy(factor: number, clientX?: number, clientY?: number) {
    const before = this.zoom;
    this.zoom = Math.min(MAX_ZOOM, Math.max(1, before * factor));
    if (this.zoom === 1) {
      this.reset();
      return;
    }
    const rect = this.stage.getBoundingClientRect();
    // The point relative to the stage's middle, where the media's own middle sits.
    const px = (clientX ?? rect.left + rect.width / 2) - (rect.left + rect.width / 2);
    const py = (clientY ?? rect.top + rect.height / 2) - (rect.top + rect.height / 2);
    const ratio = this.zoom / before;
    this.x = px - (px - this.x) * ratio;
    this.y = py - (py - this.y) * ratio;
    this.paint();
  }

  /** Double-click: twice the size at the pointer, or back to fitting. */
  toggle(clientX?: number, clientY?: number) {
    if (this.zoomed) this.reset();
    else this.zoomBy(2, clientX, clientY);
  }

  panBy(dx: number, dy: number) {
    if (!this.zoomed) return;
    this.x += dx;
    this.y += dy;
    this.paint();
  }

  /** Holds the media to its edges: zoomed past the stage it can be moved until an edge meets the stage's; otherwise it stays centred. */
  private clamp(media: HTMLElement) {
    const room = (size: number, view: number) => Math.max(0, (size * this.zoom - view) / 2);
    const maxX = room(media.offsetWidth, this.stage.clientWidth), maxY = room(media.offsetHeight, this.stage.clientHeight);
    this.x = Math.min(maxX, Math.max(-maxX, this.x));
    this.y = Math.min(maxY, Math.max(-maxY, this.y));
  }

  private paint() {
    const media = this.media();
    if (media) {
      this.clamp(media);
      media.style.transform = this.zoomed ? `translate(${this.x}px, ${this.y}px) scale(${this.zoom})` : "";
    }
    this.onChange(this.zoom);
  }
}
