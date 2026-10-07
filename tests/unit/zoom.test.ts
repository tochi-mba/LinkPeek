import {beforeEach, describe, expect, it, vi} from "vitest";
import {MAX_ZOOM, ZOOM_STEP, ZoomPan} from "../../src/pages/zoom";

let stage: HTMLElement, media: HTMLElement | null, changes: number[], zoom: ZoomPan;

/** A stage 1000×600 at the page's top left, holding media of the given unscaled size. */
function setup(width: number, height: number) {
  stage = document.createElement("div");
  stage.getBoundingClientRect = () => ({left: 0, top: 0, width: 1000, height: 600, right: 1000, bottom: 600, x: 0, y: 0, toJSON: () => ({})});
  Object.defineProperty(stage, "clientWidth", {value: 1000});
  Object.defineProperty(stage, "clientHeight", {value: 600});
  media = document.createElement("img");
  Object.defineProperty(media, "offsetWidth", {value: width});
  Object.defineProperty(media, "offsetHeight", {value: height});
  stage.append(media);
  changes = [];
  zoom = new ZoomPan(stage, () => media, value => changes.push(value));
}

const transform = () => media!.style.transform;

describe("zooming media", () => {
  beforeEach(() => setup(1000, 600));

  it("zooms around the stage's middle by default, and back to fitting", () => {
    zoom.zoomBy(2);
    expect([zoom.zoom, zoom.zoomed, transform()]).toEqual([2, true, "translate(0px, 0px) scale(2)"]);
    zoom.zoomBy(0.5);
    expect([zoom.zoom, zoom.zoomed, transform()]).toEqual([1, false, ""]);
    expect(changes).toEqual([2, 1]);
  });

  it("keeps the point under the pointer still", () => {
    // The pointer 200px right of and 100px below the middle: after doubling, the media moves left and up by as much.
    zoom.zoomBy(2, 700, 400);
    expect(transform()).toBe("translate(-200px, -100px) scale(2)");
  });

  it("never zooms out past fitting, nor in past the limit", () => {
    zoom.zoomBy(0.5);
    expect(zoom.zoom).toBe(1);
    for (let i = 0; i < 20; i++) zoom.zoomBy(ZOOM_STEP);
    expect(zoom.zoom).toBe(MAX_ZOOM);
  });

  it("toggles between twice the size at the pointer and fitting", () => {
    zoom.toggle(500, 300);
    expect(zoom.zoom).toBe(2);
    zoom.toggle();
    expect([zoom.zoom, transform()]).toEqual([1, ""]);
  });

  it("pans only while zoomed, held to the media's edges", () => {
    zoom.panBy(50, 50);
    expect(transform()).toBe("");
    zoom.zoomBy(2);
    zoom.panBy(-120, 80);
    expect(transform()).toBe("translate(-120px, 80px) scale(2)");
    // At twice its size the media can move 500px sideways and 300px up or down before an edge shows.
    zoom.panBy(-10_000, 10_000);
    expect(transform()).toBe("translate(-500px, 300px) scale(2)");
  });
});

describe("media smaller than the stage", () => {
  it("stays centred until it outgrows the stage", () => {
    setup(300, 200);
    zoom.zoomBy(2, 900, 100);
    expect(transform()).toBe("translate(0px, 0px) scale(2)");
    zoom.zoomBy(2, 900, 100);
    // Now 1200×800: 100px of room on each axis, so the pointer's pull is held there.
    expect(transform()).toBe("translate(-100px, 100px) scale(4)");
  });

  it("tells the host even when there is no media to move", () => {
    setup(10, 10);
    media = null;
    zoom.zoomBy(2);
    expect(changes).toEqual([2]);
    const spy = vi.fn();
    new ZoomPan(stage, () => null, spy).reset();
    expect(spy).toHaveBeenCalledWith(1);
  });
});
