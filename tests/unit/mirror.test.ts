import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import type {ScanResult} from "../../src/shared/media";
import {loadPage, settle, stubExtension, type PageHarness} from "./page-harness";

const viewers = vi.hoisted(() => [] as any[]);
vi.mock("../../src/ui/viewer", () => ({
  Viewer: class {
    openLoading = vi.fn();
    fillWindow = vi.fn();
    show = vi.fn();
    jumpTo = vi.fn();
    restoreViewerState = vi.fn();
    key = vi.fn(() => false);
    onDismiss?: () => void;
    onPosition?: () => void;
    constructor(public options: unknown) {
      viewers.push(this);
    }
  }
}));

const gallery = (url = "https://forum.test/t/one", count = 2): ScanResult => ({
  url, kind: "generic", title: "Gallery", complete: true,
  items: Array.from({length: count}, (_, index) => ({
    id: `${url}#${index}`, type: "image", originalUrl: `${url}/${index}.jpg`, previewUrl: `${url}/${index}.jpg`, sourceUrl: url, score: 1
  })),
  diagnostics: {adapter: "test", ignored: 0, duplicates: 0, warnings: []}
});

let harness: PageHarness;
let listener: (message: unknown) => boolean;
let keyListeners: EventListener[] = [];

async function open(sendFails = false) {
  vi.resetModules();
  loadPage("mirror.html");
  viewers.length = 0;
  harness = stubExtension();
  harness.chrome.runtime.onMessage = {addListener: vi.fn((callback: typeof listener) => listener = callback)};
  if (sendFails) harness.chrome.runtime.sendMessage.mockRejectedValueOnce(new Error("worker stopped"));
  harness.chrome.windows = {
    getCurrent: vi.fn(async () => ({id: 12, state: "normal"})),
    update: vi.fn(async () => undefined)
  };
  const add = document.addEventListener.bind(document);
  vi.spyOn(document, "addEventListener").mockImplementation((type: string, callback: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions) => {
    add(type, callback, options);
    if (type === "keydown" && typeof callback === "function") keyListeners.push(callback);
  });
  await import("../../src/pages/mirror");
  await settle();
  return viewers[0];
}

beforeEach(() => {
  keyListeners = [];
  Object.defineProperty(window, "innerWidth", {configurable: true, value: 1200});
  Object.defineProperty(window, "innerHeight", {configurable: true, value: 800});
});

afterEach(() => {
  for (const listener of keyListeners) document.removeEventListener("keydown", listener);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

describe("the mirror window", () => {
  it("follows new galleries and leaves a locally browsed gallery in place", async () => {
    const viewer = await open();
    expect(viewer.options).toMatchObject({persist: false});
    expect(viewer.options.budget()).toMatchObject({speculative: false, imageConcurrency: 6});
    expect(viewer.restoreViewerState).toHaveBeenCalledWith({expanded: false});
    expect(harness.messages).toContainEqual({type: "LINKPEEK_MIRROR_READY"});

    const first = gallery();
    expect(listener({type: "unrelated"})).toBe(false);
    expect(listener({type: "LINKPEEK_MIRROR_STATE", result: first, index: 1})).toBe(false);
    expect(document.getElementById("hint")!.hidden).toBe(true);
    expect(viewer.openLoading).toHaveBeenCalledWith(600, 400, expect.any(Object), "Gallery", 1);
    expect(viewer.fillWindow).toHaveBeenCalledOnce();
    expect(viewer.show).toHaveBeenLastCalledWith(first);
    expect(viewer.jumpTo).toHaveBeenLastCalledWith(1);

    viewer.onPosition();
    listener({type: "LINKPEEK_MIRROR_STATE", result: first, index: 0});
    expect(viewer.jumpTo).toHaveBeenCalledTimes(1);

    const second = {...gallery("https://forum.test/t/two"), title: undefined};
    listener({type: "LINKPEEK_MIRROR_STATE", result: second, index: 0});
    expect(viewer.openLoading).toHaveBeenCalledTimes(2);
    expect(viewer.openLoading).toHaveBeenLastCalledWith(600, 400, expect.any(Object), second.url, 0);
    expect(viewer.jumpTo).toHaveBeenLastCalledWith(0);

    viewer.onDismiss();
    expect(document.getElementById("hint")!.hidden).toBe(false);
  });

  it("supports F11 fullscreen and forwards other keys to the viewer", async () => {
    const viewer = await open(true);
    const f11 = new KeyboardEvent("keydown", {key: "F11", bubbles: true, cancelable: true});
    document.dispatchEvent(f11);
    await settle();
    expect(f11.defaultPrevented).toBe(true);
    expect(harness.chrome.windows.update).toHaveBeenCalledWith(12, {state: "fullscreen"});

    harness.chrome.windows.getCurrent.mockResolvedValueOnce({id: 12, state: "fullscreen"});
    document.dispatchEvent(new KeyboardEvent("keydown", {key: "F11", bubbles: true, cancelable: true}));
    await settle();
    expect(harness.chrome.windows.update).toHaveBeenLastCalledWith(12, {state: "normal"});

    viewer.key.mockReturnValueOnce(false).mockReturnValueOnce(true);
    const ignored = new KeyboardEvent("keydown", {key: "x", bubbles: true, cancelable: true});
    document.dispatchEvent(ignored);
    expect(ignored.defaultPrevented).toBe(false);
    const handled = new KeyboardEvent("keydown", {key: "g", bubbles: true, cancelable: true});
    document.dispatchEvent(handled);
    expect(handled.defaultPrevented).toBe(true);
  });
});
