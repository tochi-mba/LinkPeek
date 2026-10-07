import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {framePoint, gifStill, videoStill} from "../../src/pages/stills";

let drawn: Array<{width: number; height: number}>, toBlob: ReturnType<typeof vi.fn>;

beforeEach(() => {
  drawn = [];
  toBlob = vi.fn((callback: (blob: Blob | null) => void) => callback(new Blob(["jpeg"], {type: "image/jpeg"})));
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(function (this: HTMLCanvasElement) {
    return {drawImage: () => drawn.push({width: this.width, height: this.height})} as unknown as CanvasRenderingContext2D;
  } as never);
  vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation(function (callback: BlobCallback) {
    toBlob(callback);
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("where a clip's still comes from", () => {
  it("is the same point every time for the same clip, between 5 and 35 percent in", () => {
    const points = Array.from({length: 200}, (_, i) => framePoint(`https://cdn.test/clip${i}.mp4`));
    expect(points.every(point => point >= 0.05 && point < 0.35)).toBe(true);
    expect(framePoint("https://cdn.test/a.mp4")).toBe(framePoint("https://cdn.test/a.mp4"));
    // Different clips land on different points.
    expect(new Set(points.map(point => point.toFixed(3))).size).toBeGreaterThan(100);
  });
});

describe("a GIF's still", () => {
  it("is its first frame, scaled so the longer side is at most 640, and lets the decoded frame go", async () => {
    const close = vi.fn();
    vi.stubGlobal("createImageBitmap", vi.fn(async () => ({width: 1280, height: 720, close})));
    const still = await gifStill(new Blob(["gif"]));
    expect([still.type, drawn, close.mock.calls.length]).toEqual(["image/jpeg", [{width: 640, height: 360}], 1]);
    // Small pictures keep their size.
    vi.stubGlobal("createImageBitmap", vi.fn(async () => ({width: 200, height: 100, close})));
    await gifStill(new Blob(["gif"]));
    expect(drawn.at(-1)).toEqual({width: 200, height: 100});
  });

  it("fails cleanly when the frame cannot be encoded, still letting the frame go", async () => {
    const close = vi.fn();
    vi.stubGlobal("createImageBitmap", vi.fn(async () => ({width: 10, height: 10, close})));
    toBlob.mockImplementationOnce((callback: (blob: Blob | null) => void) => callback(null));
    await expect(gifStill(new Blob(["gif"]))).rejects.toThrow("No still");
    // A source that taints the canvas makes toBlob throw outright.
    toBlob.mockImplementationOnce(() => {
      throw new DOMException("Tainted", "SecurityError");
    });
    await expect(gifStill(new Blob(["gif"]))).rejects.toThrow("Tainted");
    expect(close).toHaveBeenCalledTimes(2);
  });
});

describe("a video's still", () => {
  /** Captures the video element the still maker creates, and lets the test play the browser's part. */
  function capture() {
    const made: HTMLVideoElement[] = [];
    const create = document.createElement.bind(document);
    vi.spyOn(document, "createElement").mockImplementation(((tag: string) => {
      const element = create(tag);
      if (tag === "video") {
        let time = -1;
        Object.defineProperty(element, "currentTime", {get: () => time, set: value => time = value});
        made.push(element as HTMLVideoElement);
      }
      return element;
    }) as typeof document.createElement);
    return made;
  }

  function act(video: HTMLVideoElement, duration: number) {
    Object.defineProperty(video, "duration", {value: duration});
    Object.defineProperty(video, "videoWidth", {value: 1920});
    Object.defineProperty(video, "videoHeight", {value: 1080});
    video.dispatchEvent(new Event("loadedmetadata"));
    video.dispatchEvent(new Event("seeked"));
  }

  it("is the frame at the clip's stable point, muted and let go of afterwards", async () => {
    const made = capture();
    const pending = videoStill("blob:clip", "https://cdn.test/clip.mp4");
    const video = made[0];
    expect([video.muted, video.getAttribute("src")]).toEqual([true, "blob:clip"]);
    act(video, 100);
    const still = await pending;
    expect(still.type).toBe("image/jpeg");
    expect(video.currentTime).toBeCloseTo(100 * framePoint("https://cdn.test/clip.mp4"));
    expect([drawn, video.hasAttribute("src")]).toEqual([[{width: 640, height: 360}], false]);
  });

  it("takes the opening frame of a stream with no known length", async () => {
    const made = capture();
    const pending = videoStill("blob:live", "https://cdn.test/live.mp4");
    act(made[0], Infinity);
    await pending;
    expect(made[0].currentTime).toBe(0);
  });

  it("gives up on a clip that cannot be read, cannot be drawn, or never shows a frame", async () => {
    const made = capture();
    const broken = videoStill("blob:bad", "https://cdn.test/bad.mp4");
    made[0].dispatchEvent(new Event("error"));
    await expect(broken).rejects.toThrow("Unreadable video");
    // A cross-origin clip taints the canvas: the still is refused, not thrown at the page.
    toBlob.mockImplementationOnce(() => {
      throw new DOMException("Tainted", "SecurityError");
    });
    const tainted = videoStill("https://x.test/clip.mp4", "https://x.test/clip.mp4");
    act(made[1], 10);
    await expect(tainted).rejects.toThrow("Tainted");
    vi.useFakeTimers();
    const silent = videoStill("blob:slow", "https://cdn.test/slow.mp4", 500);
    vi.advanceTimersByTime(500);
    await expect(silent).rejects.toThrow("Timed out");
  });
});
