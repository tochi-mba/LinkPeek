/**
 * Keeps the links nearest the pointer prepared, so a preview opens instantly.
 *
 * Links near the viewport are tracked with an IntersectionObserver (no layout
 * reads per scroll). They are ranked by distance from where the pointer is
 * heading, and the closest few are scanned cheaply in the service worker.
 * Results with media are kept here too, so opening a prepared link shows its
 * gallery in the first frame without a round trip.
 *
 * While a gallery built from linked pages is open, the links next to the one
 * being viewed are prepared too, so stepping through them with N is instant.
 *
 * The preload inspector reads live state from here and can raise a link's
 * priority: "high" prepares it in the next idle moment, "maximum" right away.
 */
import {classifyLink, linkLabel, type ScanResult} from "../shared/media";
import type {PrefetchRequest} from "../shared/messages";
import type {LinkPeekSettings} from "../shared/settings";
import type {ImageWarmer} from "./image-warmer";
import type {Budget} from "./resource-governor";

export interface PrefetchHost {
  /** Effective settings when this link may be previewed here, otherwise undefined. */
  settingsFor(url: string): LinkPeekSettings | undefined;
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
  /** "linked": not on this page, but next in a linked page's list (see warmAround). */
  source: "page" | "linked";
  /** True once LinkPeek knows this destination contains at least one GIF. */
  hasGif: boolean;
  retryAt?: number;
  title?: string;
}

const RESULT_CACHE_SIZE = 80;
/** Links remembered as already requested; older ones may be requested again. */
const REQUEST_MEMORY = 1000;
/** Requests allowed to wait for a slot; beyond this, speculative work is simply skipped. */
const MAX_WAITING = 80;
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
  /** Only work in progress; prepared and backoff are derived from results and failures. */
  private active = new Map<string, "queued" | "loading">();
  private priorities = new Map<string, PreloadPriority>();
  /** Links raised to "high", waiting for the next idle moment. */
  private boosted = new Set<string>();
  /** Links from a linked page's list that were prepared ahead of N; shown in the inspector. */
  private linked = new Set<string>();
  private listeners = new Set<() => void>();
  private inFlight = 0;
  private waiters: Array<() => void> = [];
  private idleHandle: number | undefined;
  /** Bumped by reset(), so answers to earlier requests are ignored. */
  private generation = 0;

  constructor(private host: PrefetchHost, private warmer: ImageWarmer) {}

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

  /** Called whenever the inspector should refresh. Returns an unsubscribe function. */
  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private changed() {
    for (const listener of this.listeners) listener();
  }

  private setActive(url: string, state: "queued" | "loading" | undefined) {
    if (state) this.active.set(url, state);
    else this.active.delete(url);
    this.changed();
  }

  /** Forgets everything prepared, for example after settings change what a scan returns. */
  reset() {
    this.generation++;
    this.requested.clear();
    this.results.clear();
    this.failedUntil.clear();
    this.active.clear();
    this.boosted.clear();
    this.linked.clear();
    this.priorities.clear();
    this.changed();
    this.schedule();
  }

  /** Re-ranks nearby links once the browser is idle. Cheap to call often. */
  schedule() {
    if (this.idleHandle !== undefined || document.hidden) return;
    this.idleHandle = requestIdleCallback(() => {
      this.idleHandle = undefined;
      this.prepareBoosted();
      this.prepareNearest();
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
      if (seen.has(anchor.href) || !this.results.has(anchor.href) || !this.host.settingsFor(anchor.href)) return false;
      seen.add(anchor.href);
      return true;
    });
  }

  /** Records a gallery that a full scan produced, so it reopens instantly and counts as prepared. */
  remember(url: string, result: ScanResult) {
    if (!result.items.length) return;
    this.results.delete(url);
    this.results.set(url, result);
    while (this.results.size > RESULT_CACHE_SIZE) {
      const oldest = this.results.keys().next().value!;
      this.results.delete(oldest);
      this.requested.delete(oldest);
    }
    this.changed();
  }

  /** Every link on the page, then linked-page links prepared ahead, with their state. One entry per URL. */
  snapshot(): PreloadEntry[] {
    const entries = new Map<string, PreloadEntry>();
    const add = (url: string, label: string, source: PreloadEntry["source"]) => {
      const result = this.results.get(url);
      entries.set(url, {
        url, label, source, state: this.stateFor(url, Boolean(this.host.settingsFor(url))),
        priority: this.priorities.get(url) ?? "normal",
        hasGif: result?.items.some(item => item.type === "gif") ?? (classifyLink(url) === "direct-image" && /\.gif(?:$|[?#])/i.test(url)),
        retryAt: this.failedUntil.get(url), title: result?.title
      });
    };
    for (const anchor of document.querySelectorAll<HTMLAnchorElement>("a[href]")) {
      if (!entries.has(anchor.href)) add(anchor.href, anchor.text.trim() || anchor.href, "page");
    }
    for (const url of this.linked) if (!entries.has(url)) add(url, linkLabel(url), "linked");
    return [...entries.values()];
  }

  private stateFor(url: string, allowed: boolean): PreloadState {
    if (!allowed) return "blocked";
    if (this.results.has(url)) return "prepared";
    const active = this.active.get(url);
    if (active) return active;
    if ((this.failedUntil.get(url) ?? 0) > Date.now()) return "backoff";
    return this.boosted.has(url) ? "queued" : "not-started";
  }

  /** Raises or resets the priority of links, from the inspector. */
  setPriority(urls: Iterable<string>, priority: PreloadPriority) {
    for (const url of new Set(urls)) {
      const settings = this.host.settingsFor(url);
      this.boosted.delete(url);
      if (priority === "normal" || !settings) {
        this.priorities.delete(url);
        continue;
      }
      this.priorities.set(url, priority);
      if (priority === "maximum") void this.prepareUrl(url, settings, "deep", true, true);
      else this.boosted.add(url);
    }
    this.changed();
    this.schedule();
  }

  /** The pointer reached a link: prepare it now, ahead of any queued nearby work. */
  hover(anchor: HTMLAnchorElement) {
    const settings = this.host.settingsFor(anchor.href);
    if (settings && this.host.budget().speculative) void this.prepareUrl(anchor.href, settings, "shallow", true, false);
  }

  /** The pointer is staying on a link: also run the deeper linked-page search if it is enabled. */
  deepen(anchor: HTMLAnchorElement) {
    const settings = this.host.settingsFor(anchor.href);
    if (settings && settings.recursiveSearch !== "off" && this.host.budget().speculative) void this.prepareUrl(anchor.href, settings, "deep", true, false);
  }

  /**
   * Prepares the neighbours of `links[index]` (the next two and the previous
   * one, wrapping) so N and Shift+N through a linked page's list open instantly.
   */
  warmAround(links: readonly string[], index: number) {
    const budget = this.host.budget();
    if (!budget.speculative || links.length < 2) return;
    const ahead = Math.max(1, Math.min(2, budget.nearbyLinks)), at = (offset: number) => links[(index + offset + links.length) % links.length];
    const urls = new Set([...Array.from({length: ahead}, (_, i) => at(i + 1)), at(-1)].filter(url => url !== links[index]));
    for (const url of urls) {
      const settings = this.host.settingsFor(url);
      if (!settings) continue;
      this.linked.delete(url);
      this.linked.add(url);
      while (this.linked.size > RESULT_CACHE_SIZE) this.linked.delete(this.linked.values().next().value!);
      void this.prepareUrl(url, settings, "shallow", false, false);
    }
    this.changed();
  }

  /** "High" links go first in idle time, a few at a time. */
  private prepareBoosted() {
    const count = Math.max(1, this.host.budget().linkConcurrency);
    for (const url of [...this.boosted].slice(0, count)) {
      this.boosted.delete(url);
      const settings = this.host.settingsFor(url);
      if (settings) void this.prepareUrl(url, settings, "deep", false, true);
    }
    if (this.boosted.size) this.schedule();
  }

  private prepareNearest() {
    const budget = this.host.budget();
    if (!budget.speculative || budget.nearbyLinks <= 0) return;
    const {x, y, vx, vy} = this.host.pointer();
    const aimX = Math.max(0, Math.min(innerWidth, x + vx * LOOKAHEAD_MS)), aimY = Math.max(0, Math.min(innerHeight, y + vy * LOOKAHEAD_MS));
    const ranked: Array<{anchor: HTMLAnchorElement; settings: LinkPeekSettings; distance: number}> = [];
    for (const anchor of this.near) {
      if (!anchor.isConnected) {
        this.near.delete(anchor);
        continue;
      }
      const settings = this.host.settingsFor(anchor.href);
      if (!settings) continue;
      const rect = anchor.getBoundingClientRect();
      const dx = Math.max(rect.left - aimX, 0, aimX - rect.right), dy = Math.max(rect.top - aimY, 0, aimY - rect.bottom);
      ranked.push({anchor, settings, distance: Math.hypot(dx, dy)});
    }
    ranked.sort((a, b) => a.distance - b.distance);
    const chosen = new Set<string>();
    for (const {anchor, settings} of ranked) {
      if (chosen.size >= budget.nearbyLinks) break;
      if (chosen.has(anchor.href)) continue;
      chosen.add(anchor.href);
      void this.prepareUrl(anchor.href, settings, "shallow", false, false);
    }
  }

  /** Waits for a request slot. Pointer intent may use one extra slot and jumps the queue. */
  private async slot(urgent: boolean) {
    while (this.inFlight >= Math.max(1, this.host.budget().linkConcurrency) + (urgent ? 1 : 0)) {
      await new Promise<void>(resolve => urgent ? this.waiters.unshift(resolve) : this.waiters.push(resolve));
    }
    this.inFlight++;
  }

  private release() {
    this.inFlight--;
    this.waiters.shift()?.();
  }

  /**
   * Prepares one link. `explicit` work was asked for in the inspector and is
   * allowed even when speculative preparation is off.
   */
  private async prepareUrl(url: string, settings: LinkPeekSettings, level: Level, urgent: boolean, explicit: boolean) {
    const generation = this.generation, previous = this.requested.get(url);
    if (document.hidden || this.waiters.length >= MAX_WAITING || previous === "deep" || (level === "shallow" && previous)) return;
    if ((this.failedUntil.get(url) ?? 0) > Date.now()) return;
    this.requested.set(url, level);
    while (this.requested.size > REQUEST_MEMORY) this.requested.delete(this.requested.keys().next().value!);
    this.setActive(url, "queued");
    await this.slot(urgent);
    try {
      if (generation !== this.generation) return;
      if (document.hidden || (!explicit && !this.host.budget().speculative)) {
        this.requested.delete(url);
        this.setActive(url, undefined);
        return;
      }
      this.setActive(url, "loading");
      const request: PrefetchRequest = {type: "LINKPEEK_PREFETCH", url, kind: classifyLink(url), deep: level === "deep"};
      const result = await chrome.runtime.sendMessage(request) as ScanResult | null | {error: string};
      if (generation !== this.generation) return;
      this.active.delete(url);
      if (!result || "error" in result) throw new Error(result?.error ?? "No result");
      this.remember(url, result);
      this.changed();
      this.warmThumbnails(result, urgent);
    } catch {
      if (generation !== this.generation) return;
      if (previous) this.requested.set(url, previous);
      else this.requested.delete(url);
      this.failedUntil.set(url, Date.now() + RETRY_AFTER_MS);
      this.setActive(url, undefined);
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
