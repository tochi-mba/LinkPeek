/**
 * Decodes the media around the one on screen, so moving through a gallery never
 * waits on the network. How far ahead it reaches, how much it keeps in memory
 * and how many downloads run at once all come from the resource governor.
 */
import type {Budget} from "../content/resource-governor";
import type {MediaItem} from "../shared/media";
import type {LinkPeekSettings} from "../shared/settings";

export type PreloadPlan = {priority: number[]; background: number[]; originals: number[]};
export type PreloadConfig = {ahead: number; behind: number; idle: number; originals: LinkPeekSettings["preloadOriginals"]; wrap: boolean};

/** The image to decode for an item: a video's poster, otherwise its preview. */
export function preloadUrl(item: MediaItem) {
  return item.type === "video" ? item.posterUrl ?? "" : item.previewUrl;
}

/**
 * Which items to prepare, in order. Movement direction biases the plan: going
 * forward reaches further ahead, going back reaches further behind.
 */
export function buildPreloadPlan(length: number, index: number, config: PreloadConfig, direction = 0): PreloadPlan {
  if (length <= 0) return {priority: [], background: [], originals: []};
  let ahead = Math.max(0, config.ahead), behind = Math.max(0, config.behind);
  if (direction > 0) {
    ahead += 2;
    behind = Math.min(behind, 1);
  } else if (direction < 0) {
    behind += 2;
    ahead = Math.min(ahead, 1);
  }
  const at = (n: number) => config.wrap ? ((n % length) + length) % length : n;
  const used = new Set([index]), priority: number[] = [];
  const take = (n: number, into: number[]) => {
    const position = at(n);
    if (position < 0 || position >= length || used.has(position)) return;
    used.add(position);
    into.push(position);
  };
  for (let d = 1; d <= Math.max(ahead, behind); d++) {
    if (d <= ahead) take(index + d, priority);
    if (d <= behind) take(index - d, priority);
  }
  const background: number[] = [];
  for (let d = 1; d < length && background.length < config.idle; d++) {
    const first = direction < 0 ? index - d : index + d, second = direction < 0 ? index + d : index - d;
    take(first, background);
    if (background.length < config.idle) take(second, background);
  }
  const next = at(index + (direction < 0 ? -1 : 1));
  const originals = config.originals === "next" && next >= 0 && next < length && next !== index ? [next] : [];
  return {priority, background, originals};
}

type Entry = {img: HTMLImageElement; promise: Promise<boolean>; ready: boolean; lastUsed: number; bytes: number};
type Task = {url: string; priority: number; generation: number};

export class MediaPreloader {
  private entries = new Map<string, Entry>();
  private queue: Task[] = [];
  private active = 0;
  private generation = 0;
  private idleHandle: number | undefined;
  private decodedBytes = 0;
  private items: MediaItem[] = [];
  private settings?: LinkPeekSettings;
  private index = 0;

  constructor(private budget: () => Budget) {}

  reset(items: MediaItem[], index: number, settings: LinkPeekSettings) {
    this.items = items;
    this.settings = settings;
    this.schedule(index, 0);
    this.prune();
  }

  schedule(index: number, direction = 0) {
    if (!this.settings || !this.items.length) return;
    this.index = index;
    const generation = ++this.generation;
    this.queue = [];
    this.cancelIdle();
    const budget = this.budget();
    const plan = buildPreloadPlan(this.items.length, index, {
      ahead: budget.ahead, behind: budget.behind, idle: budget.galleryIdle, originals: this.settings.preloadOriginals, wrap: this.settings.wrapAround
    }, direction);
    for (const n of plan.priority) this.enqueue(preloadUrl(this.items[n]), 0, generation);
    for (const n of plan.originals) {
      const item = this.items[n];
      if (item.type === "image" && item.originalUrl !== item.previewUrl) this.enqueue(item.originalUrl, 1, generation);
    }
    this.pump();
    if (!plan.background.length) return;
    this.idleHandle = requestIdleCallback(() => {
      this.idleHandle = undefined;
      if (generation !== this.generation) return;
      for (const n of plan.background) this.enqueue(preloadUrl(this.items[n]), 3, generation);
      this.pump();
    }, {timeout: 1200});
  }

  /** Resolves once the item can be shown: true when decoded, false when it failed to load. */
  async ensure(item: MediaItem) {
    // A GIF shows its native image straight away while frame controls prepare; a video streams.
    if (item.type !== "image") return true;
    return this.load(item.previewUrl, 0).promise;
  }

  /** GIFs and videos render from their own source, so they are always "ready". */
  isReady(item: MediaItem) {
    return item.type !== "image" || this.entries.get(item.previewUrl)?.ready === true;
  }

  /** The decoded element for an image, ready to insert without a flash. */
  element(item: MediaItem) {
    const entry = this.entries.get(item.previewUrl);
    if (!entry?.ready) return undefined;
    entry.lastUsed = performance.now();
    return entry.img;
  }

  dispose() {
    this.generation++;
    this.queue = [];
    this.items = [];
    this.cancelIdle();
    this.entries.clear();
    this.decodedBytes = 0;
  }

  private cancelIdle() {
    if (this.idleHandle !== undefined) cancelIdleCallback(this.idleHandle);
    this.idleHandle = undefined;
  }

  private enqueue(url: string, priority: number, generation: number) {
    if (!url || this.entries.has(url) || this.queue.some(task => task.url === url)) return;
    this.queue.push({url, priority, generation});
    this.queue.sort((a, b) => a.priority - b.priority);
  }

  private load(url: string, priority: number) {
    const existing = this.entries.get(url);
    if (existing) {
      existing.lastUsed = performance.now();
      return existing;
    }
    const img = new Image();
    img.decoding = "async";
    (img as HTMLImageElement & {fetchPriority?: string}).fetchPriority = priority === 0 ? "high" : "low";
    const entry: Entry = {img, promise: Promise.resolve(false), ready: false, lastUsed: performance.now(), bytes: 0};
    entry.promise = new Promise<boolean>(resolve => {
      img.addEventListener("load", async () => {
        await img.decode().catch(() => undefined);
        entry.ready = true;
        // An entry evicted while it was still loading no longer counts against the budget.
        if (this.entries.get(url) === entry) {
          entry.bytes = (img.naturalWidth || 0) * (img.naturalHeight || 0) * 4;
          this.decodedBytes += entry.bytes;
          this.prune();
        }
        resolve(true);
      }, {once: true});
      img.addEventListener("error", () => {
        if (this.entries.get(url) === entry) this.entries.delete(url);
        resolve(false);
      }, {once: true});
    });
    img.src = url;
    this.entries.set(url, entry);
    return entry;
  }

  private pump() {
    const limit = this.budget().imageConcurrency;
    while (this.active < limit && this.queue.length) {
      const task = this.queue.shift()!;
      if (task.generation !== this.generation) continue;
      this.active++;
      void this.load(task.url, task.priority).promise.finally(() => {
        this.active--;
        this.pump();
      });
    }
  }

  /** Keeps the items around the current one; evicts the least recently used beyond the memory budget. */
  private prune() {
    if (!this.settings) return;
    const budget = this.budget(), countMax = Math.max(24, budget.galleryIdle + 12);
    if (this.entries.size <= countMax && this.decodedBytes <= budget.memoryBytes) return;
    const keep = new Set<string>(), length = this.items.length;
    for (let d = -(budget.behind + 2); d <= budget.ahead + 2 && length; d++) {
      const n = this.settings.wrapAround ? (((this.index + d) % length) + length) % length : this.index + d;
      if (n < 0 || n >= length) continue;
      keep.add(this.items[n].previewUrl);
      keep.add(this.items[n].originalUrl);
    }
    const candidates = [...this.entries].filter(([url]) => !keep.has(url)).sort((a, b) => a[1].lastUsed - b[1].lastUsed);
    for (const [url, entry] of candidates) {
      if (this.entries.size <= countMax && this.decodedBytes <= budget.memoryBytes) break;
      this.entries.delete(url);
      this.decodedBytes -= entry.bytes;
    }
  }
}
