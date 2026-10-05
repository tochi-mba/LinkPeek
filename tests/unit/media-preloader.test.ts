import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import type {Budget} from "../../src/content/resource-governor";
import type {MediaItem} from "../../src/shared/media";
import {resolveSettings} from "../../src/shared/settings";
import {MediaPreloader, buildPreloadPlan, preloadUrl, type PreloadConfig} from "../../src/ui/media-preloader";

const config = (patch: Partial<PreloadConfig> = {}): PreloadConfig => ({ahead: 2, behind: 1, idle: 0, originals: "never", wrap: true, ...patch});

describe("preload plans", () => {
  it("prepare neighbours first, biased toward the direction of travel", () => {
    expect(buildPreloadPlan(0, 0, config())).toEqual({priority: [], background: [], originals: []});
    expect(buildPreloadPlan(10, 5, config()).priority).toEqual([6, 4, 7]);
    expect(buildPreloadPlan(10, 5, config(), 1).priority).toEqual([6, 4, 7, 8, 9]);
    expect(buildPreloadPlan(10, 5, config(), -1).priority).toEqual([6, 4, 3, 2]);
  });

  it("wrap around the ends, or stop at them", () => {
    expect(buildPreloadPlan(5, 0, config()).priority).toEqual([1, 4, 2]);
    expect(buildPreloadPlan(5, 0, config({wrap: false})).priority).toEqual([1, 2]);
    expect(buildPreloadPlan(1, 0, config()).priority).toEqual([]);
  });

  it("warm the nearest rest of the gallery in idle time, up to the limit", () => {
    expect(buildPreloadPlan(10, 5, config({ahead: 0, behind: 0, idle: 4})).background).toEqual([6, 4, 7, 3]);
    // Moving backwards also reaches two further behind, so idle work starts past those.
    expect(buildPreloadPlan(10, 5, config({ahead: 0, behind: 0, idle: 3}), -1)).toMatchObject({priority: [4, 3], background: [6, 7, 2]});
    expect(buildPreloadPlan(4, 0, config({ahead: 1, behind: 0, idle: 50, wrap: false})).background).toEqual([2, 3]);
  });

  it("can load the next original file", () => {
    expect(buildPreloadPlan(10, 5, config({originals: "next"})).originals).toEqual([6]);
    expect(buildPreloadPlan(10, 5, config({originals: "next"}), -1).originals).toEqual([4]);
    expect(buildPreloadPlan(10, 9, config({originals: "next", wrap: false})).originals).toEqual([]);
    expect(buildPreloadPlan(1, 0, config({originals: "next"})).originals).toEqual([]);
  });
});

class FakeImage {
  static all: FakeImage[] = [];
  decoding = "";
  fetchPriority = "";
  src = "";
  naturalWidth = 100;
  naturalHeight = 100;
  private listeners: Record<string, () => void> = {};
  constructor() {
    FakeImage.all.push(this);
  }
  addEventListener(type: string, listener: () => void) {
    this.listeners[type] = listener;
  }
  decode() {
    return this.src.includes("nodecode") ? Promise.reject(new Error("no")) : Promise.resolve();
  }
  load() {
    this.listeners.load();
  }
  fail() {
    this.listeners.error();
  }
}

const item = (n: number, type: MediaItem["type"] = "image", extra: Partial<MediaItem> = {}): MediaItem => ({id: `${n}`, type, originalUrl: `o${n}`, previewUrl: `p${n}`, sourceUrl: "s", score: 1, ...extra});
const loaded = (src: string) => FakeImage.all.find(img => img.src === src)!;
const srcs = () => FakeImage.all.map(img => img.src);
const flush = () => new Promise(resolve => setTimeout(resolve, 0));
let idle: Array<() => void>, budget: Partial<Budget>;

describe("the media preloader", () => {
  it("retries an image after a transient failure", async () => {
    const p = new MediaPreloader(() => budget as Budget);
    const failed = p.ensure(item(0));
    FakeImage.all[0].fail();
    expect(await failed).toBe(false);
    const retried = p.ensure(item(0));
    expect(FakeImage.all).toHaveLength(2);
    FakeImage.all[1].load();
    expect(await retried).toBe(true);
  });
  beforeEach(() => {
    FakeImage.all = [];
    idle = [];
    budget = {ahead: 1, behind: 1, galleryIdle: 0, imageConcurrency: 2, memoryBytes: 1e9};
    vi.stubGlobal("Image", FakeImage);
    vi.stubGlobal("requestIdleCallback", vi.fn((callback: () => void) => idle.push(callback)));
    vi.stubGlobal("cancelIdleCallback", vi.fn());
  });
  afterEach(() => vi.unstubAllGlobals());

  const preloader = () => new MediaPreloader(() => budget as Budget);

  it("decodes neighbours within the concurrency limit, then idle work", async () => {
    budget.galleryIdle = 2;
    const p = preloader(), items = [0, 1, 2, 3, 4].map(n => item(n));
    p.schedule(0);
    p.reset(items, 0, resolveSettings({}));
    expect(srcs()).toEqual(["p1", "p4"]);
    expect(FakeImage.all[0].fetchPriority).toBe("high");
    idle.shift()!();
    loaded("p1").load();
    await flush();
    expect(srcs()).toEqual(["p1", "p4", "p2"]);
    expect(FakeImage.all[2].fetchPriority).toBe("low");
    expect(p.isReady(items[1])).toBe(true);
    expect(p.element(items[1])).toBe(FakeImage.all[0]);
    expect(p.element(items[4])).toBeUndefined();
  });

  it("drops stale queued work when the position moves", async () => {
    budget = {...budget, imageConcurrency: 1, galleryIdle: 3};
    const p = preloader(), items = [0, 1, 2, 3, 4, 5, 6].map(n => item(n));
    p.reset(items, 0, resolveSettings({}));
    const staleIdle = idle.shift()!;
    p.schedule(3, 1);
    staleIdle();
    loaded("p1").load();
    await flush();
    expect(srcs()).toEqual(["p1", "p4"]);
    expect(cancelIdleCallback).toHaveBeenCalled();
  });

  it("resolves ensure with whether the image could be shown", async () => {
    const p = preloader();
    p.reset([item(0)], 0, resolveSettings({}));
    const good = p.ensure(item(5)), bad = p.ensure(item(6)), nodecode = p.ensure(item(7, "image", {previewUrl: "nodecode"}));
    loaded("p5").load();
    loaded("p6").fail();
    loaded("nodecode").load();
    expect(await good).toBe(true);
    expect(await bad).toBe(false);
    expect(await nodecode).toBe(true);
    expect(await p.ensure(item(5))).toBe(true);
    expect(await p.ensure(item(8, "gif"))).toBe(true);
    expect(await p.ensure(item(9, "video"))).toBe(true);
    expect(p.isReady(item(8, "gif"))).toBe(true);
    expect(p.isReady(item(6))).toBe(false);
  });

  it("warms video posters and next originals, never videos themselves", () => {
    const p = preloader(), settings = resolveSettings({preloadOriginals: "next"});
    expect(preloadUrl(item(1, "video", {posterUrl: "poster"}))).toBe("poster");
    expect(preloadUrl(item(1, "video"))).toBe("");
    budget = {...budget, imageConcurrency: 8};
    p.reset([item(0), item(1, "video", {posterUrl: "poster"}), item(2)], 0, settings);
    p.reset([item(0), item(1), item(2, "image", {originalUrl: "p2"})], 1, settings);
    p.reset([item(0), item(1, "gif"), item(2)], 0, settings);
    p.reset([item(0), item(1), item(2, "video")], 0, settings);
    expect(srcs()).toEqual(["poster", "p2", "p0", "p1", "o1"]);
  });

  it("evicts least recently used images beyond the memory budget, keeping the ring around the current item", async () => {
    budget = {...budget, imageConcurrency: 8, memoryBytes: 100 * 100 * 4 * 3, galleryIdle: 0};
    const p = preloader(), items = Array.from({length: 40}, (_, n) => item(n)), settings = resolveSettings({wrapAround: false});
    p.reset(items, 10, settings);
    for (const n of [9, 11, 20, 21, 22, 23]) {
      if (!srcs().includes(`p${n}`)) void p.ensure(items[n]);
      loaded(`p${n}`).load();
      await flush();
    }
    expect(p.isReady(items[9])).toBe(true);
    expect(p.isReady(items[11])).toBe(true);
    expect(p.isReady(items[20])).toBe(false);
    expect(p.isReady(items[23])).toBe(true);
    p.reset(items, 0, settings);
  });

  it("caps how many images it holds even when memory allows more", async () => {
    budget = {...budget, imageConcurrency: 64};
    const p = preloader(), items = Array.from({length: 40}, (_, n) => item(n));
    p.reset(items, 0, resolveSettings({}));
    for (let n = 0; n < 40; n++) void p.ensure(items[n]);
    for (const img of FakeImage.all) img.load();
    await flush();
    expect(items.filter(entry => p.isReady(entry)).length).toBe(24);
  });

  it("disposes everything, including idle work, and ignores schedules without items", () => {
    budget.galleryIdle = 5;
    const p = preloader();
    p.reset(Array.from({length: 10}, (_, n) => item(n)), 0, resolveSettings({}));
    p.dispose();
    expect(cancelIdleCallback).toHaveBeenCalledTimes(1);
    p.dispose();
    p.schedule(1);
    expect(p.isReady(item(1))).toBe(false);
  });

  it("handles zero-size images and stale or edge-case internal work safely", async () => {
    const p = preloader();
    p.reset([item(0), item(1)], 0, resolveSettings({wrapAround: false}));
    const image = loaded("p1");
    image.naturalWidth = 0;
    image.naturalHeight = 0;
    image.load();
    await flush();

    const internal = p as unknown as {
      generation: number;
      queue: Array<{url: string; priority: number; generation: number}>;
      pump: () => void;
      prune: () => void;
      settings?: unknown;
      entries: Map<string, unknown>;
      decodedBytes: number;
      items: MediaItem[];
      index: number;
    };
    internal.queue.push({url: "stale", priority: 0, generation: internal.generation - 1});
    internal.pump();
    expect(srcs()).not.toContain("stale");
    internal.settings = undefined;
    internal.prune();

    internal.settings = resolveSettings({wrapAround: false});
    internal.items = [item(0)];
    internal.index = 0;
    internal.entries = new Map(Array.from({length: 25}, (_, n) => [`extra-${n}`, {lastUsed: n, bytes: 1}]));
    internal.decodedBytes = 25;
    budget = {...budget, ahead: 0, behind: 0, galleryIdle: 0, memoryBytes: 0};
    internal.prune();
    expect(internal.entries.size).toBe(0);
  });
});
