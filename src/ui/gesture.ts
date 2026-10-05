/**
 * Turns trackpad and mouse input on the media stage into gallery actions.
 *
 * Wheel deltas accumulate until they cross a threshold, then a cooldown swallows
 * the momentum tail, so one physical swipe is one step (or a few, for a fast
 * swipe) rather than a dozen. Ctrl+wheel (a trackpad pinch) zooms; while zoomed
 * the wheel pans; double-click zooms; double-click-and-hold drags to pan.
 */
import type {LinkPeekSettings} from "../shared/settings";

export interface GestureCallbacks {
  next: (count?: number) => void;
  previous: (count?: number) => void;
  scrub: (delta: number) => void;
  zoom: (factor: number, x: number, y: number) => void;
  pan: (dx: number, dy: number) => void;
  doubleClick: (x: number, y: number) => void;
  isZoomed: () => boolean;
}

const LINE_HEIGHT_PX = 16;
const DOUBLE_TAP_MS = 360;
const DOUBLE_TAP_RADIUS_PX = 28;

export class GestureController {
  private accX = 0;
  private accY = 0;
  private lockedUntil = 0;
  /** Direction of the swipe that last stepped, on the axis it stepped along. */
  private lockedSign = 0;
  private lockedHorizontal = false;
  private lastUpAt = 0;
  private lastUpX = 0;
  private lastUpY = 0;
  private dragPointer: number | undefined;
  private dragX = 0;
  private dragY = 0;
  private dragMoved = false;
  private suppressDoubleUntil = 0;

  constructor(private el: HTMLElement, private cb: GestureCallbacks, private settings: LinkPeekSettings) {
    el.addEventListener("wheel", this.onWheel, {passive: false});
    el.addEventListener("dblclick", this.onDoubleClick);
    el.addEventListener("pointerdown", this.onPointerDown);
    el.addEventListener("pointermove", this.onPointerMove);
    el.addEventListener("pointerup", this.onPointerUp);
    el.addEventListener("pointercancel", this.onPointerCancel);
  }

  destroy() {
    this.el.removeEventListener("wheel", this.onWheel);
    this.el.removeEventListener("dblclick", this.onDoubleClick);
    this.el.removeEventListener("pointerdown", this.onPointerDown);
    this.el.removeEventListener("pointermove", this.onPointerMove);
    this.el.removeEventListener("pointerup", this.onPointerUp);
    this.el.removeEventListener("pointercancel", this.onPointerCancel);
  }

  private stepCount(delta: number) {
    if (!this.settings.fastSwipeAcceleration) return 1;
    return Math.min(this.settings.maxImagesPerSwipe, Math.max(1, Math.floor(Math.abs(delta) / (this.settings.gestureThreshold * 1.8))));
  }

  private step(delta: number, count: number) {
    if (delta > 0) this.cb.next(count);
    else this.cb.previous(count);
  }

  private onWheel = (event: WheelEvent) => {
    const s = this.settings;
    const unit = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? LINE_HEIGHT_PX : event.deltaMode === WheelEvent.DOM_DELTA_PAGE ? Math.max(320, this.el.clientHeight) : 1;
    const dx = event.deltaX * unit, dy = event.deltaY * unit;
    if (event.ctrlKey && s.pinchZoom) {
      event.preventDefault();
      this.cb.zoom(Math.exp(-dy * 0.004 * s.pinchSensitivity), event.offsetX, event.offsetY);
      return;
    }
    if (this.cb.isZoomed() && s.panWhenZoomed) {
      event.preventDefault();
      this.cb.pan(-dx * s.panFriction, -dy * s.panFriction);
      return;
    }
    if (s.mouseWheel === "scroll") return;
    if (s.mouseWheel === "zoom" && Math.abs(dy) >= Math.abs(dx)) {
      event.preventDefault();
      this.cb.zoom(Math.exp(-dy * 0.002 * s.pinchSensitivity), event.offsetX, event.offsetY);
      return;
    }
    const horizontal = Math.abs(dx) > Math.abs(dy) * 1.25;
    if ((horizontal ? s.horizontalGesture : s.verticalGesture) === "off") return;
    event.preventDefault();
    const now = performance.now();
    // The coasting tail of the swipe that just stepped is discarded rather than let it fire a late extra step.
    // Momentum only ever continues the same way, so turning back counts at once.
    const reversed = horizontal === this.lockedHorizontal && Math.sign(horizontal ? dx : dy) === -this.lockedSign;
    if (s.momentumFiltering && now < this.lockedUntil && !reversed) {
      this.accX = this.accY = 0;
      return;
    }
    this.accX += dx;
    this.accY += dy;
    const threshold = Math.max(12, s.gestureThreshold * (1.2 - s.navSensitivity * 0.4));
    const amount = horizontal ? this.accX * (s.reverseHorizontal ? -1 : 1) : this.accY * (s.reverseVertical ? -1 : 1);
    if (Math.abs(horizontal ? this.accX : this.accY) < threshold) return;
    if (horizontal && s.horizontalGesture === "scrub") this.cb.scrub(amount);
    else this.step(amount, this.stepCount(amount));
    this.lockedSign = Math.sign(horizontal ? this.accX : this.accY);
    this.lockedHorizontal = horizontal;
    this.accX = this.accY = 0;
    this.lockedUntil = now + (s.momentumFiltering ? s.gestureCooldown : 0);
  };

  private onPointerDown = (event: PointerEvent) => {
    if (event.button !== 0 || !this.settings.doubleClickDragPan || !this.settings.panWhenZoomed || !this.cb.isZoomed()) return;
    const near = Math.hypot(event.clientX - this.lastUpX, event.clientY - this.lastUpY) <= DOUBLE_TAP_RADIUS_PX;
    if (performance.now() - this.lastUpAt > DOUBLE_TAP_MS || !near) return;
    this.dragPointer = event.pointerId;
    this.dragX = event.clientX;
    this.dragY = event.clientY;
    this.dragMoved = false;
    this.el.classList.add("lp-dragging");
    try {
      this.el.setPointerCapture(event.pointerId);
    } catch {
      // The pointer may already be gone; dragging still works within the stage.
    }
    event.preventDefault();
  };

  private onPointerMove = (event: PointerEvent) => {
    if (this.dragPointer !== event.pointerId) return;
    const dx = event.clientX - this.dragX, dy = event.clientY - this.dragY;
    this.dragX = event.clientX;
    this.dragY = event.clientY;
    if (Math.abs(dx) + Math.abs(dy) >= 1) {
      this.dragMoved = true;
      this.cb.pan(dx, dy);
    }
    event.preventDefault();
  };

  private finishPointer(event: PointerEvent, cancelled: boolean) {
    if (this.dragPointer === event.pointerId) {
      if (this.dragMoved) this.suppressDoubleUntil = performance.now() + 120;
      this.dragPointer = undefined;
      this.dragMoved = false;
      this.el.classList.remove("lp-dragging");
      try {
        if (this.el.hasPointerCapture(event.pointerId)) this.el.releasePointerCapture(event.pointerId);
      } catch {
        // Capture was already released.
      }
      event.preventDefault();
    }
    if (!cancelled && event.button === 0) {
      this.lastUpAt = performance.now();
      this.lastUpX = event.clientX;
      this.lastUpY = event.clientY;
    }
  }

  private onPointerUp = (event: PointerEvent) => this.finishPointer(event, false);
  private onPointerCancel = (event: PointerEvent) => this.finishPointer(event, true);

  private onDoubleClick = (event: MouseEvent) => {
    if (performance.now() < this.suppressDoubleUntil) {
      event.preventDefault();
      return;
    }
    if (this.settings.doubleClick === "none") return;
    event.preventDefault();
    this.cb.doubleClick(event.offsetX, event.offsetY);
  };
}
