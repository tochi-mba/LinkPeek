import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {resolveSettings, type LinkPeekSettings} from "../../src/shared/settings";

const gif = vi.hoisted(() => ({parseGIF: vi.fn(), decompressFrames: vi.fn()}));
vi.mock("gifuct-js", () => gif);

import {GifPlayer, clearPreparedGifCache, formatMediaTime, gifDuration, gifFrameDelay, gifTimeAtFrame, prepareGif} from "../../src/ui/gif-player";

const frame = (delay = 50, disposalType = 0, left = 0, top = 0, width = 2, height = 2) => ({dims: {left, top, width, height}, patch: new Uint8ClampedArray(width * height * 4), delay, disposalType});
let send: ReturnType<typeof vi.fn>, ctx: Record<string, ReturnType<typeof vi.fn>>, contexts: number;
const settings = (patch: Partial<LinkPeekSettings> = {}) => resolveSettings({gifAutoplay: false, ...patch});

function stage() {
  const el = document.createElement("div");
  el.innerHTML = `<div class="lp-gif-mount"></div>`;
  document.body.append(el);
  return el;
}

async function ready(patch: Partial<LinkPeekSettings> = {}, notice = vi.fn()) {
  const el = stage(), player = new GifPlayer(el, "https://x.test/a.gif", settings(patch), notice);
  await player.init();
  const q = <T extends Element>(selector: string) => el.querySelector<T>(selector)!;
  return {el, player, notice, q, time: () => q(".lp-gif-time").textContent, toggle: () => q<HTMLButtonElement>(".lp-gif-toggle")};
}

const key = (k: string, init: KeyboardEventInit = {}) => new KeyboardEvent("keydown", {key: k, ...init});

beforeEach(() => {
  vi.useFakeTimers();
  clearPreparedGifCache();
  contexts = 0;
  ctx = {clearRect: vi.fn(), getImageData: vi.fn(() => ({})), putImageData: vi.fn(), drawImage: vi.fn()};
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(() => (contexts++, ctx) as never);
  vi.stubGlobal("ImageData", class {
    constructor(public data: Uint8ClampedArray, public width: number, public height: number) {}
  });
  send = vi.fn(async () => ({base64: btoa("abc"), mime: "image/gif", bytes: 3}));
  vi.stubGlobal("chrome", {runtime: {sendMessage: send}});
  gif.parseGIF.mockReset().mockReturnValue({lsd: {width: 10, height: 8}});
  gif.decompressFrames.mockReset().mockReturnValue([frame(20), frame(30, 2), frame(40, 3)]);
  Object.defineProperty(document, "hidden", {configurable: true, value: false});
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

describe("GIF timing helpers", () => {
  it("clamp delays, sum durations and format times", () => {
    expect(gifFrameDelay({delay: Number.NaN})).toBe(100);
    expect(gifFrameDelay({delay: 1})).toBe(20);
    expect(gifDuration([{delay: 20}, {delay: 30}])).toBe(50);
    expect(gifTimeAtFrame([{delay: 20}, {delay: 30}], 1)).toBe(20);
    expect(gifTimeAtFrame([{delay: 20}], -1)).toBe(0);
    expect(formatMediaTime(61_234)).toBe("1:01.23");
    expect(formatMediaTime(-2)).toBe("0:00.00");
  });
});

describe("preparing GIFs", () => {
  it("fetches through the service worker once and keeps the three most recent", async () => {
    const a = await prepareGif("https://x.test/a.gif", 32);
    expect([a.width, a.height, a.frames.length]).toEqual([10, 8, 3]);
    await prepareGif("https://x.test/a.gif", 32);
    expect(send).toHaveBeenCalledTimes(1);
    for (const name of ["b", "c", "d"]) await prepareGif(`https://x.test/${name}.gif`, 32);
    await prepareGif("https://x.test/a.gif", 32);
    expect(send).toHaveBeenCalledTimes(5);
  });

  it("measures the canvas from the frames when the header has no size", async () => {
    gif.parseGIF.mockReturnValue({});
    gif.decompressFrames.mockReturnValue([frame(20, 0, 3, 4, 5, 6)]);
    expect(await prepareGif("https://x.test/b.gif", 32)).toMatchObject({width: 8, height: 10});
  });

  it("reports failures without caching them", async () => {
    send.mockResolvedValueOnce({error: "too big"});
    await expect(prepareGif("https://x.test/bad.gif", 1)).rejects.toThrow("too big");
    send.mockResolvedValueOnce(undefined);
    await expect(prepareGif("https://x.test/bad.gif", 1)).rejects.toThrow("GIF data unavailable");
    gif.decompressFrames.mockReturnValueOnce([]);
    await expect(prepareGif("https://x.test/bad.gif", 1)).rejects.toThrow("No GIF frames found");
    expect((await prepareGif("https://x.test/bad.gif", 1)).frames).toHaveLength(3);
  });
});

describe("the GIF player", () => {
  it("shows the native GIF while preparing, then frame controls", async () => {
    const el = stage(), player = new GifPlayer(el, `https://x.test/"quoted".gif`, settings());
    const init = player.init();
    expect(el.querySelector(".lp-gif-native")!.getAttribute("src")).toBe(`https://x.test/"quoted".gif`);
    await init;
    expect(el.querySelector("canvas")).not.toBeNull();
    expect(el.querySelector(".lp-gif-player")!.getAttribute("data-controls")).toBe("always");
    expect(ctx.drawImage).toHaveBeenCalledTimes(1);
    expect(el.querySelector(".lp-gif-time")!.textContent).toBe("0:00.00 / 0:00.09 · F 1/3");
  });

  it("autoplays, loops and applies frame disposal", async () => {
    const {player, time} = await ready({gifAutoplay: true});
    vi.advanceTimersByTime(20);
    expect(time()).toContain("F 2/3");
    vi.advanceTimersByTime(30);
    expect(time()).toContain("F 3/3");
    expect(ctx.clearRect).toHaveBeenCalledWith(0, 0, 2, 2);
    expect(ctx.getImageData).toHaveBeenCalled();
    vi.advanceTimersByTime(40);
    expect(time()).toContain("F 1/3");
    player.destroy();
  });

  it("stops at the last frame without looping and restarts on play", async () => {
    const {player, time, toggle} = await ready({gifLoop: false});
    player.play();
    player.play();
    vi.advanceTimersByTime(20 + 30 + 40);
    expect(toggle().textContent).toBe("▶");
    expect(time()).toContain("F 3/3");
    player.toggle();
    expect(time()).toContain("F 1/3");
    expect(toggle().getAttribute("aria-label")).toBe("Pause GIF");
    player.toggle();
    expect(toggle().getAttribute("aria-label")).toBe("Play GIF");
  });

  it("steps frames, changes speed and toggles playback from the keyboard", async () => {
    const {player, time, q} = await ready();
    expect(player.key(key("."))).toBe(true);
    expect(player.key(key("."))).toBe(true);
    expect(player.key(key("."))).toBe(true);
    expect(time()).toContain("F 3/3");
    expect(player.key(key(","))).toBe(true);
    expect(time()).toContain("F 2/3");
    expect(player.key(key("]"))).toBe(true);
    expect(q<HTMLSelectElement>(".lp-gif-speed").value).toBe("1.5");
    for (let i = 0; i < 9; i++) player.key(key("["));
    expect(q<HTMLSelectElement>(".lp-gif-speed").value).toBe("0.25");
    expect(player.key(key(" "))).toBe(true);
    player.key(key("]"));
    expect(player.key(key("x"))).toBe(false);
    expect(player.key(key(" ", {ctrlKey: true}))).toBe(false);
  });

  it("ignores keys before frames are ready", () => {
    const player = new GifPlayer(stage(), "https://x.test/a.gif", settings());
    expect(player.key(key(" "))).toBe(false);
  });

  it("responds to every on-screen control", async () => {
    const {el, q, time, player} = await ready();
    q<HTMLButtonElement>(".lp-gif-next").click();
    expect(time()).toContain("F 2/3");
    q<HTMLButtonElement>(".lp-gif-prev").click();
    expect(time()).toContain("F 1/3");
    q<HTMLButtonElement>(".lp-gif-toggle").click();
    expect(q(".lp-gif-toggle").textContent).toBe("Ⅱ");
    const loop = q<HTMLButtonElement>(".lp-gif-loop");
    loop.click();
    expect(loop.getAttribute("aria-pressed")).toBe("false");
    const speed = q<HTMLSelectElement>(".lp-gif-speed");
    speed.value = "2";
    speed.dispatchEvent(new Event("change"));
    speed.value = "";
    speed.dispatchEvent(new Event("change"));
    expect(speed.value).toBe("1");
    player.pause();
    speed.value = "0.5";
    speed.dispatchEvent(new Event("change"));
    const timeline = q<HTMLInputElement>(".lp-gif-timeline");
    timeline.value = "2";
    timeline.dispatchEvent(new Event("input"));
    expect(time()).toContain("F 3/3");
    for (const [deltaX, deltaY] of [[-10, 2], [10, 2], [0, -10], [0, 0]]) {
      const wheel = new WheelEvent("wheel", {deltaX, deltaY, cancelable: true, bubbles: true});
      timeline.dispatchEvent(wheel);
      expect(wheel.defaultPrevented).toBe(true);
    }
    expect(time()).toContain("F 2/3");
    const dbl = new MouseEvent("dblclick", {bubbles: true});
    const parentSaw = vi.fn();
    el.addEventListener("dblclick", parentSaw);
    q(".lp-gif-controls").dispatchEvent(dbl);
    expect(parentSaw).not.toHaveBeenCalled();
  });

  it("pauses in background tabs and resumes on return", async () => {
    const {player, toggle} = await ready({gifAutoplay: true});
    Object.defineProperty(document, "hidden", {configurable: true, value: true});
    document.dispatchEvent(new Event("visibilitychange"));
    expect(toggle().textContent).toBe("▶");
    Object.defineProperty(document, "hidden", {configurable: true, value: false});
    document.dispatchEvent(new Event("visibilitychange"));
    expect(toggle().textContent).toBe("Ⅱ");
    document.dispatchEvent(new Event("visibilitychange"));
    player.destroy();
    player.play();
    vi.advanceTimersByTime(1000);
  });

  it("can advance after a restore disposal frame without a saved canvas", async () => {
    gif.decompressFrames.mockReturnValue([frame(20, 3), frame(20)]);
    const {player} = await ready();
    (player as unknown as {restoreBeforePrevious: ImageData | null}).restoreBeforePrevious = null;
    ctx.putImageData.mockClear();
    player.step(1);
    expect(ctx.putImageData).toHaveBeenCalledTimes(1);
    player.step(-1);
    ctx.putImageData.mockClear();
    player.step(1);
    expect(ctx.putImageData).toHaveBeenCalledTimes(2);
  });

  it("can ignore background tabs", async () => {
    const {toggle} = await ready({gifAutoplay: true, gifPauseWhenHidden: false});
    Object.defineProperty(document, "hidden", {configurable: true, value: true});
    document.dispatchEvent(new Event("visibilitychange"));
    expect(toggle().textContent).toBe("Ⅱ");
  });

  it("falls back to native playback and explains why", async () => {
    send.mockResolvedValueOnce({error: "GIF is larger than the configured frame-control limit"});
    const {el, notice} = await ready();
    expect(el.textContent).toContain("frame controls unavailable");
    expect(notice).toHaveBeenCalledWith("GIF is larger than the configured frame-control limit");
    clearPreparedGifCache();
    send.mockRejectedValueOnce("plain string");
    const quiet = new GifPlayer(stage(), "https://x.test/a.gif", settings());
    await quiet.init();
  });

  it("falls back when the canvas is unavailable, and survives destroy afterwards", async () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    const {el, player} = await ready();
    expect(el.textContent).toContain("frame controls unavailable");
    player.destroy();
  });

  it("does nothing once destroyed while preparing", async () => {
    let finish!: (value: unknown) => void, fail!: (error: Error) => void;
    send.mockImplementationOnce(() => new Promise(resolve => finish = resolve));
    const el = stage(), player = new GifPlayer(el, "https://x.test/slow.gif", settings());
    const pending = player.init();
    player.destroy();
    finish({base64: btoa("abc")});
    await pending;
    expect(el.querySelector("canvas")).toBeNull();
    send.mockImplementationOnce(() => new Promise((_, reject) => fail = reject));
    const failing = new GifPlayer(stage(), "https://x.test/failing.gif", settings());
    const failed = failing.init();
    failing.destroy();
    fail(new Error("late"));
    await failed;
    expect(document.body.textContent).not.toContain("frame controls unavailable");
  });
});
