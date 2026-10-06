import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {BACKGROUND_MIN_HEADROOM, PLANS, ResourceGovernor, SAVER_PLAN, computeBudget, deviceTier, type BudgetInput} from "../../src/content/resource-governor";
import {resolveSettings, type LinkPeekSettings} from "../../src/shared/settings";

const input = (patch: Partial<BudgetInput> = {}): BudgetInput => ({mode: "auto", prefetch: "nearby", tier: 1, headroom: 1, constrained: false, maxRequests: 8, memoryCapMb: 1024, ...patch});

describe("budget arithmetic", () => {
  it("checks the rest of the page only in whole-page mode, and stops at the first sign of pressure", () => {
    expect(computeBudget(input({prefetch: "page", tier: 2})).backgroundLinks).toBe(PLANS[2].backgroundLinks);
    expect(computeBudget(input({prefetch: "page", headroom: BACKGROUND_MIN_HEADROOM})).backgroundLinks).toBe(1);
    expect(computeBudget(input({prefetch: "page", headroom: 0.74}))).toMatchObject({backgroundLinks: 0, backgroundPaused: true});
    expect(computeBudget(input({prefetch: "page"})).backgroundPaused).toBe(false);
    expect(computeBudget(input({prefetch: "nearby", headroom: 0.3})).backgroundPaused).toBe(false);
    expect(computeBudget(input({prefetch: "page", headroom: 0.3, mode: "saver"})).backgroundPaused).toBe(false);
    expect(computeBudget(input({prefetch: "visible"})).backgroundLinks).toBe(0);
    expect(computeBudget(input({prefetch: "page", mode: "saver"})).backgroundLinks).toBe(0);
  });

  it("sizes auto mode by device tier and fast mode one tier up", () => {
    expect(computeBudget(input({tier: 0})).nearbyLinks).toBe(PLANS[0].nearbyLinks);
    expect(computeBudget(input({tier: 2})).memoryBytes).toBe(PLANS[2].memoryMb * 1024 * 1024);
    expect(computeBudget(input({tier: 1, mode: "fast"})).hoverThumbs).toBe(PLANS[2].hoverThumbs);
    expect(computeBudget(input({tier: 2, mode: "fast"})).nearbyLinks).toBe(PLANS[3].nearbyLinks);
  });

  it("prepares nothing ahead in data saver mode or on a constrained connection", () => {
    for (const budget of [computeBudget(input({mode: "saver", tier: 2})), computeBudget(input({constrained: true}))]) {
      expect(budget).toMatchObject({speculative: false, nearbyLinks: 0, thumbsPerLink: 0, hoverThumbs: SAVER_PLAN.hoverThumbs, galleryIdle: 0});
    }
    expect(computeBudget(input()).speculative).toBe(true);
  });

  it("scales down under pressure but never below the data saver floor", () => {
    const relaxed = computeBudget(input({tier: 2})), pressed = computeBudget(input({tier: 2, headroom: 0.25}));
    expect(pressed.hoverThumbs).toBe(Math.round(PLANS[2].hoverThumbs * 0.25));
    expect(pressed.imageConcurrency).toBe(Math.max(SAVER_PLAN.imageConcurrency, Math.round(PLANS[2].imageConcurrency * 0.25)));
    expect(pressed.ahead).toBeLessThan(relaxed.ahead);
    expect(pressed.behind).toBeGreaterThanOrEqual(SAVER_PLAN.behind);
  });

  it("follows the prefetch choice and the hard limits from settings", () => {
    expect(computeBudget(input({prefetch: "off"}))).toMatchObject({speculative: false, nearbyLinks: 0, thumbsPerLink: 0});
    expect(computeBudget(input({prefetch: "visible"})).nearbyLinks).toBe(PLANS[1].nearbyLinks * 2);
    expect(computeBudget(input({prefetch: "visible", tier: 2, mode: "fast"})).nearbyLinks).toBe(16);
    expect(computeBudget(input({maxRequests: 1, tier: 2})).linkConcurrency).toBe(1);
    expect(computeBudget(input({maxRequests: 0})).linkConcurrency).toBe(1);
    expect(computeBudget(input({memoryCapMb: 40, tier: 2})).memoryBytes).toBe(40 * 1024 * 1024);
  });
});

describe("device tier", () => {
  it("reads memory and cores, assuming a typical laptop when they are unknown", () => {
    expect(deviceTier({deviceMemory: 2, hardwareConcurrency: 8})).toBe(0);
    expect(deviceTier({deviceMemory: 8, hardwareConcurrency: 2})).toBe(0);
    expect(deviceTier({deviceMemory: 8, hardwareConcurrency: 8})).toBe(2);
    expect(deviceTier({deviceMemory: 4, hardwareConcurrency: 8})).toBe(1);
    expect(deviceTier({hardwareConcurrency: 0})).toBe(1);
  });
});

describe("live pressure", () => {
  let now: number, settings: LinkPeekSettings, navigatorStub: Record<string, unknown>;
  const governor = () => new ResourceGovernor(() => settings, () => now);

  beforeEach(() => {
    now = 10_000;
    settings = resolveSettings({});
    navigatorStub = {deviceMemory: 8, hardwareConcurrency: 8};
    vi.stubGlobal("navigator", navigatorStub);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    delete (performance as Performance & {memory?: unknown}).memory;
  });

  it("runs at full speed when nothing is wrong", () => {
    expect(governor().status()).toEqual({headroom: 1, reason: undefined, tier: 2});
  });

  it("backs off on jank at once and recovers gradually once the page is quiet", () => {
    const g = governor();
    g.reportJank(80);
    expect(g.status()).toMatchObject({headroom: 0.8, reason: "the page is busy"});
    g.reportJank(250);
    expect(g.status().headroom).toBe(0.4);
    for (let i = 0; i < 5; i++) g.reportJank(300);
    expect(g.status().headroom).toBe(0.25);
    now += 1500;
    expect(g.status().headroom).toBe(0.25);
    now += 2000;
    expect(g.status().headroom).toBe(0.5);
    now += 60_000;
    expect(g.status()).toMatchObject({headroom: 1, reason: undefined});
  });

  it("eases off for a nearly full heap and a slow connection, naming the tightest limit", () => {
    (performance as Performance & {memory?: unknown}).memory = {usedJSHeapSize: 90, jsHeapSizeLimit: 100};
    expect(governor().status()).toMatchObject({headroom: 0.4, reason: "memory is nearly full"});
    (performance as Performance & {memory?: unknown}).memory = {usedJSHeapSize: 10, jsHeapSizeLimit: 100};
    expect(governor().status()).toMatchObject({headroom: 1});
    (performance as Performance & {memory?: unknown}).memory = {usedJSHeapSize: 10, jsHeapSizeLimit: 0};
    navigatorStub.connection = {effectiveType: "3g"};
    expect(governor().status()).toMatchObject({headroom: 0.5, reason: "the connection is slow"});
  });

  it("explains data saver and constrained connections", () => {
    navigatorStub.connection = {saveData: true};
    expect(governor().status().reason).toBe("the browser asked to save data");
    expect(governor().budget().nearbyLinks).toBe(0);
    navigatorStub.connection = {effectiveType: "slow-2g"};
    expect(governor().budget().nearbyLinks).toBe(0);
    navigatorStub.connection = {effectiveType: "2g"};
    settings = resolveSettings({meteredOff: false});
    expect(governor().budget().nearbyLinks).toBeGreaterThan(0);
    settings = resolveSettings({performanceMode: "saver"});
    expect(governor().status().reason).toBe("Data saver is on");
  });

  it("listens for long tasks, CPU pressure and the battery, and stops cleanly", async () => {
    let longTasks!: (list: {getEntries: () => Array<{duration: number}>}) => void, pressure!: (records: Array<{state: string}>) => void;
    const disconnects: string[] = [];
    let battery!: {charging: boolean; level: number; listeners: Record<string, () => void>};
    vi.stubGlobal("PerformanceObserver", Object.assign(class {
      constructor(callback: typeof longTasks) {
        longTasks = callback;
      }
      observe() {}
      disconnect() {
        disconnects.push("longtask");
      }
    }, {supportedEntryTypes: ["longtask"]}));
    vi.stubGlobal("PressureObserver", class {
      constructor(callback: typeof pressure) {
        pressure = callback;
      }
      observe() {
        return Promise.reject(new Error("blocked by policy"));
      }
      disconnect() {
        disconnects.push("pressure");
      }
    });
    navigatorStub.getBattery = async () => {
      const listeners: Record<string, () => void> = {};
      battery = {charging: false, level: 0.5, listeners, addEventListener: (type: string, listener: () => void) => listeners[type] = listener} as typeof battery;
      return battery;
    };
    const g = governor();
    g.start();
    await new Promise(resolve => setTimeout(resolve, 0));
    longTasks({getEntries: () => [{duration: 60}]});
    expect(g.status().headroom).toBe(0.8);
    now += 60_000;
    pressure([{state: "serious"}]);
    expect(g.status()).toMatchObject({headroom: 0.5, reason: "the system is under load"});
    pressure([]);
    pressure([{state: "nominal"}]);
    battery.level = 0.1;
    battery.listeners.levelchange();
    expect(g.status()).toMatchObject({headroom: 0.5, reason: "the battery is low"});
    battery.charging = true;
    battery.listeners.chargingchange();
    expect(g.status().headroom).toBe(1);
    g.stop();
    expect(disconnects).toEqual(["longtask", "pressure"]);
  });

  it("leaves alone the signals a site's permissions policy switches off", async () => {
    const constructed = vi.fn(), getBattery = vi.fn();
    vi.stubGlobal("PressureObserver", class {
      constructor() {
        constructed();
      }
    });
    navigatorStub.getBattery = getBattery;
    Object.defineProperty(document, "featurePolicy", {configurable: true, value: {allowsFeature: () => false, features: () => ["compute-pressure", "battery"]}});
    try {
      governor().start();
      await Promise.resolve();
      expect([constructed.mock.calls.length, getBattery.mock.calls.length]).toEqual([0, 0]);
    } finally {
      delete (document as {featurePolicy?: unknown}).featurePolicy;
    }
  });

  it("works when none of the signals are available", async () => {
    vi.stubGlobal("PerformanceObserver", Object.assign(class {}, {supportedEntryTypes: ["paint"]}));
    vi.stubGlobal("PressureObserver", class {
      constructor() {
        throw new Error("not allowed here");
      }
    });
    navigatorStub.getBattery = () => Promise.reject(new Error("blocked"));
    const g = governor();
    g.start();
    await Promise.resolve();
    expect(g.status().headroom).toBe(1);
    vi.stubGlobal("PerformanceObserver", undefined);
    delete navigatorStub.getBattery;
    vi.stubGlobal("PressureObserver", undefined);
    governor().start();
  });
});
