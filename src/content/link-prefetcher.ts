/**
 * Keeps links prepared before they are hovered, so a preview opens instantly,
 * without ever competing with what the person is doing.
 *
 * Work runs in three tiers, each only in idle time and within the resource
 * governor's budget:
 *
 * 1. Links the inspector raised, and the links nearest where the pointer is
 *    heading (tracked with an IntersectionObserver, so scrolling costs nothing).
 * 2. Every other link on the page, in document order, those near the viewport
 *    first: one cheap, never-retried check each. Off-screen links get no layout
 *    reads and no image downloads, and only a small summary is kept for them.
 * 3. Near the viewport, the deeper linked-page search for pages that had no
 *    media of their own.
 *
 * The whole-page tiers pause while a preview is loading, while the tab is
 * hidden and whenever the governor reports pressure, and back off from a site
 * that starts failing requests. Pointer intent (hover, linger, "maximum"
 * priority) always goes first and may use one extra request slot.
 *
 * While a gallery built from linked pages is open, the links next to the one
 * being viewed are prepared too, so stepping through them with N is instant.
 */
import {classifyLink, hasGifMedia, isGifLink, linkLabel, type ScanResult} from "../shared/media";
import type {PrefetchRequest} from "../shared/messages";
import type {LinkPeekSettings} from "../shared/settings";
import type {ImageWarmer} from "./image-warmer";
import type {Budget} from "./resource-governor";

export interface PrefetchHost {
  /** Effective settings when this link may be previewed here, otherwise undefined. */
  settingsFor(url: string): LinkPeekSettings | undefined;
  pointer(): {x: number; y: number; vx: number; vy: number};
  budget(): Budget;
  /** True while the person is waiting on something (a preview loading); whole-page work yields. */
  busy(): boolean;
}

type Level = "shallow" | "deep";
type Tier = "intent" | "nearby" | "page";
export type PreloadPriority = "normal" | "high" | "maximum";
export type PreloadState = "not-started" | "queued" | "loading" | "prepared" | "empty" | "backoff" | "blocked";

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

/** What a check found. Small enough to keep for every link on a long page. */
interface Summary {
  media: number;
  gif: boolean;
  title?: string;
  /** No deeper search could change the answer (so an empty result really means no media). */
  final: boolean;
}

/** Full galleries kept for instant display. Whole-page work never evicts one to make room. */
const RESULT_CACHE_SIZE = 80;
/** Summaries and request records kept; older ones may be checked again. */
const LINK_MEMORY = 5000;
/** Requests allowed to wait for a slot; beyond this, speculative work is simply skipped. */
const MAX_WAITING = 80;
const RETRY_AFTER_MS = 30_000;
const LOOKAHEAD_MS = 150;
/** Idle time an idle callback must have left before it starts another whole-page request. */
const IDLE_SLICE_MS = 4;
/** After consecutive failures, whole-page work pauses this long, doubling up to the cap. */
const SITE_PAUSE_MS = 10_000;
const SITE_PAUSE_MAX_MS = 5 * 60_000;
/**
 * Off-screen links checked per page visit. Links near the viewport are never
 * limited, so wherever the person scrolls stays prepared; this only keeps a
 * huge index page from costing hundreds of megabytes.
 */
const FAR_CHECK_LIMIT = 400;
/** While whole-page work waits (pressure, a preview loading), how often it looks again. */
const WAIT_RETRY_MS = 1000;

function thumbnailUrls(result: ScanResult) {
  return result.items.map(item => item.type === "video" ? item.posterUrl ?? "" : item.previewUrl).filter(Boolean);
}

function remove<K, V>(map: Map<K, V>, limit: number) {
  while (map.size > limit) map.delete(map.keys().next().value!);
}

/**
 * Keeps the newest three quarters once a large memory is full. Dropping one
 * oldest entry at a time would make every later eviction step over the
 * deleted slots at the front of the Map.
 */
function trim<K, V>(map: Map<K, V>, limit: number) {
  if (map.size <= limit) return;
  const keep = [...map].slice(-Math.floor(limit * 0.75));
  map.clear();
  for (const [key, value] of keep) map.set(key, value);
}

export class LinkPrefetcher {
  private near = new Set<HTMLAnchorElement>();
  private observer?: IntersectionObserver;
  private requested = new Map<string, Level>();
  private results = new Map<string, ScanResult>();
  private known = new Map<string, Summary>();
  private failedUntil = new Map<string, number>();
  /** Only work in progress; prepared and backoff are derived from results and failures. */
  private active = new Map<string, "queued" | "loading">();
  private priorities = new Map<string, PreloadPriority>();
  /** Links raised to "high", waiting for the next idle moment. */
  private boosted = new Set<string>();
  /** Links from a linked page's list that were prepared ahead of N; shown in the inspector. */
  private linked = new Set<string>();
  /** Links whose thumbnails were warmed, so coming back near them does not queue them again. */
  private warmed = new Map<string, true>();
  private listeners = new Set<() => void>();
  private inFlight = 0;
  private waiters: Array<() => void> = [];
  private idleHandle: number | undefined;
  /** Bumped by reset(), so answers to earlier requests are ignored. */
  private generation = 0;
  /** The page's links in document order, rebuilt lazily when links are added. */
  private pageUrls: string[] = [];
  private pageDirty = true;
  private cursor = 0;
  private pageInFlight = 0;
  private farChecks = 0;
  private failureStreak = 0;
  private pausedUntil = 0;
  private resumeTimer: number | undefined;
  /** Preparation in progress per link, so a caller that needs the result can wait for it. */
  private inflight = new Map<string, Promise<ScanResult | undefined>>();

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
    this.pageDirty = true;
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
    for (const collection of [this.requested, this.results, this.known, this.failedUntil, this.active, this.priorities]) collection.clear();
    for (const collection of [this.boosted, this.linked]) collection.clear();
    this.warmed.clear();
    this.pageDirty = true;
    this.pageInFlight = this.failureStreak = this.pausedUntil = this.farChecks = 0;
    this.changed();
    this.schedule();
  }

  /** Runs the next round of preparation once the browser is idle. Cheap to call often. */
  schedule() {
    if (this.idleHandle !== undefined || document.hidden) return;
    this.idleHandle = requestIdleCallback(deadline => {
      this.idleHandle = undefined;
      this.prepareBoosted();
      this.prepareNearest();
      this.preparePage(deadline);
    }, {timeout: 600});
  }

  /** Whether opening this link can skip the network: its gallery is here or in the service worker's cache. */
  isPrepared(url: string) {
    return this.results.has(url) || Boolean(this.known.get(url)?.media);
  }

  /** True when a check found a GIF behind this link. */
  knownGif(url: string) {
    return Boolean(this.known.get(url)?.gif);
  }

  /** True when a check found no media and no deeper search could find any. */
  knownEmpty(url: string) {
    const summary = this.known.get(url);
    return Boolean(summary && !summary.media && summary.final);
  }

  /** A prepared gallery for instant display, or undefined. */
  cached(url: string) {
    const result = this.results.get(url);
    if (!result) return undefined;
    this.results.delete(url);
    this.results.set(url, result);
    return result;
  }

  /** Galleries with media kept in memory, most recently used last. */
  galleries() {
    return [...this.results];
  }

  /** Milliseconds until a site that kept failing may be asked again; 0 when it may be asked now. */
  pausedFor() {
    return Math.max(0, this.pausedUntil - Date.now());
  }

  /**
   * A link's full scan result, empty or not (the shuffle needs its links too):
   * from memory, from a preparation already running, or asked of the service
   * worker, which answers links checked before from its cache.
   */
  async gallery(url: string): Promise<ScanResult | undefined> {
    const running = this.inflight.get(url);
    if (running) await running;
    const kept = this.results.get(url);
    if (kept) return kept;
    const settings = this.host.settingsFor(url);
    return settings ? this.prepareUrl(url, settings, "shallow", "nearby", true, true) : undefined;
  }

  /** Links known to have media. */
  get preparedCount() {
    let count = 0;
    for (const summary of this.known.values()) if (summary.media) count++;
    return count;
  }

  /**
   * Records what a scan found. Galleries with media are kept for instant
   * display unless `keep` is false (whole-page work, which never evicts one).
   */
  remember(url: string, result: ScanResult, final = result.complete, keep = true) {
    this.known.delete(url);
    this.known.set(url, {media: result.items.length, gif: hasGifMedia(result.items), title: result.title, final});
    trim(this.known, LINK_MEMORY);
    if (result.items.length && (keep || this.results.size < RESULT_CACHE_SIZE)) {
      this.results.delete(url);
      this.results.set(url, result);
      remove(this.results, RESULT_CACHE_SIZE);
    } else if (!result.items.length) {
      // Found empty after all (its media too small to count): never offer the old gallery again.
      this.results.delete(url);
    }
    this.changed();
  }

  /** Every link on the page, then linked-page links prepared ahead, with their state. One entry per URL. */
  snapshot(): PreloadEntry[] {
    const entries = new Map<string, PreloadEntry>(), now = Date.now();
    const add = (url: string, label: string, source: PreloadEntry["source"]) => {
      const summary = this.known.get(url);
      entries.set(url, {
        url, label, source, state: this.stateFor(url, Boolean(this.host.settingsFor(url)), now),
        priority: this.priorities.get(url) ?? "normal",
        hasGif: summary ? summary.gif : classifyLink(url) === "direct-image" && isGifLink(url),
        retryAt: this.failedUntil.get(url), title: summary?.title
      });
    };
    for (const anchor of document.querySelectorAll<HTMLAnchorElement>("a[href]")) {
      if (!entries.has(anchor.href)) add(anchor.href, anchor.text.trim() || anchor.href, "page");
    }
    for (const url of this.linked) if (!entries.has(url)) add(url, linkLabel(url), "linked");
    return [...entries.values()];
  }

  private stateFor(url: string, allowed: boolean, now: number): PreloadState {
    if (!allowed) return "blocked";
    const active = this.active.get(url);
    if (active) return active;
    if (this.isPrepared(url)) return "prepared";
    if ((this.failedUntil.get(url) ?? 0) > now) return "backoff";
    if (this.known.has(url)) return "empty";
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
      if (priority === "maximum") void this.prepareUrl(url, settings, "deep", "intent", true);
      else this.boosted.add(url);
    }
    this.changed();
    this.schedule();
  }

  /** The pointer reached a link: prepare it now, ahead of any queued work. */
  hover(anchor: HTMLAnchorElement) {
    const settings = this.host.settingsFor(anchor.href);
    if (settings && this.host.budget().speculative) void this.prepareUrl(anchor.href, settings, "shallow", "intent", false);
  }

  /** The pointer is staying on a link: also run the deeper linked-page search if it is enabled. */
  deepen(anchor: HTMLAnchorElement) {
    const settings = this.host.settingsFor(anchor.href);
    if (settings && settings.recursiveSearch !== "off" && this.host.budget().speculative) void this.prepareUrl(anchor.href, settings, "deep", "intent", false);
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
      void this.prepareUrl(url, settings, "shallow", "nearby", false);
    }
    this.changed();
  }

  /** "High" links go first in idle time, a few at a time. */
  private prepareBoosted() {
    const count = Math.max(1, this.host.budget().linkConcurrency);
    for (const url of [...this.boosted].slice(0, count)) {
      this.boosted.delete(url);
      const settings = this.host.settingsFor(url);
      if (settings) void this.prepareUrl(url, settings, "deep", "nearby", true);
    }
    if (this.boosted.size) this.schedule();
  }

  /** The links closest to where the pointer is heading: prepared, with their first thumbnails warm. */
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
      const result = this.results.get(anchor.href);
      if (result) this.warmThumbnails(anchor.href, result, false);
      // Checked earlier from afar, so only its summary was kept: fetch it again from the service worker's cache.
      else if (this.known.get(anchor.href)?.media) void this.prepareUrl(anchor.href, settings, "shallow", "nearby", false, true);
      else void this.prepareUrl(anchor.href, settings, "shallow", "nearby", false);
    }
  }

  /**
   * Whole-page work: every link not checked yet, those near the viewport first,
   * then near-viewport pages that need the deeper search. Starts only what the
   * budget allows and only while this idle period has time left; each finished
   * request schedules the next round, so the pass continues until the page is done.
   */
  private preparePage(deadline: IdleDeadline) {
    const budget = this.host.budget(), now = Date.now();
    // Waiting is not stopping: nothing else may come along to wake this pass, so it looks again by itself.
    if (budget.backgroundPaused || (budget.backgroundLinks > 0 && this.host.busy())) return this.resumeIn(WAIT_RETRY_MS);
    if (!budget.speculative || budget.backgroundLinks <= 0) return;
    if (now < this.pausedUntil) return this.resumeIn(this.pausedUntil - now);
    const hasTime = () => this.pageInFlight < budget.backgroundLinks && (deadline.didTimeout || deadline.timeRemaining() > IDLE_SLICE_MS);
    for (const [url, far] of this.pageCandidates()) {
      if (!hasTime()) return;
      const summary = this.known.get(url), level: Level = summary ? "deep" : "shallow";
      // Only an empty quick check that a linked-page search could still change is worth a second, deeper look.
      if (summary && (summary.media || summary.final)) continue;
      const settings = this.host.settingsFor(url);
      if (!settings || (summary && settings.recursiveSearch === "off") || !this.canStart(url, level, false, now)) continue;
      this.pageInFlight++;
      if (far) this.farChecks++;
      void this.prepareUrl(url, settings, level, "page", false).finally(() => {
        this.pageInFlight--;
        this.schedule();
      });
    }
  }

  private resumeIn(ms: number) {
    this.resumeTimer ??= window.setTimeout(() => {
      this.resumeTimer = undefined;
      this.schedule();
    }, ms);
  }

  /** Near-viewport links (checked, then searched deeper), then the rest of the page from where the pass got to. */
  private *pageCandidates(): Generator<[string, boolean]> {
    const near = [...this.near].filter(anchor => anchor.isConnected).map(anchor => anchor.href);
    for (const url of near) if (!this.requested.has(url)) yield [url, false];
    if (this.pageDirty) {
      this.pageUrls = [...new Set([...document.querySelectorAll<HTMLAnchorElement>("a[href]")].map(anchor => anchor.href))];
      this.pageDirty = false;
      this.cursor = 0;
    }
    while (this.cursor < this.pageUrls.length && this.farChecks < FAR_CHECK_LIMIT) {
      const url = this.pageUrls[this.cursor];
      if (!this.requested.has(url) && !this.known.has(url)) yield [url, true];
      this.cursor++;
    }
    for (const url of near) yield [url, false];
  }

  /** Whether preparing this link would do anything: not already running, done at this depth or resting after a failure. */
  private canStart(url: string, level: Level, refresh: boolean, now: number) {
    const previous = this.requested.get(url), upgrade = level === "deep" && previous === "shallow";
    // A link already being prepared is not started twice, but lingering may still upgrade a quick check to the deeper search.
    if (document.hidden || (this.active.has(url) && !upgrade) || this.waiters.length >= MAX_WAITING || (this.failedUntil.get(url) ?? 0) > now) return false;
    return refresh || !(previous === "deep" || (level === "shallow" && previous));
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
   * allowed even when speculative preparation is off. `refresh` fetches a link
   * already checked again, which the service worker answers from its cache.
   */
  private prepareUrl(url: string, settings: LinkPeekSettings, level: Level, tier: Tier, explicit: boolean, refresh = false) {
    if (!this.canStart(url, level, refresh, Date.now())) return Promise.resolve(undefined);
    const work = this.runPrepare(url, settings, level, tier, explicit, refresh).finally(() => {
      if (this.inflight.get(url) === work) this.inflight.delete(url);
    });
    this.inflight.set(url, work);
    return work;
  }

  private async runPrepare(url: string, settings: LinkPeekSettings, level: Level, tier: Tier, explicit: boolean, refresh: boolean): Promise<ScanResult | undefined> {
    const generation = this.generation, previous = this.requested.get(url), urgent = tier === "intent";
    this.requested.set(url, refresh && previous ? previous : level);
    trim(this.requested, LINK_MEMORY);
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
      this.failureStreak = 0;
      // An empty quick check of a page is not the last word while a linked-page search could still find media.
      const final = result.complete && (level === "deep" || classifyLink(url) !== "generic" || settings.recursiveSearch === "off");
      this.remember(url, result, final, tier !== "page");
      if (tier !== "page") this.warmThumbnails(url, result, urgent);
      return result;
    } catch {
      if (generation !== this.generation) return;
      if (previous) this.requested.set(url, previous);
      else this.requested.delete(url);
      this.failedUntil.set(url, Date.now() + RETRY_AFTER_MS);
      trim(this.failedUntil, LINK_MEMORY);
      // A link someone pointed at failing says little about the site; a run of background failures does.
      if (tier !== "intent") this.backOff();
      this.setActive(url, undefined);
    } finally {
      this.release();
    }
  }

  /** Consecutive failures usually mean the site is refusing or struggling: give it room. */
  private backOff() {
    this.failureStreak++;
    if (this.failureStreak < 2) return;
    this.pausedUntil = Date.now() + Math.min(SITE_PAUSE_MAX_MS, SITE_PAUSE_MS * 2 ** (this.failureStreak - 2));
  }

  private warmThumbnails(url: string, result: ScanResult, hovered: boolean) {
    const budget = this.host.budget(), urls = thumbnailUrls(result);
    if (hovered) {
      this.warmer.warm(urls.slice(0, budget.hoverThumbs), "now", true);
      this.warmer.warm(urls.slice(budget.hoverThumbs, budget.hoverThumbs + budget.hoverIdleThumbs), "idle");
      return;
    }
    if (this.warmed.has(url)) return;
    this.warmed.set(url, true);
    trim(this.warmed, LINK_MEMORY);
    // Nearby links warm only still images: a GIF can be megabytes for one thumbnail.
    const stills = result.items.filter(item => item.type === "image").map(item => item.previewUrl);
    this.warmer.warm(stills.slice(0, budget.thumbsPerLink), "soon");
  }
}
