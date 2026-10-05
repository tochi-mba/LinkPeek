/**
 * A GIF player with real controls: play/pause, frame stepping, a scrubbable
 * timeline, speed and loop. Frames are decoded from bytes the service worker
 * fetches, because a page cannot read pixels of a cross-origin image.
 *
 * Built as its own module and loaded only when a GIF is shown.
 */
import {decompressFrames, parseGIF} from "gifuct-js";
import {escapeHtml} from "../shared/dom";
import type {BinaryResponse} from "../shared/messages";
import type {LinkPeekSettings} from "../shared/settings";

type DecodedFrame = {
  dims: {top: number; left: number; width: number; height: number};
  patch: Uint8ClampedArray;
  delay: number;
  disposalType: number;
};
export type PreparedGif = {frames: DecodedFrame[]; width: number; height: number};

const preparedGifs = new Map<string, Promise<PreparedGif>>();
const PREPARED_CACHE_MAX = 3;
const SPEEDS = [0.25, 0.5, 0.75, 1, 1.5, 2, 4];

/** Browsers clamp very short GIF delays; 20 ms is the fastest frame worth honouring. */
export function gifFrameDelay(frame: Pick<DecodedFrame, "delay">) {
  return Math.max(20, Number(frame.delay) || 100);
}

export function gifDuration(frames: Pick<DecodedFrame, "delay">[]) {
  return frames.reduce((total, frame) => total + gifFrameDelay(frame), 0);
}

export function gifTimeAtFrame(frames: Pick<DecodedFrame, "delay">[], index: number) {
  return gifDuration(frames.slice(0, Math.max(0, index)));
}

export function formatMediaTime(ms: number) {
  const total = Math.max(0, Math.round(ms));
  const minutes = Math.floor(total / 60_000), seconds = Math.floor((total % 60_000) / 1_000), hundredths = Math.floor((total % 1_000) / 10);
  return `${minutes}:${String(seconds).padStart(2, "0")}.${String(hundredths).padStart(2, "0")}`;
}

function decodeBase64(value: string) {
  const binary = atob(value), bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function clearPreparedGifCache() {
  preparedGifs.clear();
}

/** Fetches and decodes a GIF once; the few most recent stay ready for instant replay. */
export function prepareGif(url: string, maxMb: number): Promise<PreparedGif> {
  const existing = preparedGifs.get(url);
  if (existing) {
    preparedGifs.delete(url);
    preparedGifs.set(url, existing);
    return existing;
  }
  const promise = (async () => {
    const response = await chrome.runtime.sendMessage({type: "LINKPEEK_FETCH_BINARY", url, maxMb}) as BinaryResponse | undefined;
    if (!response || "error" in response) throw new Error(response?.error || "GIF data unavailable");
    const parsed = parseGIF(decodeBase64(response.base64).buffer) as {lsd?: {width?: number; height?: number}};
    const frames = decompressFrames(parsed as never, true) as DecodedFrame[];
    if (!frames.length) throw new Error("No GIF frames found");
    const width = Number(parsed.lsd?.width) || Math.max(...frames.map(frame => frame.dims.left + frame.dims.width));
    const height = Number(parsed.lsd?.height) || Math.max(...frames.map(frame => frame.dims.top + frame.dims.height));
    return {frames, width, height};
  })().catch(error => {
    preparedGifs.delete(url);
    throw error;
  });
  preparedGifs.set(url, promise);
  while (preparedGifs.size > PREPARED_CACHE_MAX) preparedGifs.delete(preparedGifs.keys().next().value!);
  return promise;
}

export class GifPlayer {
  private mount: HTMLElement;
  private canvas?: HTMLCanvasElement;
  private ctx?: CanvasRenderingContext2D;
  private patchCanvas?: HTMLCanvasElement;
  private patchCtx?: CanvasRenderingContext2D;
  private frames: DecodedFrame[] = [];
  private frame = 0;
  private rendered = -1;
  private restoreBeforePrevious: ImageData | null = null;
  private playing = false;
  private loop: boolean;
  private speed: number;
  private timer?: number;
  private destroyed = false;
  private resumeAfterVisibility = false;
  private timeline?: HTMLInputElement;
  private toggleButton?: HTMLButtonElement;
  private loopButton?: HTMLButtonElement;
  private speedSelect?: HTMLSelectElement;
  private timeLabel?: HTMLElement;

  constructor(stage: HTMLElement, private url: string, private settings: LinkPeekSettings, private onNotice: (message: string) => void = () => undefined) {
    this.mount = stage.querySelector(".lp-gif-mount") as HTMLElement;
    this.loop = settings.gifLoop;
    this.speed = settings.gifDefaultSpeed;
  }

  async init() {
    // The native image plays straight away while frames decode in the background.
    this.mount.innerHTML = `<div class="lp-gif-native-prep"><img class="lp-image lp-gif-native" src="${escapeHtml(this.url)}" alt="Animated GIF"><span class="lp-gif-preparing">Preparing frame controls…</span></div>`;
    try {
      const prepared = await prepareGif(this.url, this.settings.gifDecodeMaxMb);
      if (this.destroyed) return;
      this.frames = prepared.frames;
      this.build(prepared.width, prepared.height);
      this.renderFrame(0);
      this.updateControls();
      if (this.settings.gifAutoplay) this.play();
      if (this.settings.gifPauseWhenHidden) document.addEventListener("visibilitychange", this.onVisibility);
    } catch (error) {
      if (!this.destroyed) this.fallback(error instanceof Error ? error.message : String(error));
    }
  }

  destroy() {
    this.destroyed = true;
    this.pause();
    document.removeEventListener("visibilitychange", this.onVisibility);
  }

  key(event: KeyboardEvent) {
    if (!this.frames.length || event.ctrlKey || event.metaKey || event.altKey) return false;
    const actions: Record<string, () => void> = {
      " ": () => this.toggle(), ",": () => this.step(-1), ".": () => this.step(1), "[": () => this.changeSpeed(-1), "]": () => this.changeSpeed(1)
    };
    const action = actions[event.key];
    if (!action) return false;
    action();
    return true;
  }

  play() {
    if (!this.frames.length || this.playing) return;
    if (this.frame >= this.frames.length - 1 && !this.loop) this.goto(0);
    this.playing = true;
    this.updateControls();
    this.schedule();
  }

  pause() {
    this.playing = false;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.updateControls();
  }

  toggle() {
    if (this.playing) this.pause();
    else this.play();
  }

  step(delta: number) {
    this.pause();
    this.goto(Math.max(0, Math.min(this.frames.length - 1, this.frame + delta)));
  }

  private build(width: number, height: number) {
    const speeds = SPEEDS.map(value => `<option value="${value}" ${value === this.speed ? "selected" : ""}>${value}×</option>`).join("");
    this.mount.innerHTML = `<div class="lp-gif-player" data-controls="${this.settings.gifControls}">
      <div class="lp-gif-surface"><canvas class="lp-image lp-gif-canvas" aria-label="Animated GIF frame"></canvas></div>
      <div class="lp-gif-controls" role="group" aria-label="GIF playback controls">
        <button class="lp-media-btn lp-gif-prev" type="button" aria-label="Previous GIF frame" title="Previous frame (,)">│‹</button>
        <button class="lp-media-btn lp-gif-toggle" type="button" aria-label="Pause GIF" title="Play / pause (Space)">Ⅱ</button>
        <button class="lp-media-btn lp-gif-next" type="button" aria-label="Next GIF frame" title="Next frame (.)">›│</button>
        <input class="lp-gif-timeline" type="range" min="0" max="${this.frames.length - 1}" step="1" value="0" aria-label="GIF timeline">
        <span class="lp-gif-time" aria-live="off"></span>
        <select class="lp-gif-speed" aria-label="GIF playback speed" title="Playback speed ([ and ])">${speeds}</select>
        <button class="lp-media-btn lp-gif-loop" type="button" aria-label="Loop GIF" aria-pressed="${this.loop}" title="Loop">↻</button>
      </div>
    </div>`;
    this.canvas = this.mount.querySelector(".lp-gif-canvas") as HTMLCanvasElement;
    this.canvas.width = width;
    this.canvas.height = height;
    this.ctx = this.canvas.getContext("2d", {willReadFrequently: true}) ?? undefined;
    this.patchCanvas = document.createElement("canvas");
    this.patchCtx = this.patchCanvas.getContext("2d", {willReadFrequently: true}) ?? undefined;
    if (!this.ctx || !this.patchCtx) throw new Error("Canvas unavailable");
    this.timeline = this.mount.querySelector(".lp-gif-timeline") as HTMLInputElement;
    this.toggleButton = this.mount.querySelector(".lp-gif-toggle") as HTMLButtonElement;
    this.loopButton = this.mount.querySelector(".lp-gif-loop") as HTMLButtonElement;
    this.speedSelect = this.mount.querySelector(".lp-gif-speed") as HTMLSelectElement;
    this.timeLabel = this.mount.querySelector(".lp-gif-time") as HTMLElement;
    this.mount.querySelector(".lp-gif-prev")!.addEventListener("click", () => this.step(-1));
    this.mount.querySelector(".lp-gif-next")!.addEventListener("click", () => this.step(1));
    this.toggleButton.addEventListener("click", () => this.toggle());
    this.loopButton.addEventListener("click", () => {
      this.loop = !this.loop;
      this.updateControls();
    });
    this.speedSelect.addEventListener("change", () => {
      this.speed = Number(this.speedSelect!.value) || 1;
      if (this.playing) this.schedule();
      this.updateControls();
    });
    this.timeline.addEventListener("input", () => {
      // Read the dragged position first: pausing re-syncs the slider to the current frame.
      const target = Number(this.timeline!.value);
      this.pause();
      this.goto(target);
    });
    this.timeline.addEventListener("wheel", this.onTimelineWheel, {passive: false});
    // Double-clicking the controls must not zoom the stage behind them.
    this.mount.querySelector(".lp-gif-controls")!.addEventListener("dblclick", event => event.stopPropagation());
  }

  private fallback(reason: string) {
    this.mount.innerHTML = `<div class="lp-gif-fallback"><img class="lp-image" src="${escapeHtml(this.url)}" alt="Animated GIF"><span>Native GIF playback · frame controls unavailable</span></div>`;
    this.onNotice(reason);
  }

  private onTimelineWheel = (event: WheelEvent) => {
    event.preventDefault();
    event.stopPropagation();
    const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
    if (delta) this.step(delta > 0 ? 1 : -1);
  };

  private onVisibility = () => {
    if (document.hidden) {
      this.resumeAfterVisibility = this.playing;
      if (this.playing) this.pause();
    } else if (this.resumeAfterVisibility) {
      this.resumeAfterVisibility = false;
      this.play();
    }
  };

  private changeSpeed(direction: number) {
    const closest = SPEEDS.reduce((best, value, i) => Math.abs(value - this.speed) < Math.abs(SPEEDS[best] - this.speed) ? i : best, 0);
    this.speed = SPEEDS[Math.max(0, Math.min(SPEEDS.length - 1, closest + direction))];
    if (this.playing) this.schedule();
    this.updateControls();
  }

  private schedule() {
    clearTimeout(this.timer);
    if (!this.playing || this.destroyed) return;
    this.timer = window.setTimeout(() => {
      if (this.frame >= this.frames.length - 1) {
        if (!this.loop) return this.pause();
        this.goto(0);
      } else {
        this.goto(this.frame + 1);
      }
      this.schedule();
    }, gifFrameDelay(this.frames[this.frame]) / Math.max(0.1, this.speed));
  }

  private goto(index: number) {
    this.frame = Math.max(0, Math.min(this.frames.length - 1, index));
    this.renderFrame(this.frame);
    this.updateControls();
  }

  /** Draws frames in order from the last rendered one, restarting from frame 0 when jumping back. */
  private renderFrame(target: number) {
    if (target !== this.rendered + 1) {
      this.ctx!.clearRect(0, 0, this.canvas!.width, this.canvas!.height);
      this.rendered = -1;
      this.restoreBeforePrevious = null;
    }
    for (let i = this.rendered + 1; i <= target; i++) this.applyFrame(i);
  }

  private applyFrame(index: number) {
    const ctx = this.ctx!, canvas = this.canvas!;
    if (this.rendered >= 0) {
      const previous = this.frames[this.rendered];
      if (previous.disposalType === 2) ctx.clearRect(previous.dims.left, previous.dims.top, previous.dims.width, previous.dims.height);
      else if (previous.disposalType === 3 && this.restoreBeforePrevious) ctx.putImageData(this.restoreBeforePrevious, 0, 0);
    }
    const frame = this.frames[index];
    this.restoreBeforePrevious = frame.disposalType === 3 ? ctx.getImageData(0, 0, canvas.width, canvas.height) : null;
    this.patchCanvas!.width = frame.dims.width;
    this.patchCanvas!.height = frame.dims.height;
    this.patchCtx!.clearRect(0, 0, frame.dims.width, frame.dims.height);
    this.patchCtx!.putImageData(new ImageData(new Uint8ClampedArray(frame.patch), frame.dims.width, frame.dims.height), 0, 0);
    ctx.drawImage(this.patchCanvas!, frame.dims.left, frame.dims.top);
    this.rendered = index;
  }

  private updateControls() {
    if (!this.frames.length) return;
    if (this.toggleButton) {
      this.toggleButton.textContent = this.playing ? "Ⅱ" : "▶";
      this.toggleButton.setAttribute("aria-label", this.playing ? "Pause GIF" : "Play GIF");
    }
    this.loopButton?.setAttribute("aria-pressed", String(this.loop));
    if (this.timeline) this.timeline.value = String(this.frame);
    if (this.speedSelect) this.speedSelect.value = String(this.speed);
    if (this.timeLabel) this.timeLabel.textContent = `${formatMediaTime(gifTimeAtFrame(this.frames, this.frame))} / ${formatMediaTime(gifDuration(this.frames))} · F ${this.frame + 1}/${this.frames.length}`;
  }
}
