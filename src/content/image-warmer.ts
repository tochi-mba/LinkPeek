/**
 * Warms preview images into the browser cache before a preview opens, so the
 * first frame paints from memory instead of the network.
 *
 * Urgent images (the first of the gallery under the pointer) download straight
 * away and are decoded; the rest wait for idle time in small batches. Downloads
 * share one concurrency limit from the resource governor and pause while the
 * tab is hidden.
 */
import type {Budget} from "./resource-governor";

export type WarmPriority = "now" | "soon" | "idle";

type Task = {url: string; priority: number; decode: boolean};

const PRIORITY: Record<WarmPriority, number> = {now: 0, soon: 1, idle: 2};
const RETAINED_IMAGES = 160;
const MAX_QUEUED = 240;
const IDLE_BATCH = 8;

export class ImageWarmer {
  private queue: Task[] = [];
  private active = 0;
  private idleHandle: number | undefined;
  /** Holding the element keeps the decoded image in the renderer's memory cache. */
  private retained = new Map<string, HTMLImageElement>();
  private queued = new Set<string>();

  constructor(private budget: () => Budget) {}

  isWarm(url: string) {
    return this.retained.has(url);
  }

  /** Queues images; urls already warm or queued are skipped, earlier urls go first. */
  warm(urls: readonly string[], priority: WarmPriority, decodeFirst = false) {
    urls.forEach((url, index) => {
      if (!url || this.retained.has(url) || this.queued.has(url)) return;
      this.queue.push({url, priority: PRIORITY[priority], decode: decodeFirst && index === 0});
      this.queued.add(url);
    });
    this.queue.sort((a, b) => a.priority - b.priority);
    while (this.queue.length > MAX_QUEUED) this.queued.delete(this.queue.pop()!.url);
    this.pump();
  }

  /** Called when the tab becomes visible again. */
  resume() {
    this.pump();
  }

  clear() {
    this.queue = [];
    this.queued.clear();
    if (this.idleHandle !== undefined) cancelIdleCallback(this.idleHandle);
    this.idleHandle = undefined;
  }

  private pump() {
    if (document.hidden) return;
    const limit = this.budget().imageConcurrency;
    while (this.active < limit && (this.queue[0]?.priority ?? Infinity) < PRIORITY.idle) this.start(this.queue.shift()!);
    // With every slot busy, a finishing download pumps again; no idle callback is needed until then.
    if (this.active < limit && this.queue.length && this.idleHandle === undefined) this.scheduleIdle();
  }

  private scheduleIdle() {
    this.idleHandle = requestIdleCallback(deadline => {
      this.idleHandle = undefined;
      if (document.hidden) return;
      const limit = this.budget().imageConcurrency;
      let started = 0;
      while (this.queue.length && this.active < limit && started < IDLE_BATCH && (deadline.didTimeout || deadline.timeRemaining() > 4)) {
        this.start(this.queue.shift()!);
        started++;
      }
      this.pump();
    }, {timeout: 1500});
  }

  private start(task: Task) {
    this.queued.delete(task.url);
    this.active++;
    const img = new Image();
    img.decoding = "async";
    (img as HTMLImageElement & {fetchPriority?: string}).fetchPriority = task.priority === PRIORITY.now ? "high" : "low";
    const finish = () => {
      this.active--;
      this.pump();
    };
    img.addEventListener("load", () => {
      if (task.decode) img.decode().catch(() => undefined).finally(finish);
      else finish();
    }, {once: true});
    img.addEventListener("error", () => {
      if (this.retained.get(task.url) === img) this.retained.delete(task.url);
      finish();
    }, {once: true});
    img.src = task.url;
    this.retained.set(task.url, img);
    while (this.retained.size > RETAINED_IMAGES) this.retained.delete(this.retained.keys().next().value!);
  }
}
