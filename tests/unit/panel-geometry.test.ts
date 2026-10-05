import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {PanelGeometry, RESIZE_EDGES, validGeometry} from "../../src/ui/panel-geometry";
import {resolveSettings, type LinkPeekSettings} from "../../src/shared/settings";

let panel: HTMLElement, commit: ReturnType<typeof vi.fn>, geometry: PanelGeometry;
const settings = (patch: Partial<LinkPeekSettings> = {}) => resolveSettings({panelWidth: 400, pointerGap: 10, ...patch});
const box = () => ({left: panel.style.left, top: panel.style.top, width: panel.style.width, height: panel.style.height});

function pointerDown(x: number, y: number) {
  const event = new MouseEvent("pointerdown", {clientX: x, clientY: y, cancelable: true});
  return event as PointerEvent;
}
const move = (x: number, y: number) => window.dispatchEvent(new MouseEvent("pointermove", {clientX: x, clientY: y}));

beforeEach(() => {
  panel = document.createElement("section");
  document.body.append(panel);
  commit = vi.fn();
  geometry = new PanelGeometry(panel, commit);
  panel.getBoundingClientRect = () => ({left: 100, top: 100, width: 400, height: 300, right: 500, bottom: 400, x: 100, y: 100, toJSON: () => ({})});
});
afterEach(() => {
  geometry.cancel();
  document.body.innerHTML = "";
});

describe("placing a new panel", () => {
  it("opens beside the pointer and flips away from the window edges", () => {
    geometry.place(100, 100, settings());
    expect(box()).toMatchObject({left: "110px", top: "110px", width: "", height: ""});
    expect(panel.style.getPropertyValue("--lp-width")).toBe("400px");
    geometry.place(900, 600, settings());
    expect(box()).toMatchObject({left: "490px", top: "110px"});
  });

  it("honours a fixed placement and keeps the panel on screen", () => {
    geometry.place(300, 300, settings({placement: "left"}));
    expect(panel.style.left).toBe("8px");
    geometry.place(300, 600, settings({placement: "above"}));
    expect(panel.style.top).toBe("110px");
    geometry.place(1000, 700, settings({placement: "below"}));
    expect(box()).toMatchObject({left: "616px", top: "280px"});
    geometry.place(1000, 10, settings({placement: "right"}));
    expect(panel.style.left).toBe("616px");
  });

  it("reuses the remembered layout when that is on", () => {
    geometry.remembered = {left: 50, top: 60, width: 500, height: 400};
    geometry.place(900, 600, settings());
    expect(box()).toEqual({left: "50px", top: "60px", width: "500px", height: "400px"});
    expect(panel.style.maxHeight).toBe("calc(100vh - 16px)");
    geometry.place(100, 100, settings({rememberPanelGeometry: false}));
    expect(box()).toMatchObject({left: "110px", width: ""});
  });
});

describe("clamping", () => {
  it("keeps every edge inside the window and enforces a minimum size", () => {
    geometry.apply({left: -50, top: 5000, width: 100, height: 50});
    expect(geometry.remembered).toEqual({left: 8, top: 768 - 8 - 220, width: 280, height: 220});
    geometry.apply({left: 0, top: 0, width: 5000, height: 5000});
    expect(geometry.remembered).toEqual({left: 8, top: 8, width: 1024 - 16, height: 768 - 16});
  });

  it("re-applies a remembered layout after the window changes, when remembering is on", () => {
    geometry.reclamp(settings());
    expect(panel.style.left).toBe("");
    geometry.remembered = {left: 900, top: 10, width: 400, height: 300};
    geometry.reclamp(settings({rememberPanelGeometry: false}));
    expect(panel.style.left).toBe("");
    geometry.reclamp(settings());
    expect(panel.style.left).toBe(`${1024 - 8 - 400}px`);
    geometry.reclamp(undefined);
  });
});

describe("dragging and resizing", () => {
  it("moves the panel with the pointer and commits when released", () => {
    const down = pointerDown(120, 120);
    geometry.begin(down, "move");
    expect(down.defaultPrevented).toBe(true);
    expect(geometry.manipulating).toBe(true);
    move(170, 150);
    expect(box()).toMatchObject({left: "150px", top: "130px", width: "400px", height: "300px"});
    window.dispatchEvent(new MouseEvent("pointerup"));
    expect(commit).toHaveBeenCalledTimes(1);
    expect(geometry.manipulating).toBe(false);
    move(500, 500);
    expect(panel.style.left).toBe("150px");
  });

  it("resizes from every edge and corner", () => {
    const resize = (edge: Parameters<PanelGeometry["begin"]>[1], dx: number, dy: number) => {
      geometry.begin(pointerDown(0, 0), edge);
      move(dx, dy);
      window.dispatchEvent(new MouseEvent("pointercancel"));
      return {...geometry.remembered};
    };
    expect(resize("e", 50, 0)).toMatchObject({left: 100, width: 450});
    expect(resize("s", 0, 40)).toMatchObject({top: 100, height: 340});
    expect(resize("w", 30, 0)).toMatchObject({left: 130, width: 370});
    expect(resize("n", 0, 30)).toMatchObject({top: 130, height: 270});
    expect(resize("nw", -20, -20)).toMatchObject({left: 80, top: 80, width: 420, height: 320});
    expect(resize("se", 10, 10)).toMatchObject({width: 410, height: 310});
    expect(RESIZE_EDGES).toHaveLength(8);
  });

  it("abandons an earlier drag when a new one starts, and on cancel", () => {
    geometry.begin(pointerDown(0, 0), "move");
    geometry.begin(pointerDown(0, 0), "e");
    move(10, 0);
    expect(geometry.remembered).toMatchObject({left: 100, width: 410});
    geometry.cancel();
    expect(geometry.manipulating).toBe(false);
    geometry.cancel();
    expect(commit).not.toHaveBeenCalled();
  });
});

describe("stored layouts", () => {
  it("are only used when every number is valid", () => {
    expect(validGeometry({left: 1, top: 2, width: 3, height: 4})).toEqual({left: 1, top: 2, width: 3, height: 4});
    expect(validGeometry({left: 1, top: 2, width: Number.NaN, height: 4})).toBeUndefined();
    expect(validGeometry(undefined)).toBeUndefined();
  });
});
