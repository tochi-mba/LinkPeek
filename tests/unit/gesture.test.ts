import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {GestureController, type GestureCallbacks} from "../../src/ui/gesture";
import {resolveSettings, type LinkPeekSettings} from "../../src/shared/settings";

let el: HTMLElement, cb: {[K in keyof GestureCallbacks]: ReturnType<typeof vi.fn>}, zoomed: boolean, controller: GestureController;

function make(patch: Partial<LinkPeekSettings> = {}) {
  controller?.destroy();
  controller = new GestureController(el, cb as unknown as GestureCallbacks, resolveSettings({gestureThreshold: 50, navSensitivity: 0.5, gestureCooldown: 100, ...patch}));
}

function wheel(init: WheelEventInit) {
  const event = new WheelEvent("wheel", {cancelable: true, bubbles: true, ...init});
  el.dispatchEvent(event);
  return event;
}

function pointer(type: string, x: number, y: number, init: PointerEventInit = {}) {
  const event = new MouseEvent(type, {bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, ...init});
  Object.defineProperty(event, "pointerId", {value: 1});
  el.dispatchEvent(event);
  return event;
}

beforeEach(() => {
  vi.useFakeTimers({toFake: ["performance", "setTimeout", "Date"]});
  vi.advanceTimersByTime(10_000);
  el = document.createElement("div");
  el.setPointerCapture = vi.fn();
  el.hasPointerCapture = vi.fn(() => true);
  el.releasePointerCapture = vi.fn();
  zoomed = false;
  cb = {next: vi.fn(), previous: vi.fn(), scrub: vi.fn(), zoom: vi.fn(), pan: vi.fn(), doubleClick: vi.fn(), isZoomed: vi.fn(() => zoomed)};
  make();
});
afterEach(() => {
  controller.destroy();
  vi.useRealTimers();
});

describe("scrolling through media", () => {
  it("moves one item per swipe and swallows the momentum tail", () => {
    expect(wheel({deltaY: 30}).defaultPrevented).toBe(true);
    expect(cb.next).not.toHaveBeenCalled();
    wheel({deltaY: 30});
    expect(cb.next).toHaveBeenCalledWith(1);
    wheel({deltaY: 200});
    expect(cb.next).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(100);
    wheel({deltaY: -60});
    expect(cb.previous).toHaveBeenCalledTimes(1);
  });

  it("lets a swipe that turns back through at once, but not a sideways one", () => {
    wheel({deltaY: 60});
    expect(cb.next).toHaveBeenCalledTimes(1);
    wheel({deltaX: -60});
    expect(cb.scrub).not.toHaveBeenCalled();
    wheel({deltaY: -60});
    expect(cb.previous).toHaveBeenCalledTimes(1);
    wheel({deltaY: 0.5});
    wheel({deltaY: -60});
    expect(cb.previous).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(100);
    wheel({deltaX: 60});
    wheel({deltaX: -60});
    expect(cb.scrub.mock.calls.map(([amount]) => Math.sign(amount))).toEqual([1, -1]);
  });

  it("skips several items for a long, fast swipe, up to the limit", () => {
    wheel({deltaY: 500});
    expect(cb.next).toHaveBeenCalledWith(3);
    make({fastSwipeAcceleration: false});
    wheel({deltaY: 500});
    expect(cb.next).toHaveBeenLastCalledWith(1);
  });

  it("can reverse either axis, and can be turned off", () => {
    make({reverseVertical: true});
    wheel({deltaY: 60});
    expect(cb.previous).toHaveBeenCalled();
    make({verticalGesture: "off"});
    expect(wheel({deltaY: 60}).defaultPrevented).toBe(false);
    make({horizontalGesture: "navigate", reverseHorizontal: true});
    wheel({deltaX: 60});
    expect(cb.previous).toHaveBeenCalledTimes(2);
    make({horizontalGesture: "off"});
    expect(wheel({deltaX: 60}).defaultPrevented).toBe(false);
  });

  it("scrubs on a horizontal swipe", () => {
    wheel({deltaX: 80, deltaY: 10});
    expect(cb.scrub).toHaveBeenCalledWith(80);
    make({horizontalGesture: "navigate"});
    wheel({deltaX: 80});
    expect(cb.next).toHaveBeenCalled();
  });

  it("converts line and page wheel units to pixels", () => {
    wheel({deltaY: 4, deltaMode: WheelEvent.DOM_DELTA_LINE});
    expect(cb.next).toHaveBeenCalledWith(1);
    vi.advanceTimersByTime(200);
    wheel({deltaY: 1, deltaMode: WheelEvent.DOM_DELTA_PAGE});
    expect(cb.next).toHaveBeenLastCalledWith(3);
  });

  it("keeps stepping on every threshold without momentum filtering", () => {
    make({momentumFiltering: false});
    wheel({deltaY: 60});
    wheel({deltaY: 60});
    expect(cb.next).toHaveBeenCalledTimes(2);
  });

  it("leaves a regular mouse wheel to the page, or zooms, when asked", () => {
    make({mouseWheel: "scroll"});
    expect(wheel({deltaY: 100}).defaultPrevented).toBe(false);
    make({mouseWheel: "zoom"});
    expect(wheel({deltaY: -100}).defaultPrevented).toBe(true);
    expect(cb.zoom).toHaveBeenCalled();
    wheel({deltaX: 100});
    expect(cb.scrub).toHaveBeenCalled();
  });
});

describe("zooming and panning", () => {
  it("pinches to zoom and pans with the wheel while zoomed", () => {
    wheel({deltaY: -10, ctrlKey: true});
    expect(cb.zoom.mock.calls[0][0]).toBeGreaterThan(1);
    make({pinchZoom: false});
    wheel({deltaY: -10, ctrlKey: true});
    expect(cb.zoom).toHaveBeenCalledTimes(1);
    zoomed = true;
    wheel({deltaX: 10, deltaY: 20});
    expect(cb.pan).toHaveBeenCalledWith(-8.5, -17);
    make({panWhenZoomed: false});
    wheel({deltaY: 100});
    expect(cb.next).toHaveBeenCalled();
  });

  it("drags to pan after a double-tap while zoomed", () => {
    zoomed = true;
    pointer("pointerdown", 10, 10);
    pointer("pointerup", 10, 10);
    pointer("pointerdown", 12, 12);
    expect(el.classList.contains("lp-dragging")).toBe(true);
    pointer("pointermove", 30, 22);
    pointer("pointermove", 30, 22);
    expect(cb.pan).toHaveBeenCalledTimes(1);
    expect(cb.pan).toHaveBeenCalledWith(18, 10);
    pointer("pointerup", 30, 22);
    expect(el.classList.contains("lp-dragging")).toBe(false);
    el.dispatchEvent(new MouseEvent("dblclick", {cancelable: true}));
    expect(cb.doubleClick).not.toHaveBeenCalled();
  });

  it("only drags for a quick, nearby second tap, and survives pointer-capture errors", () => {
    zoomed = true;
    pointer("pointerdown", 0, 0);
    pointer("pointerup", 0, 0);
    pointer("pointerdown", 100, 100);
    expect(el.classList.contains("lp-dragging")).toBe(false);
    pointer("pointerup", 100, 100);
    vi.advanceTimersByTime(500);
    pointer("pointerdown", 100, 100);
    expect(el.classList.contains("lp-dragging")).toBe(false);
    pointer("pointermove", 120, 120);
    pointer("pointerup", 100, 100);
    el.setPointerCapture = vi.fn(() => {
      throw new Error("gone");
    });
    el.releasePointerCapture = vi.fn(() => {
      throw new Error("gone");
    });
    pointer("pointerdown", 100, 100);
    expect(el.classList.contains("lp-dragging")).toBe(true);
    pointer("pointercancel", 100, 100);
    expect(el.classList.contains("lp-dragging")).toBe(false);
    el.hasPointerCapture = vi.fn(() => false);
    pointer("pointerup", 100, 100);
    pointer("pointerdown", 100, 100);
    pointer("pointerup", 100, 100);
  });

  it("ignores drag-pan when not zoomed, for other buttons, or when it is turned off", () => {
    pointer("pointerdown", 0, 0);
    pointer("pointerup", 0, 0);
    pointer("pointerdown", 0, 0);
    zoomed = true;
    pointer("pointerdown", 0, 0, {button: 2});
    pointer("pointerup", 0, 0, {button: 2});
    make({doubleClickDragPan: false});
    pointer("pointerup", 0, 0);
    pointer("pointerdown", 0, 0);
    make({panWhenZoomed: false});
    pointer("pointerup", 0, 0);
    pointer("pointerdown", 0, 0);
    expect(el.classList.contains("lp-dragging")).toBe(false);
  });

  it("reports double-clicks unless they are turned off", () => {
    const event = new MouseEvent("dblclick", {cancelable: true});
    Object.defineProperty(event, "offsetX", {value: 5});
    Object.defineProperty(event, "offsetY", {value: 6});
    el.dispatchEvent(event);
    expect(cb.doubleClick).toHaveBeenCalledWith(5, 6);
    expect(event.defaultPrevented).toBe(true);
    make({doubleClick: "none"});
    el.dispatchEvent(new MouseEvent("dblclick", {cancelable: true}));
    expect(cb.doubleClick).toHaveBeenCalledTimes(1);
  });

  it("stops listening when destroyed", () => {
    controller.destroy();
    wheel({deltaY: 500});
    expect(cb.next).not.toHaveBeenCalled();
  });
});
