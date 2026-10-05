/**
 * Decides how much work LinkPeek may do ahead of the person, so previews open
 * instantly without ever making the browser feel slow.
 *
 * The starting budget comes from the device (memory, CPU cores) and the
 * connection. While the page runs, LinkPeek watches for pressure — main-thread
 * long tasks (jank), system CPU pressure, a low battery and a nearly full heap —
 * and scales the budget down at once, then recovers gradually when the
 * pressure goes away (multiplicative decrease, additive increase).
 */
import type {LinkPeekSettings, PerformanceMode, PrefetchMode} from "../shared/settings";

export interface Budget {
  /** Whether anything may be prepared before a preview opens (off in data saver and when prefetch is off). */
  speculative: boolean;
  /** Links near the pointer kept prepared before hover. */
  nearbyLinks: number;
  /** Link scans that may run at once. */
  linkConcurrency: number;
  /** Preview thumbnails warmed for each nearby link. */
  thumbsPerLink: number;
  /** Thumbnails warmed straight away for the link under the pointer. */
  hoverThumbs: number;
  /** More of the hovered gallery's thumbnails, warmed in idle time. */
  hoverIdleThumbs: number;
  /** Image downloads that may run at once. */
  imageConcurrency: number;
  /** Media decoded ahead of and behind the one on screen. */
  ahead: number;
  behind: number;
  /** Gallery thumbnails warmed in idle time while a preview is open. */
  galleryIdle: number;
  /** Decoded-image memory the viewer may hold. */
  memoryBytes: number;
}

export type DeviceTier = 0 | 1 | 2;
export const TIER_NAMES = ["light", "standard", "high"] as const;

type Plan = Omit<Budget, "memoryBytes" | "speculative"> & {memoryMb: number};

/** Data saver: nothing speculative, only what is on screen. Also the floor every budget keeps. */
export const SAVER_PLAN: Plan = {
  nearbyLinks: 0, linkConcurrency: 1, thumbsPerLink: 0, hoverThumbs: 1, hoverIdleThumbs: 0,
  imageConcurrency: 1, ahead: 1, behind: 0, galleryIdle: 0, memoryMb: 32
};

/** Auto plans by device tier; fast mode uses the next row up. */
export const PLANS: readonly Plan[] = [
  {nearbyLinks: 2, linkConcurrency: 1, thumbsPerLink: 1, hoverThumbs: 6, hoverIdleThumbs: 24, imageConcurrency: 2, ahead: 2, behind: 1, galleryIdle: 40, memoryMb: 48},
  {nearbyLinks: 4, linkConcurrency: 2, thumbsPerLink: 2, hoverThumbs: 12, hoverIdleThumbs: 60, imageConcurrency: 3, ahead: 3, behind: 1, galleryIdle: 120, memoryMb: 96},
  {nearbyLinks: 6, linkConcurrency: 3, thumbsPerLink: 3, hoverThumbs: 16, hoverIdleThumbs: 120, imageConcurrency: 4, ahead: 4, behind: 2, galleryIdle: 240, memoryMb: 192},
  {nearbyLinks: 10, linkConcurrency: 4, thumbsPerLink: 4, hoverThumbs: 24, hoverIdleThumbs: 200, imageConcurrency: 6, ahead: 6, behind: 3, galleryIdle: 400, memoryMb: 320}
];

export interface BudgetInput {
  mode: PerformanceMode;
  prefetch: PrefetchMode;
  tier: DeviceTier;
  /** 0.25 to 1: how much of the plan the current conditions allow. */
  headroom: number;
  /** Data Saver is on or the connection is 2G. */
  constrained: boolean;
  maxRequests: number;
  memoryCapMb: number;
}

/** Pure budget arithmetic, kept separate from the signals so it can be reasoned about and tested. */
export function computeBudget(input: BudgetInput): Budget {
  const saver = input.mode === "saver" || input.constrained;
  const base = saver ? SAVER_PLAN : PLANS[Math.min(PLANS.length - 1, input.tier + (input.mode === "fast" ? 1 : 0))];
  const scale = (key: keyof Plan) => Math.max(SAVER_PLAN[key], Math.round(base[key] * input.headroom));
  let nearbyLinks = scale("nearbyLinks"), thumbsPerLink = scale("thumbsPerLink");
  if (input.prefetch === "off") nearbyLinks = thumbsPerLink = 0;
  else if (input.prefetch === "visible") nearbyLinks = Math.min(16, nearbyLinks * 2);
  return {
    speculative: !saver && input.prefetch !== "off",
    nearbyLinks,
    linkConcurrency: Math.min(Math.max(1, input.maxRequests), scale("linkConcurrency")),
    thumbsPerLink,
    hoverThumbs: scale("hoverThumbs"),
    hoverIdleThumbs: scale("hoverIdleThumbs"),
    imageConcurrency: scale("imageConcurrency"),
    ahead: scale("ahead"),
    behind: scale("behind"),
    galleryIdle: scale("galleryIdle"),
    memoryBytes: Math.min(input.memoryCapMb, scale("memoryMb")) * 1024 * 1024
  };
}

type NetworkInfo = {saveData?: boolean; effectiveType?: string};
type DeviceNavigator = Navigator & {deviceMemory?: number; connection?: NetworkInfo; getBattery?: () => Promise<BatteryLike>};
type BatteryLike = {charging: boolean; level: number; addEventListener: (type: string, listener: () => void) => void};
type PressureRecord = {state: "nominal" | "fair" | "serious" | "critical"};
type PressureObserverLike = {observe: (source: "cpu") => Promise<void>; disconnect: () => void};
type PressureObserverCtor = new (callback: (records: PressureRecord[]) => void) => PressureObserverLike;
type MemoryInfo = {usedJSHeapSize: number; jsHeapSizeLimit: number};

/** Classifies the device from what the browser reports; unknown values count as a typical laptop. */
export function deviceTier(nav: Pick<DeviceNavigator, "deviceMemory" | "hardwareConcurrency"> = navigator as DeviceNavigator): DeviceTier {
  const memory = nav.deviceMemory ?? 4, cores = nav.hardwareConcurrency || 4;
  if (memory <= 2 || cores <= 2) return 0;
  if (memory >= 8 && cores >= 8) return 2;
  return 1;
}

const PRESSURE_LIMITS: Record<PressureRecord["state"], number> = {nominal: 1, fair: 1, serious: 0.5, critical: 0.25};
const MIN_HEADROOM = 0.25;
const RECOVERY_DELAY_MS = 1500;
const RECOVERY_PER_MS = 1 / 8000;

export interface GovernorStatus {
  headroom: number;
  reason?: string;
  tier: DeviceTier;
}

export class ResourceGovernor {
  private jankHeadroom = 1;
  private lastJankAt = -Infinity;
  private cpuLimit = 1;
  private batteryLimit = 1;
  private cleanup: Array<() => void> = [];

  constructor(private settings: () => LinkPeekSettings, private now: () => number = () => performance.now()) {}

  /** Starts listening for pressure signals. Each one is optional; missing APIs are simply skipped. */
  start() {
    this.watchLongTasks();
    this.watchCpuPressure();
    void this.watchBattery();
  }

  stop() {
    for (const dispose of this.cleanup.splice(0)) dispose();
  }

  /** Records a main-thread long task: back off at once, harder for bad ones. */
  reportJank(durationMs: number) {
    this.jankHeadroom = Math.max(MIN_HEADROOM, this.currentJankHeadroom() * (durationMs >= 200 ? 0.5 : 0.8));
    this.lastJankAt = this.now();
  }

  private currentJankHeadroom() {
    const quietFor = this.now() - this.lastJankAt - RECOVERY_DELAY_MS;
    return quietFor > 0 ? Math.min(1, this.jankHeadroom + quietFor * RECOVERY_PER_MS) : this.jankHeadroom;
  }

  private heapLimit() {
    const memory = (performance as Performance & {memory?: MemoryInfo}).memory;
    if (!memory?.jsHeapSizeLimit) return 1;
    return memory.usedJSHeapSize / memory.jsHeapSizeLimit > 0.85 ? 0.4 : 1;
  }

  private constrained() {
    const connection = (navigator as DeviceNavigator).connection;
    return this.settings().meteredOff && (connection?.saveData === true || connection?.effectiveType === "slow-2g" || connection?.effectiveType === "2g");
  }

  private networkLimit() {
    return (navigator as DeviceNavigator).connection?.effectiveType === "3g" ? 0.5 : 1;
  }

  status(): GovernorStatus {
    const limits: Array<[number, string]> = [
      [this.currentJankHeadroom(), "the page is busy"],
      [this.cpuLimit, "the system is under load"],
      [this.batteryLimit, "the battery is low"],
      [this.heapLimit(), "memory is nearly full"],
      [this.networkLimit(), "the connection is slow"]
    ];
    const [headroom, reason] = limits.reduce((lowest, entry) => entry[0] < lowest[0] ? entry : lowest);
    const saverReason = this.settings().performanceMode === "saver" ? "Data saver is on" : this.constrained() ? "the browser asked to save data" : undefined;
    return {headroom: Math.round(headroom * 100) / 100, reason: saverReason ?? (headroom < 1 ? reason : undefined), tier: deviceTier()};
  }

  budget(): Budget {
    const settings = this.settings(), status = this.status();
    return computeBudget({
      mode: settings.performanceMode, prefetch: settings.prefetch, tier: status.tier, headroom: status.headroom,
      constrained: this.constrained(), maxRequests: settings.maxRequests, memoryCapMb: settings.preloadMemoryMb
    });
  }

  private watchLongTasks() {
    if (typeof PerformanceObserver === "undefined" || !PerformanceObserver.supportedEntryTypes?.includes("longtask")) return;
    const observer = new PerformanceObserver(list => {
      for (const entry of list.getEntries()) this.reportJank(entry.duration);
    });
    observer.observe({type: "longtask", buffered: false});
    this.cleanup.push(() => observer.disconnect());
  }

  private watchCpuPressure() {
    const Observer = (globalThis as {PressureObserver?: PressureObserverCtor}).PressureObserver;
    if (!Observer) return;
    try {
      const observer = new Observer(records => {
        const latest = records.at(-1);
        if (latest) this.cpuLimit = PRESSURE_LIMITS[latest.state];
      });
      // A permissions policy can block this in some frames; LinkPeek works without it.
      observer.observe("cpu").catch(() => undefined);
      this.cleanup.push(() => observer.disconnect());
    } catch {
      // Unsupported in this context.
    }
  }

  private async watchBattery() {
    const getBattery = (navigator as DeviceNavigator).getBattery;
    if (!getBattery) return;
    try {
      const battery = await getBattery.call(navigator);
      const update = () => {
        this.batteryLimit = !battery.charging && battery.level <= 0.2 ? 0.5 : 1;
      };
      update();
      battery.addEventListener("chargingchange", update);
      battery.addEventListener("levelchange", update);
    } catch {
      // Battery status is unavailable (for example, blocked by a permissions policy).
    }
  }
}
