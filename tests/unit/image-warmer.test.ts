import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {ImageWarmer} from "../../src/content/image-warmer";
import type {Budget} from "../../src/content/resource-governor";

class FakeImage {
  static all: FakeImage[] = [];
  decoding = "";
  fetchPriority = "";
  src = "";
  decoded = 0;
  private listeners: Record<string, () => void> = {};
  constructor() {
    FakeImage.all.push(this);
  }
  addEventListener(type: string, listener: () => void) {
    this.listeners[type] = listener;
  }
  decode() {
    this.decoded++;
    return this.src.includes("bad-decode") ? Promise.reject(new Error("decode")) : Promise.resolve();
  }
  load() {
    this.listeners.load();
  }
  fail() {
    this.listeners.error();
  }
}

const started = () => FakeImage.all.map(img => img.src);
const flush = () => new Promise(resolve => setTimeout(resolve, 0));
let idle: Array<(deadline: IdleDeadline) => void>;
let concurrency: number;
const budget = () => ({imageConcurrency: concurrency}) as Budget;

beforeEach(() => {
  FakeImage.all = [];
  idle = [];
  concurrency = 2;
  vi.stubGlobal("Image", FakeImage);
  vi.stubGlobal("requestIdleCallback", vi.fn((callback: (deadline: IdleDeadline) => void) => idle.push(callback)));
  vi.stubGlobal("cancelIdleCallback", vi.fn());
  Object.defineProperty(document, "hidden", {configurable: true, value: false});
});
afterEach(() => vi.unstubAllGlobals());

const runIdle = (timeRemaining = 50, didTimeout = false) => idle.shift()!({didTimeout, timeRemaining: () => timeRemaining});

describe("warming preview images", () => {
  it("retries failed warming on later intent", () => {
    const warmer = new ImageWarmer(budget);
    warmer.warm(["retry"], "now");FakeImage.all[0].fail();
    warmer.warm(["retry"], "now");
    expect(started()).toEqual(["retry", "retry"]);
  });
  it("downloads urgent images at once within the concurrency limit, decoding the first", async () => {
    const warmer = new ImageWarmer(budget);
    warmer.warm(["a", "b", "c", ""], "now", true);
    expect(started()).toEqual(["a", "b"]);
    expect(FakeImage.all.map(img => img.fetchPriority)).toEqual(["high", "high"]);
    FakeImage.all[0].load();
    await flush();
    expect(FakeImage.all[0].decoded).toBe(1);
    expect(started()).toEqual(["a", "b", "c"]);
    FakeImage.all[1].fail();
    expect(warmer.isWarm("a")).toBe(true);
    warmer.warm(["a", "c"], "now");
    expect(started()).toHaveLength(3);
  });

  it("finishes a warm even when decoding fails", async () => {
    concurrency = 1;
    const warmer = new ImageWarmer(budget);
    warmer.warm(["bad-decode", "next"], "soon", true);
    FakeImage.all[0].load();
    await flush();
    expect(FakeImage.all[0].fetchPriority).toBe("low");
    expect(started()).toEqual(["bad-decode", "next"]);
  });

  it("starts idle work in small batches only when the browser has time", () => {
    const warmer = new ImageWarmer(budget);
    concurrency = 20;
    warmer.warm(Array.from({length: 12}, (_, i) => `idle-${i}`), "idle");
    expect(started()).toEqual([]);
    runIdle(2);
    expect(started()).toEqual([]);
    runIdle(50);
    expect(started()).toHaveLength(8);
    runIdle(0, true);
    expect(started()).toHaveLength(12);
    expect(idle).toHaveLength(0);
  });

  it("waits for a free slot instead of polling while every slot is busy", () => {
    concurrency = 1;
    const warmer = new ImageWarmer(budget);
    warmer.warm(["busy"], "now");
    warmer.warm(["later"], "idle");
    expect(idle).toHaveLength(0);
    FakeImage.all[0].load();
    expect(idle).toHaveLength(1);
    runIdle();
    expect(started()).toEqual(["busy", "later"]);
  });

  it("caps the queue, keeps only recent images and pauses while the tab is hidden", () => {
    concurrency = 0;
    const warmer = new ImageWarmer(budget);
    warmer.warm(Array.from({length: 300}, (_, i) => `q${i}`), "soon");
    concurrency = 400;
    warmer.resume();
    expect(started()).toHaveLength(240);
    warmer.warm(["one-more"], "now");
    expect(warmer.isWarm("q0")).toBe(false);
    expect(warmer.isWarm("one-more")).toBe(true);
    Object.defineProperty(document, "hidden", {configurable: true, value: true});
    warmer.warm(["hidden"], "now");
    expect(started()).not.toContain("hidden");
    Object.defineProperty(document, "hidden", {configurable: true, value: false});
    warmer.resume();
    expect(started()).toContain("hidden");
  });

  it("clears pending work and a scheduled idle batch", () => {
    const warmer = new ImageWarmer(budget);
    warmer.warm(["x", "y"], "idle");
    warmer.clear();
    expect(cancelIdleCallback).toHaveBeenCalled();
    warmer.clear();
    expect(cancelIdleCallback).toHaveBeenCalledTimes(1);
    Object.defineProperty(document, "hidden", {configurable: true, value: true});
    warmer.warm(["z"], "idle");
    Object.defineProperty(document, "hidden", {configurable: true, value: false});
    warmer.resume();
    Object.defineProperty(document, "hidden", {configurable: true, value: true});
    runIdle();
    expect(started()).toEqual([]);
  });
});
