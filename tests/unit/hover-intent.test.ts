import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {HoverIntent, anchorFrom, type IntentHost} from "../../src/content/hover-intent";
import {resolveSettings, type LinkPeekSettings} from "../../src/shared/settings";

let settings: LinkPeekSettings, intent: HoverIntent, openAnchor: HTMLAnchorElement | null, prepared: Set<string>, scanning: boolean;
const viewer = {host: document.createElement("div"), isOpen: false, pinned: false, containsPoint: vi.fn(() => false), cancelClose: vi.fn()};
const host: IntentHost = {
  settings: () => settings,
  settingsFor: anchor => anchor.dataset.blocked ? undefined : settings,
  viewer,
  isPrepared: url => prepared.has(url),
  isOpenAnchor: anchor => anchor === openAnchor,
  isScanning: () => scanning,
  onReach: vi.fn(),
  onLinger: vi.fn(),
  onActivate: vi.fn(),
  onLeave: vi.fn()
};
const activations = () => (host.onActivate as ReturnType<typeof vi.fn>).mock.calls.map(([anchor, x, y]) => [(anchor as HTMLAnchorElement).id, x, y]);

function link(id: string, href = `https://x.test/${id}`) {
  const a = document.createElement("a");
  a.id = id;
  a.href = href;
  a.innerHTML = `<span>${id}</span>`;
  document.body.append(a);
  return a;
}

function pointer(type: "pointerover" | "pointermove" | "pointerout", target: Element, x: number, y: number, extra: MouseEventInit = {}) {
  target.dispatchEvent(new MouseEvent(type, {bubbles: true, composed: true, clientX: x, clientY: y, ...extra}));
}

const listeners: Array<[string, EventListener]> = [];
function wire() {
  const forward: Array<[string, (event: PointerEvent) => void]> = [
    ["pointerover", event => intent.onPointerOver(event)], ["pointermove", event => intent.onPointerMove(event)], ["pointerout", event => intent.onPointerOut(event)]
  ];
  for (const [type, handler] of forward) {
    const listener = (event: Event) => handler(event as PointerEvent);
    document.addEventListener(type, listener);
    listeners.push([type, listener]);
  }
}

beforeEach(() => {
  vi.useFakeTimers({toFake: ["setTimeout", "clearTimeout", "performance", "Date"]});
  document.body.innerHTML = "";
  document.body.append(viewer.host);
  settings = resolveSettings({hoverDelay: 300});
  openAnchor = null;
  prepared = new Set();
  scanning = false;
  viewer.isOpen = false;
  viewer.pinned = false;
  viewer.containsPoint.mockReset().mockReturnValue(false);
  viewer.cancelClose.mockReset();
  for (const fn of [host.onReach, host.onLinger, host.onActivate, host.onLeave]) (fn as ReturnType<typeof vi.fn>).mockReset();
  intent = new HoverIntent(host);
  wire();
});
afterEach(() => {
  for (const [type, listener] of listeners.splice(0)) document.removeEventListener(type, listener);
  vi.useRealTimers();
  delete (document as Partial<Document>).elementFromPoint;
});

describe("opening on hover", () => {
  it("opens after the hover delay, preparing the link at once and more deeply shortly after", () => {
    const a = link("a");
    pointer("pointerover", a.firstElementChild!, 10, 10);
    expect(host.onReach).toHaveBeenCalledWith(a);
    vi.advanceTimersByTime(100);
    expect(host.onLinger).toHaveBeenCalledWith(a);
    vi.advanceTimersByTime(199);
    expect(activations()).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(activations()).toEqual([["a", 10, 10]]);
    expect(intent.currentAnchor).toBe(a);
  });

  it("does not open while the pointer sweeps across a link, then opens once it settles", () => {
    const a = link("a");
    pointer("pointerover", a, 0, 0);
    vi.advanceTimersByTime(250);
    pointer("pointermove", a, 30, 0);
    vi.advanceTimersByTime(80);
    pointer("pointermove", a, 60, 0);
    vi.advanceTimersByTime(90 + 159);
    expect(activations()).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(activations()).toEqual([["a", 60, 0]]);
  });

  it("keeps arming while the pointer moves only a little", () => {
    const a = link("a");
    pointer("pointerover", a, 0, 0);
    pointer("pointermove", a, 5, 5);
    vi.advanceTimersByTime(300);
    expect(activations()).toEqual([["a", 5, 5]]);
  });

  it("opens sooner when the pointer comes to rest on a prepared link", () => {
    const a = link("a");
    prepared.add(a.href);
    pointer("pointerover", a, 0, 0);
    vi.advanceTimersByTime(140);
    pointer("pointermove", a, 2, 0);
    vi.advanceTimersByTime(10);
    expect(activations()).toEqual([]);
    vi.advanceTimersByTime(80);
    expect(activations()).toEqual([["a", 2, 0]]);
  });

  it("waits the full delay for links that are not prepared, or when early opening is off", () => {
    const a = link("a");
    pointer("pointerover", a, 0, 0);
    vi.advanceTimersByTime(299);
    expect(activations()).toEqual([]);
    vi.advanceTimersByTime(1);
    settings = resolveSettings({hoverDelay: 300, quickOpenWhenStill: false});
    const b = link("b");
    prepared.add(b.href);
    pointer("pointerover", b, 50, 50);
    vi.advanceTimersByTime(299);
    expect(activations()).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(activations()).toHaveLength(2);
  });

  it("drops an early open if the pointer has already left the link", () => {
    const a = link("a"), b = link("b");
    prepared.add(a.href);
    settings = resolveSettings({hoverDelay: 400});
    pointer("pointerover", a, 0, 0);
    intent.setCurrent(b);
    vi.advanceTimersByTime(400);
    expect(activations()).toEqual([]);
  });

  it("treats a link whose address was recycled as a new link", () => {
    const a = link("a");
    pointer("pointerover", a, 0, 0);
    vi.advanceTimersByTime(200);
    a.href = "https://x.test/recycled";
    pointer("pointermove", a, 1, 1);
    vi.advanceTimersByTime(200);
    expect(activations()).toEqual([]);
    vi.advanceTimersByTime(100);
    expect(activations()).toEqual([["a", 1, 1]]);
  });

  it("tracks pointer speed for prediction, ignoring stale samples", () => {
    const a = link("a");
    pointer("pointermove", a, 0, 0);
    expect(intent.pointer()).toMatchObject({x: 0, y: 0, vx: 0, vy: 0});
    vi.advanceTimersByTime(10);
    pointer("pointermove", a, 100, 50);
    expect(intent.pointer()).toMatchObject({vx: 4, vy: 2});
    vi.advanceTimersByTime(500);
    pointer("pointermove", a, 0, 0);
    expect(intent.pointer()).toMatchObject({vx: 0, vy: 0});
  });
});

describe("links that scroll under the pointer", () => {
  it("cancels a hit-test that Chrome delivers just before the scroll event", () => {
    const a = link("a");
    pointer("pointermove", document.body, 20, 20);
    pointer("pointerover", a, 20, 20);
    intent.onScroll();
    vi.advanceTimersByTime(1000);
    expect(activations()).toEqual([]);
    expect(host.onLinger).not.toHaveBeenCalled();
  });

  it("never open by themselves, but open once the hand moves", () => {
    const a = link("a"), b = link("b");
    pointer("pointermove", b, 20, 20);
    vi.advanceTimersByTime(5);
    intent.onScroll();
    pointer("pointerover", a, 20, 20);
    pointer("pointermove", a, 20, 20);
    vi.advanceTimersByTime(1000);
    expect(activations()).toEqual([]);
    pointer("pointerover", a.firstElementChild!, 20, 20);
    vi.advanceTimersByTime(1000);
    expect(activations()).toEqual([]);
    pointer("pointermove", a, 23, 20);
    vi.advanceTimersByTime(90 + 160);
    expect(activations()).toEqual([["a", 23, 20]]);
  });

  it("open as usual when that protection is turned off", () => {
    settings = resolveSettings({hoverDelay: 300, ignoreScrollHover: false});
    const a = link("a");
    pointer("pointermove", document.body, 20, 20);
    vi.advanceTimersByTime(5);
    intent.onScroll();
    pointer("pointerover", a, 20, 20);
    vi.advanceTimersByTime(300);
    expect(activations()).toHaveLength(1);
  });
});

describe("activation modes", () => {
  it("needs Alt held in modifier mode", () => {
    settings = resolveSettings({hoverDelay: 300, activationMode: "modifier"});
    const a = link("a");
    pointer("pointerover", a, 0, 0);
    vi.advanceTimersByTime(400);
    expect(activations()).toEqual([]);
    pointer("pointermove", a, 2, 0, {altKey: true});
    pointer("pointermove", a, 3, 0, {altKey: true});
    vi.advanceTimersByTime(299);
    pointer("pointermove", a, 4, 0);
    vi.advanceTimersByTime(10);
    expect(activations()).toEqual([]);
    pointer("pointermove", a, 5, 0, {altKey: true});
    vi.advanceTimersByTime(300);
    expect(activations()).toEqual([["a", 5, 0]]);
    const b = link("b");
    pointer("pointerover", b, 9, 9, {altKey: true});
    vi.advanceTimersByTime(300);
    expect(activations()).toHaveLength(2);
  });

  it("ignores hover entirely in click mode", () => {
    settings = resolveSettings({activationMode: "click"});
    const a = link("a");
    pointer("pointerover", a, 0, 0);
    pointer("pointermove", a, 5, 0);
    vi.advanceTimersByTime(1000);
    intent.onMutation();
    expect(host.onReach).not.toHaveBeenCalled();
    expect(activations()).toEqual([]);
  });
});

describe("leaving and the preview", () => {
  it("reports leaving a link, but not moving within it or into the preview", () => {
    const a = link("a"), outside = document.createElement("p");
    document.body.append(outside);
    pointer("pointerover", a, 0, 0);
    pointer("pointerout", a, 0, 0, {relatedTarget: a.firstElementChild});
    pointer("pointerout", a, 0, 0, {relatedTarget: viewer.host});
    expect(host.onLeave).not.toHaveBeenCalled();
    pointer("pointerout", outside, 0, 0);
    pointer("pointerout", link("other"), 0, 0, {relatedTarget: outside});
    expect(host.onLeave).not.toHaveBeenCalled();
    pointer("pointerout", a, 0, 0, {relatedTarget: outside});
    expect(host.onLeave).toHaveBeenCalledWith(a);
    expect(intent.currentAnchor).toBeNull();
    vi.advanceTimersByTime(1000);
    expect(activations()).toEqual([]);
  });

  it("keeps the open link current when leaving it toward the preview", () => {
    const a = link("a");
    pointer("pointerover", a, 0, 0);
    openAnchor = a;
    pointer("pointerout", a, 0, 0, {relatedTarget: document.body});
    expect(intent.currentAnchor).toBe(a);
  });

  it("keeps the preview open while the pointer is in it or on the way to it", () => {
    const a = link("a"), inner = document.createElement("span");
    viewer.host.append(inner);
    pointer("pointerover", inner, 0, 0);
    pointer("pointermove", inner, 1, 0);
    expect(viewer.cancelClose).toHaveBeenCalledTimes(2);
    pointer("pointerover", a, 0, 0);
    viewer.containsPoint.mockReturnValue(true);
    pointer("pointermove", document.body, 50, 50);
    expect(viewer.cancelClose).toHaveBeenCalledTimes(3);
  });

  it("opens nothing new while the preview is pinned, and leaves the open link alone", () => {
    const a = link("a");
    viewer.isOpen = true;
    viewer.pinned = true;
    pointer("pointerover", a, 0, 0);
    expect(host.onReach).toHaveBeenCalled();
    vi.advanceTimersByTime(1000);
    viewer.pinned = false;
    openAnchor = a;
    pointer("pointerover", a, 1, 0);
    pointer("pointermove", a, 2, 0);
    vi.advanceTimersByTime(1000);
    expect(activations()).toEqual([]);
  });

  it("does not re-arm while a scan is running", () => {
    const a = link("a");
    pointer("pointerover", a, 0, 0);
    scanning = true;
    pointer("pointermove", a, 40, 0);
    pointer("pointermove", a, 41, 0);
    vi.advanceTimersByTime(1000);
    expect(activations()).toEqual([]);
  });

  it("drops links that may not be previewed", () => {
    const a = link("a");
    pointer("pointerover", a, 0, 0);
    a.dataset.blocked = "1";
    pointer("pointerover", a, 0, 0);
    expect(intent.currentAnchor).toBeNull();
    link("c").dataset.blocked = "1";
    pointer("pointerover", document.getElementById("c")!, 0, 0);
    vi.advanceTimersByTime(1000);
    expect(activations()).toEqual([]);
  });
});

describe("dismissing a preview", () => {
  it("does not reopen a dismissed link until the pointer leaves it", () => {
    const a = link("a");
    pointer("pointerover", a, 5, 5);
    document.elementFromPoint = () => a.firstElementChild;
    intent.dismiss();
    pointer("pointerover", a.firstElementChild!, 6, 5);
    pointer("pointermove", a, 7, 5);
    vi.advanceTimersByTime(1000);
    expect(activations()).toEqual([]);
    pointer("pointerout", a, 7, 5, {relatedTarget: document.body});
    pointer("pointerover", a, 8, 5);
    vi.advanceTimersByTime(300);
    expect(activations()).toEqual([["a", 8, 5]]);
  });

  it("does not block a link the pointer is not on", () => {
    const a = link("a");
    intent.setCurrent(a);
    document.elementFromPoint = () => null;
    intent.dismiss();
    pointer("pointerover", a, 1, 1);
    vi.advanceTimersByTime(300);
    expect(activations()).toHaveLength(1);
    intent.setCurrent(null);
    intent.dismiss();
  });
});

describe("links that appear under a resting pointer", () => {
  it("are considered when the page changes", () => {
    const a = link("a");
    pointer("pointermove", document.body, 3, 3);
    intent.onMutation();
    document.elementFromPoint = () => a;
    intent.onMutation();
    vi.advanceTimersByTime(300);
    expect(activations()).toEqual([["a", 3, 3]]);
    expect(anchorFrom(null)).toBeNull();
    expect(anchorFrom(document.body)).toBeNull();
  });
});

describe("timer guards", () => {
  it("does not arm twice or schedule duplicate linger work", () => {
    const a = link("a");
    const internal = intent as unknown as {
      consider: (anchor: HTMLAnchorElement) => void;
      armLinger: (anchor: HTMLAnchorElement) => void;
      armTimer?: number;
      lastScrollAt: number;
      lastPhysicalMoveAt: number;
    };
    intent.setCurrent(a);
    internal.armTimer = window.setTimeout(() => undefined, 100);
    internal.consider(a);
    internal.armLinger(a);
    internal.armLinger(a);
    expect(host.onReach).toHaveBeenCalledWith(a);

    clearTimeout(internal.armTimer);
    internal.armTimer = undefined;
    internal.lastScrollAt = 10;
    internal.lastPhysicalMoveAt = 0;
    internal.consider(a);
    settings = resolveSettings({activationMode: "modifier"});
    internal.lastScrollAt = 0;
    internal.lastPhysicalMoveAt = 10;
    internal.consider(a);
    settings = resolveSettings({activationMode: "hover"});
    internal.consider(a);
    expect(activations()).toEqual([]);
  });
});
