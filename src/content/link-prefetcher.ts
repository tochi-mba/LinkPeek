/**
 * Keeps the links nearest the pointer prepared, so a preview opens instantly.
 *
 * Links near the viewport are tracked with an IntersectionObserver (no layout
 * reads per scroll). They are ranked by distance from where the pointer is
 * heading, and the closest few are scanned cheaply in the service worker.
 * Results with media are kept here too, so opening a prepared link shows its
 * gallery in the first frame without a round trip.
 */
import {classifyLink, type ScanResult} from "../shared/media";
import type {PrefetchRequest} from "../shared/messages";
import type {LinkPeekSettings} from "../shared/settings";
import type {ImageWarmer} from "./image-warmer";
import type {Budget} from "./resource-governor";

export interface PrefetchHost {
  /** Effective settings when this link may be previewed here, otherwise undefined. */
  settingsFor(anchor: HTMLAnchorElement): LinkPeekSettings | undefined;
  pointer(): {x: number; y: number; vx: number; vy: number};
  budget(): Budget;
}

type Level = "shallow" | "deep";
export type PreloadPriority = "normal" | "high" | "maximum";
export type PreloadState = "not-started" | "queued" | "loading" | "prepared" | "backoff" | "blocked";
export interface PreloadEntry {
  url: string;
  label: string;
  state: PreloadState;
  priority: PreloadPriority;
  source: "page" | "recursive";
  retryAt?: number;
  title?: string;
}

const RESULT_CACHE_SIZE = 80;
const RETRY_AFTER_MS = 30_000;
const LOOKAHEAD_MS = 150;

function thumbnailUrls(result: ScanResult) {
  return result.items.map(item => item.type === "video" ? item.posterUrl ?? "" : item.previewUrl).filter(Boolean);
}

export class LinkPrefetcher {
  private near = new Set<HTMLAnchorElement>();
  private observer?: IntersectionObserver;
  private requested = new Map<string, Level>();
  private results = new Map<string, ScanResult>();
  private failedUntil = new Map<string, number>();
  private inFlight = 0;
  private waiters: Array<() => void> = [];
  private idleHandle: number | undefined;
  private childIdleHandle: number | undefined;
  private childQueue = new Set<string>();
  private states = new Map<string, PreloadState>();
  private priorities = new Map<string, PreloadPriority>();
  private recursiveUrls = new Set<string>();
  private listeners = new Set<() => void>();

  constructor(private host: PrefetchHost, private warmer: ImageWarmer) {}

  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private changed() {
    for (const listener of this.listeners) listener();
  }

  private priority(url: string): PreloadPriority {
    return this.priorities.get(url) ?? "normal";
  }

  snapshot(): PreloadEntry[] {
    const entries = new Map<string, PreloadEntry>();
    for (const anchor of document.querySelectorAll<HTMLAnchorElement>("a[href]")) {
      const url = anchor.href, allowed = Boolean(this.host.settingsFor(anchor));
      entries.set(url, {
        url, label: anchor.textContent?.trim() || new URL(url).pathname || new URL(url).hostname,
        state: allowed ? this.stateFor(url) : "blocked", priority: this.priority(url), source: "page",
        retryAt: this.failedUntil.get(url), title: this.results.get(url)?.title
      });
    }
    for (const url of this.recursiveUrls) {
      if (entries.has(url)) continue;
      entries.set(url, {
        url, label: new URL(url).pathname.split("/").filter(Boolean).at(-1) || new URL(url).hostname,
        state: this.stateFor(url), priority: this.priority(url), source: "recursive",
        retryAt: this.failedUntil.get(url), title: this.results.get(url)?.title
      });
    }
    return [...entries.values()];
  }

  private stateFor(url: string): PreloadState {
    if (this.results.has(url)) return "prepared";
    if ((this.failedUntil.get(url) ?? 0) > Date.now()) return "backoff";
    return this.states.get(url) ?? "not-started";
  }

  setPriority(urls: Iterable<string>, priority: PreloadPriority) {
    const selected = [...new Set(urls)];
    for (const url of selected) {
      if (priority === "normal") this.priorities.delete(url);
      else this.priorities.set(url, priority);
    }
    this.changed();
    for (const url of selected) {
      const anchor = [...document.querySelectorAll<HTMLAnchorElement>("a[href]")].find(candidate => candidate.href === url) ?? Object.assign(document.createElement("a"), {href: url});
      const settings = this.host.settingsFor(anchor);
      if (!settings || priority === "normal") continue;
      if (priority === "maximum") void this.prepareUrl(url, settings, "deep", true, true);
      else {
        this.childQueue.delete(url);
        this.childQueue = new Set([url, ...this.childQueue]);
        this.states.set(url, "queued");
        this.scheduleChildWork();
      }
    }
  }

  /** Starts tracking every link already on the page. */
  start() {
    this.observer = new IntersectionObserver(entries => {
      for (const entry of entries) {
        const anchor = entry.target as HTMLAnchorElement;
        if (entry.isIntersecting) this.near.add(anchor);
        else this.near.delete(anchor);
      }
      this.schedule();
    }, {rootMargin: "50% 0px"});
    this.track(document.querySelectorAll<HTMLAnchorElement>("a[href]"));
  }

  /** Tracks links added after load (infinite scroll, client-side rendering). */
  trackAdded(records: MutationRecord[]) {
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (!(node instanceof Element)) continue;
        if (node.matches("a[href]")) this.observer?.observe(node);
        this.track(node.querySelectorAll<HTMLAnchorElement>("a[href]"));
      }
      if (record.type === "attributes" && record.target instanceof HTMLAnchorElement) this.observer?.observe(record.target);
    }
    this.schedule();
  }

  private track(anchors: Iterable<HTMLAnchorElement>) {
    for (const anchor of anchors) this.observer?.observe(anchor);
  }

  /** Forgets everything prepared, for example after settings change what a scan returns. */
  reset() {
    this.requested.clear();
    this.results.clear();
    this.failedUntil.clear();
    this.childQueue.clear();
    this.states.clear();
    this.recursiveUrls.clear();
    this.changed();
    this.schedule();
  }

  /** Re-ranks nearby links once the browser is idle. Cheap to call often. */
  schedule() {
    if (this.idleHandle !== undefined || document.hidden) return;
    this.idleHandle = requestIdleCallback(() => {
      this.idleHandle = undefined;
      this.prepareNearest();
      this.scheduleChildWork();
    }, {timeout: 600});
  }

  isPrepared(url: string) {
    return this.results.has(url);
  }

  /** A prepared gallery for instant display, or undefined. */
  cached(url: string) {
    const result = this.results.get(url);
    if (!result) return undefined;
    this.results.delete(url);
    this.results.set(url, result);
    return result;
  }

  get preparedCount() {
    return this.results.size;
  }

  /** Prepared links on the page, in document order, one per URL. */
  preparedAnchors(): HTMLAnchorElement[] {
    const seen = new Set<string>();
    return [...document.querySelectorAll<HTMLAnchorElement>("a[href]")].filter(anchor => {
      if (seen.has(anchor.href) || !this.results.has(anchor.href) || !this.host.settingsFor(anchor)) return false;
      seen.add(anchor.href);
      return true;
    });
  }

  /** Records a gallery that a full scan produced, so it reopens instantly and counts as prepared. */
  remember(url: string, result: ScanResult, queueChildren = true) {
    if (!result.items.length) return;
    this.results.delete(url);
    this.results.set(url, result);
    while (this.results.size > RESULT_CACHE_SIZE) this.results.delete(this.results.keys().next().value!);
    this.states.set(url, "prepared");
    this.changed();
    if (queueChildren) this.queueChildLinks(result);
  }

  /** Child-page links are priority-2 work: bounded, idle-only and governed by current headroom. */
  private queueChildLinks(result: ScanResult) {
    const contexts = result.linkContexts?.filter(context => context.sourceUrl !== result.url) ?? [];
    for (const context of contexts) {
      for (const url of context.links) {
        if (this.childQueue.size >= 32) break;
        this.recursiveUrls.add(url);
        if (!this.results.has(url) && !this.requested.has(url)) {
          this.childQueue.add(url);
          this.states.set(url, "queued");
        }
      }
      if (this.childQueue.size >= 32) break;
    }
    this.changed();
    this.scheduleChildWork();
  }

  private scheduleChildWork() {
    if (this.childIdleHandle !== undefined || document.hidden || !this.childQueue.size) return;
    const budget = this.host.budget();
    if (!budget.speculative || budget.nearbyLinks <= 0) return;
    this.childIdleHandle = requestIdleCallback(() => {
      this.childIdleHandle = undefined;
      const current = this.host.budget();
      if (!current.speculative || current.nearbyLinks <= 0) return;
      const count = Math.min(this.childQueue.size, Math.max(1, Math.min(current.nearbyLinks, current.linkConcurrency)));
      const urls = [...this.childQueue].sort((a, b) => {
        const rank = (url: string) => this.priority(url) === "high" ? 0 : 1;
        return rank(a) - rank(b);
      }).slice(0, count);
      for (const url of urls) {
        this.childQueue.delete(url);
        const anchor = document.createElement("a");
        anchor.href = url;
        const settings = this.host.settingsFor(anchor);
        if (settings) void this.prepareUrl(url, settings, "deep", false, false);
      }
      if (this.childQueue.size) this.scheduleChildWork();
    }, {timeout: 1500});
  }

  /** The pointer reached a link: prepare it now, ahead of any queued nearby work. */
  hover(anchor: HTMLAnchorElement) {
    if (this.host.budget().speculative) void this.prepare(anchor, "shallow", true);
  }

  /** The pointer is staying on a link: also run the deeper linked-page search if it is enabled. */
  deepen(anchor: HTMLAnchorElement) {
    const settings = this.host.settingsFor(anchor);
    if (settings && settings.recursiveSearch !== "off" && this.host.budget().speculative) void this.prepare(anchor, "deep", true);
  }

  private prepareNearest() {
    const budget = this.host.budget();
    if (budget.nearbyLinks <= 0) return;
    const {x, y, vx, vy} = this.host.pointer();
    const aimX = Math.max(0, Math.min(innerWidth, x + vx * LOOKAHEAD_MS)), aimY = Math.max(0, Math.min(innerHeight, y + vy * LOOKAHEAD_MS));
    const ranked: Array<{anchor: HTMLAnchorElement; distance: number}> = [];
    for (const anchor of this.near) {
      if (!anchor.isConnected) {
        this.near.delete(anchor);
        continue;
      }
      if (!this.host.settingsFor(anchor)) continue;
      const rect = anchor.getBoundingClientRect();
      const dx = Math.max(rect.left - aimX, 0, aimX - rect.right), dy = Math.max(rect.top - aimY, 0, aimY - rect.bottom);
      ranked.push({anchor, distance: Math.hypot(dx, dy)});
    }
    ranked.sort((a, b) => a.distance - b.distance);
    const chosen = new Set<string>();
    for (const {anchor} of ranked) {
      if (chosen.size >= budget.nearbyLinks) break;
      if (chosen.has(anchor.href)) continue;
      chosen.add(anchor.href);
      void this.prepare(anchor, "shallow", false);
    }
  }

  private async slot(urgent: boolean) {
    if (!urgent) while (this.inFlight >= this.host.budget().linkConcurrency) await new Promise<void>(resolve => this.waiters.push(resolve));
    this.inFlight++;
  }

  private release() {
    this.inFlight--;
    this.waiters.shift()?.();
  }

  private async prepare(anchor: HTMLAnchorElement, level: Level, urgent: boolean) {
    const settings = this.host.settingsFor(anchor);
    if (!settings) return;
    await this.prepareUrl(anchor.href, settings, level, urgent, true);
  }

  private async prepareUrl(url: string, settings: LinkPeekSettings, level: Level, urgent: boolean, queueChildren: boolean) {
    const previous = this.requested.get(url);
    if (document.hidden || previous === "deep" || (level === "shallow" && previous)) return;
    if ((this.failedUntil.get(url) ?? 0) > Date.now()) return;
    this.requested.set(url, level);
    this.states.set(url, "queued");
    this.changed();
    const request: PrefetchRequest = {type: "LINKPEEK_PREFETCH", url, kind: classifyLink(url), deep: level === "deep"};
    await this.slot(urgent);
    this.states.set(url, "loading");
    this.changed();
    try {
      const result = await chrome.runtime.sendMessage(request) as ScanResult | null | {error: string};
      if (!result || "error" in result) throw new Error(result?.error ?? "No result");
      this.remember(url, result, queueChildren);
      this.warmThumbnails(result, urgent);
    } catch {
      if (previous) this.requested.set(url, previous);
      else this.requested.delete(url);
      this.failedUntil.set(url, Date.now() + RETRY_AFTER_MS);
      this.states.set(url, "backoff");
      this.changed();
    } finally {
      this.release();
    }
  }

  private warmThumbnails(result: ScanResult, hovered: boolean) {
    const budget = this.host.budget(), urls = thumbnailUrls(result);
    if (hovered) {
      this.warmer.warm(urls.slice(0, budget.hoverThumbs), "now", true);
      this.warmer.warm(urls.slice(budget.hoverThumbs, budget.hoverThumbs + budget.hoverIdleThumbs), "idle");
      return;
    }
    // Nearby links warm only still images: a GIF can be megabytes for one thumbnail.
    const stills = result.items.filter(item => item.type === "image").map(item => item.previewUrl);
    this.warmer.warm(stills.slice(0, budget.thumbsPerLink), "soon");
  }
}
