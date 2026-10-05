/**
 * The content script: wires pointer intent, preparation and the viewer together.
 *
 * Owns the open preview's scan (sharing, cancelling and progress), the keyboard
 * shortcuts that act on page links, per-gallery resume positions, the preload
 * inspector and the status the toolbar popup shows.
 */
import {PREVIEWABLE_KINDS, classifyLink, contentLinks, linkLabel, type ScanResult} from "../shared/media";
import type {ScanRequest, ScanResponse, TabStatus} from "../shared/messages";
import {DEFAULT_SETTINGS, effectiveSettings, linkMatchesKeywords, loadSettings, type LinkPeekSettings} from "../shared/settings";
import {isTypingEvent, matchesCombo} from "../shared/shortcuts";
import {Viewer, type ViewerState} from "../ui/viewer";
import {HoverIntent, anchorFrom} from "./hover-intent";
import {ImageWarmer} from "./image-warmer";
import {LinkPrefetcher} from "./link-prefetcher";
import {PreloadInspector} from "./preload-inspector";
import {ResourceGovernor, TIER_NAMES} from "./resource-governor";

type ActiveScan = {url: string; token: string; settings: LinkPeekSettings};

const RESUME_MEMORY = 100;
const BRIEF_CONTINUE_MS = 1000;

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

export class PreviewController {
  private settings: LinkPeekSettings = DEFAULT_SETTINGS;
  private pageCache?: {host: string; source: LinkPeekSettings; value: LinkPeekSettings};
  private activeScan?: ActiveScan;
  private requestId = 0;
  private openAnchor: HTMLAnchorElement | null = null;
  private openUrl: string | null = null;
  /** Where the current preview was opened, so stepping through linked pages keeps the panel in place. */
  private lastPoint = {x: innerWidth / 2, y: innerHeight / 2};
  /** The linked page's list that N is stepping through, fixed until the preview closes. */
  private linkedList?: string[];
  /** Page that owns linkedList; recursive fallbacks must move to links outside this context. */
  private linkedSource?: string;
  /** Invalidates an asynchronous N / Shift+N search when the user changes direction or opens something else. */
  private linkNavigationId = 0;
  private linkNavigationCursor?: string;
  private navigationProbe?: {url: string; token: string};
  private positions = new Map<string, number>();
  private mutationFrame = 0;
  private inspectorChordUntil = 0;
  private inspectorChordKey = "";
  private disposers: Array<() => void> = [];
  readonly viewer: Viewer;
  readonly governor: ResourceGovernor;
  readonly warmer: ImageWarmer;
  readonly prefetcher: LinkPrefetcher;
  readonly inspector: PreloadInspector;
  readonly intent: HoverIntent;

  constructor() {
    this.governor = new ResourceGovernor(() => this.pageSettings());
    this.warmer = new ImageWarmer(() => this.governor.budget());
    this.viewer = new Viewer({budget: () => this.governor.budget()});
    this.intent = new HoverIntent({
      settings: () => this.pageSettings(),
      settingsFor: anchor => this.settingsFor(anchor),
      viewer: this.viewer,
      isPrepared: url => this.prefetcher.isPrepared(url),
      isOpenAnchor: anchor => this.isOpenAnchor(anchor),
      openAnchorRect: () => this.openAnchor?.isConnected ? this.openAnchor.getBoundingClientRect() : undefined,
      isScanning: () => Boolean(this.activeScan),
      onReach: anchor => this.prefetcher.hover(anchor),
      onLinger: anchor => this.prefetcher.deepen(anchor),
      onActivate: (anchor, x, y) => void this.activate(anchor, x, y),
      onLeave: () => this.onLeave(),
      onArm: (anchor, delayMs, x, y) => {
        if (this.pageSettings().showHoverRing) this.viewer.showHoverRing(x, y, delayMs, this.prefetcher.isPrepared(anchor.href));
      },
      onDisarm: () => this.viewer.hideHoverRing()
    });
    this.prefetcher = new LinkPrefetcher({
      settingsFor: url => this.settingsForUrl(url),
      pointer: () => this.intent.pointer(),
      budget: () => this.governor.budget()
    }, this.warmer);
    this.inspector = new PreloadInspector({
      snapshot: () => this.prefetcher.snapshot(),
      setPriority: (urls, priority) => this.prefetcher.setPriority(urls, priority),
      openUrl: url => this.openUrlFromInspector(url),
      subscribe: listener => this.prefetcher.subscribe(listener)
    });
  }

  async boot() {
    this.settings = await loadSettings();
    const stored = await chrome.storage.local.get("viewerState");
    this.viewer.restoreViewerState(stored.viewerState as ViewerState | undefined);
    this.viewer.onDismiss = explicit => this.onDismiss(explicit);
    this.viewer.onPosition = (url, index) => this.rememberPosition(url, index);

    const onStorage = (changes: Record<string, chrome.storage.StorageChange>, area: string) => void this.onStorageChanged(changes, area);
    chrome.storage.onChanged.addListener(onStorage);
    this.disposers.push(() => chrome.storage.onChanged.removeListener(onStorage));
    const onMessage = (msg: {type?: string}, _sender: unknown, sendResponse: (value: unknown) => void) => this.onMessage(msg, sendResponse);
    chrome.runtime.onMessage.addListener(onMessage);
    this.disposers.push(() => chrome.runtime.onMessage.removeListener(onMessage));

    this.listen("pointerover", event => this.intent.onPointerOver(event as PointerEvent));
    this.listen("pointermove", event => {
      this.intent.onPointerMove(event as PointerEvent);
      this.prefetcher.schedule();
    });
    this.listen("pointerout", event => this.intent.onPointerOut(event as PointerEvent));
    this.listen("pointerdown", event => this.onPointerDown(event as PointerEvent));
    this.listen("click", event => this.onClick(event as MouseEvent));
    this.listen("keydown", event => this.onKeyDown(event as KeyboardEvent));
    // With no preview open, link shortcuts run after the page's own handlers and yield to them.
    const onLateKeyDown = (event: KeyboardEvent) => {
      if (this.alive() && !this.viewer.isOpen && !event.defaultPrevented) this.linkKey(event);
    };
    window.addEventListener("keydown", onLateKeyDown);
    this.disposers.push(() => window.removeEventListener("keydown", onLateKeyDown));
    this.listen("scroll", () => {
      this.intent.onScroll();
      this.prefetcher.schedule();
    }, true);
    this.listen("visibilitychange", () => {
      if (document.hidden) return;
      this.prefetcher.schedule();
      this.warmer.resume();
    });

    const observer = new MutationObserver(records => this.onMutations(records));
    observer.observe(document.documentElement, {subtree: true, childList: true, attributes: true, attributeFilter: ["href"]});
    this.disposers.push(() => observer.disconnect());
    this.governor.start();
    this.disposers.push(() => this.governor.stop());
    this.prefetcher.start();
  }

  private listen(type: string, handler: (event: Event) => void, passive = false) {
    const listener = (event: Event) => {
      if (this.alive()) handler(event);
    };
    document.addEventListener(type, listener, {capture: true, passive});
    this.disposers.push(() => document.removeEventListener(type, listener, {capture: true}));
  }

  /** After the extension is updated or removed, a page's old script must stop cleanly. */
  private alive() {
    if (chrome.runtime?.id) return true;
    for (const dispose of this.disposers.splice(0)) dispose();
    this.intent.clearTimers();
    this.warmer.clear();
    this.inspector.close();
    this.viewer.close(true);
    return false;
  }

  /** Settings for the page being browsed: site rules apply to the site you are on. */
  pageSettings(): LinkPeekSettings {
    const host = location.host;
    if (this.pageCache?.host !== host || this.pageCache.source !== this.settings) {
      this.pageCache = {host, source: this.settings, value: effectiveSettings(this.settings, location.href)};
    }
    return this.pageCache.value;
  }

  /** Settings to preview this URL with, or undefined when it should be left alone. */
  settingsForUrl(url: string): LinkPeekSettings | undefined {
    const settings = this.pageSettings();
    if (!settings.enabled || !linkMatchesKeywords(settings, url)) return undefined;
    const kind = classifyLink(url);
    if (!PREVIEWABLE_KINDS.has(kind) || (kind === "direct-video" && !settings.includeVideo)) return undefined;
    return settings;
  }

  settingsFor(anchor: HTMLAnchorElement) {
    return this.settingsForUrl(anchor.href);
  }

  private isOpenAnchor(anchor: HTMLAnchorElement) {
    return anchor === this.openAnchor && anchor.href === this.openUrl;
  }

  private async onStorageChanged(changes: Record<string, chrome.storage.StorageChange>, area: string) {
    if (area !== "local" || !changes.settings) return;
    this.settings = await loadSettings();
    this.prefetcher.reset();
  }

  private onMessage(msg: {type?: string; token?: string; url?: string; result?: ScanResult}, sendResponse: (value: unknown) => void) {
    if (msg?.type === "LINKPEEK_STATUS") {
      sendResponse(this.status());
      return false;
    }
    if (msg?.type === "LINKPEEK_TOGGLE_INSPECTOR") {
      this.inspector.toggle();
      sendResponse({open: this.inspector.isOpen});
      return false;
    }
    const scan = this.activeScan;
    if (msg?.type !== "LINKPEEK_SCAN_PROGRESS" || !scan || msg.token !== scan.token || msg.url !== scan.url || !msg.result?.items) return false;
    this.prefetcher.remember(scan.url, msg.result);
    this.viewer.show(msg.result);
    return false;
  }

  status(): TabStatus {
    const settings = this.pageSettings(), governor = this.governor.status();
    return {
      enabled: settings.enabled, mode: settings.performanceMode, headroom: governor.headroom, reason: governor.reason,
      tier: TIER_NAMES[governor.tier], prepared: this.prefetcher.preparedCount, inspectorOpen: this.inspector.isOpen
    };
  }

  private onMutations(records: MutationRecord[]) {
    if (!this.pageSettings().mutationObserver) return;
    this.prefetcher.trackAdded(records);
    if (this.mutationFrame) return;
    this.mutationFrame = requestAnimationFrame(() => {
      this.mutationFrame = 0;
      this.intent.onMutation();
    });
  }

  private onLeave() {
    // Leaving only schedules a close; the scan keeps going in case the pointer is heading into the preview.
    const settings = this.pageSettings();
    if (!this.viewer.pinned && settings.activationMode !== "click") this.viewer.scheduleClose(settings.closeDelay);
  }

  private onDismiss(explicit: boolean) {
    this.requestId++;
    if (this.activeScan) this.detachOrCancel(this.activeScan, "out");
    if (explicit) this.intent.dismiss();
    else this.intent.setCurrent(null);
    this.intent.clearTimers();
    this.cancelNavigationProbe();
    this.linkNavigationId++;
    this.linkNavigationCursor = undefined;
    this.openAnchor = null;
    this.openUrl = null;
    this.linkedList = undefined;
    this.linkedSource = undefined;
  }

  private onPointerDown(event: PointerEvent) {
    const settings = this.pageSettings();
    if (!this.viewer.isOpen || this.viewer.pinned || !settings.closeOnOutsideClick) return;
    const path = event.composedPath();
    if (path.includes(this.viewer.host) || path.includes(this.inspector.host)) return;
    // In click mode the open link toggles its preview on click instead.
    if (settings.activationMode === "click" && this.openAnchor && path.includes(this.openAnchor)) return;
    this.viewer.close(true);
  }

  private onClick(event: MouseEvent) {
    if (this.pageSettings().activationMode !== "click" || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
    const anchor = anchorFrom(event.target);
    if (!anchor || !this.settingsFor(anchor)) return;
    event.preventDefault();
    if (this.isOpenAnchor(anchor)) {
      this.viewer.close(true);
      return;
    }
    this.intent.setCurrent(anchor);
    void this.activate(anchor, event.clientX, event.clientY);
  }

  /**
   * The inspector chord: the inspector shortcut (Ctrl+X by default), then the same
   * key alone within the chord interval. Arming never blocks the page's own Cut.
   */
  private inspectorKey(event: KeyboardEvent) {
    if (this.inspector.key(event)) return true;
    const settings = this.pageSettings();
    if (!settings.enabled || isTypingEvent(event) || event.repeat) {
      this.inspectorChordUntil = 0;
      return false;
    }
    const now = performance.now();
    if (matchesCombo(event, settings.shortcuts.preloadInspector)) {
      this.inspectorChordKey = event.key.toLowerCase();
      this.inspectorChordUntil = now + settings.inspectorChordMs;
      return false;
    }
    const armed = this.inspectorChordUntil >= now;
    this.inspectorChordUntil = 0;
    if (!armed || event.key.toLowerCase() !== this.inspectorChordKey || event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) return false;
    this.inspector.toggle();
    return true;
  }

  /** While a preview is open, LinkPeek owns the keyboard: its keys never reach the page. */
  private onKeyDown(event: KeyboardEvent) {
    if (this.inspectorKey(event) || this.viewer.key(event)) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (this.viewer.isOpen) this.linkKey(event);
  }

  /** Next / previous link: probe candidates until one really resolves to media. */
  private linkKey(event: KeyboardEvent) {
    const settings = this.pageSettings();
    if (!settings.enabled || this.viewer.help || isTypingEvent(event)) return;
    const direction = matchesCombo(event, settings.shortcuts.nextLink) ? 1 : matchesCombo(event, settings.shortcuts.previousLink) ? -1 : 0;
    if (!direction || !(this.openAdjacentLinked(direction) || this.openAdjacentPrepared(direction))) return;
    event.preventDefault();
    event.stopPropagation();
  }

  private openUrlFromInspector(url: string) {
    const anchor = [...document.querySelectorAll<HTMLAnchorElement>("a[href]")].find(candidate => candidate.href === url);
    if (anchor) this.openPageLink(anchor);
    else this.openOffPage(url, false);
  }

  /** Opens a link that is on the page, scrolling it into view first when needed. */
  private openPageLink(anchor: HTMLAnchorElement, resolved?: ScanResult) {
    let rect = anchor.getBoundingClientRect();
    if (rect.bottom < 0 || rect.top > innerHeight) {
      anchor.scrollIntoView?.({block: "nearest", inline: "nearest"});
      rect = anchor.getBoundingClientRect();
    }
    this.intent.setCurrent(anchor);
    this.viewer.cancelClose();
    void this.activate(anchor, clamp(rect.left + rect.width / 2, 8, innerWidth - 8), clamp(rect.top + rect.height / 2, 8, innerHeight - 8), false, resolved);
  }

  /** Opens a link that is not on this page where the last preview opened, so the panel stays put. */
  private openOffPage(url: string, keepList: boolean, resolved?: ScanResult) {
    if (!this.settingsForUrl(url)) return;
    const anchor = Object.assign(document.createElement("a"), {href: url, textContent: linkLabel(url)});
    this.intent.setCurrent(anchor);
    this.viewer.cancelClose();
    void this.activate(anchor, this.lastPoint.x, this.lastPoint.y, keepList, resolved);
  }

  private normalizeUrl(raw: string) {
    try {
      const url = new URL(raw, location.href);
      url.hash = "";
      return url.href;
    } catch {
      return raw;
    }
  }

  /** All links physically present on the browser page, regardless of whether LinkPeek may open them. */
  private currentPageUrls() {
    return new Set([...document.querySelectorAll<HTMLAnchorElement>("a[href]")].map(anchor => this.normalizeUrl(anchor.href)));
  }

  /** The linked page's list for the item on screen, when the gallery was built from linked pages. */
  private linkedContextForCurrent(): {source: string; links: string[]} | undefined {
    const result = this.viewer.result, source = result?.items[this.viewer.index]?.sourceUrl;
    const context = source !== result?.url ? result?.linkContexts?.find(entry => this.normalizeUrl(entry.sourceUrl) === this.normalizeUrl(source ?? "")) : undefined;
    const links = context && contentLinks(context).filter(url => this.settingsForUrl(url));
    return links?.length && source ? {source, links} : undefined;
  }

  /** Candidate order after the current URL, wrapping once and never returning the current item itself. */
  private orderedCandidates(urls: readonly string[], direction: 1 | -1, current: string | null) {
    if (!urls.length) return [];
    const normalized = urls.map(url => this.normalizeUrl(url)), here = current ? this.normalizeUrl(current) : null;
    const index = here ? normalized.indexOf(here) : -1;
    const count = index < 0 ? urls.length : Math.max(0, urls.length - 1), out: string[] = [];
    for (let step = 0; step < count; step++) {
      const at = index < 0
        ? (direction > 0 ? step : urls.length - 1 - step)
        : (index + direction * (step + 1) + urls.length * 2) % urls.length;
      out.push(urls[at]);
    }
    return out;
  }

  private cancelNavigationProbe() {
    const probe = this.navigationProbe;
    if (!probe) return;
    this.navigationProbe = undefined;
    chrome.runtime.sendMessage({type: "LINKPEEK_CANCEL_SCAN", url: probe.url, token: probe.token}).catch(() => undefined);
  }

  /** Full interactive scan used only to decide whether N should land on a candidate. */
  private async scanForNavigation(url: string, navigationId: number) {
    const prepared = this.prefetcher.cached(url);
    if (prepared?.items.length) return prepared;
    const token = `nav-${Date.now()}-${navigationId}-${Math.random().toString(36).slice(2)}`;
    this.navigationProbe = {url, token};
    try {
      const response = await chrome.runtime.sendMessage({type: "LINKPEEK_SCAN", url, kind: classifyLink(url), token} satisfies ScanRequest) as ScanResponse | undefined;
      if (navigationId !== this.linkNavigationId) return undefined;
      if (!response || "cancelled" in response || "error" in response) return undefined;
      if (response.items.length) this.prefetcher.remember(url, response);
      return response;
    } catch {
      return undefined;
    } finally {
      if (this.navigationProbe?.token === token) this.navigationProbe = undefined;
    }
  }

  /**
   * A recursive scan may find media on pages linked from the candidate. When
   * that happens, choose a media-bearing child that is genuinely new to the
   * current navigation context instead of bouncing back to one of its links.
   */
  private resolveNavigationTarget(candidate: string, result: ScanResult, excluded: Set<string>, direction: 1 | -1) {
    if (!result.items.length) return undefined;
    const rootSources = new Set([candidate, result.url, result.linkContexts?.[0]?.sourceUrl].filter(Boolean).map(url => this.normalizeUrl(url!)));
    const rootItems = result.items.filter(item => rootSources.has(this.normalizeUrl(item.sourceUrl)));
    if (result.kind !== "generic" || rootItems.length) return {url: candidate, result, linkedSource: undefined as string | undefined, linkedList: undefined as string[] | undefined};

    const mediaSources = new Set(result.items.map(item => this.normalizeUrl(item.sourceUrl)));
    const contextOrder = (result.linkContexts ?? []).map(context => context.sourceUrl);
    const itemOrder = result.items.map(item => item.sourceUrl);
    const ordered = [...new Set([...contextOrder, ...itemOrder])]
      .filter(source => mediaSources.has(this.normalizeUrl(source)))
      .filter(source => !rootSources.has(this.normalizeUrl(source)))
      .filter(source => !excluded.has(this.normalizeUrl(source)))
      .filter(source => Boolean(this.settingsForUrl(source)));
    if (direction < 0) ordered.reverse();
    const child = ordered[0];
    if (!child) return undefined;
    const childItems = result.items.filter(item => this.normalizeUrl(item.sourceUrl) === this.normalizeUrl(child));
    if (!childItems.length) return undefined;
    const context = result.linkContexts?.find(entry => this.normalizeUrl(entry.sourceUrl) === this.normalizeUrl(child));
    const linkedList = context ? contentLinks(context).filter(url => this.settingsForUrl(url)) : undefined;
    return {
      url: child,
      result: {...result, url: child, title: undefined, items: childItems},
      linkedSource: child,
      linkedList: linkedList?.length ? linkedList : undefined
    };
  }

  private async navigateCandidates(
    candidates: readonly string[],
    direction: 1 | -1,
    excluded: Set<string>,
    pageAnchors?: Map<string, HTMLAnchorElement>,
    keepExistingList = false
  ) {
    const navigationId = ++this.linkNavigationId;
    this.cancelNavigationProbe();
    this.requestId++;
    if (this.activeScan) this.detachOrCancel(this.activeScan, "switch");
    this.activeScan = undefined;
    for (const candidate of candidates) {
      if (navigationId !== this.linkNavigationId) return;
      this.linkNavigationCursor = candidate;
      const result = await this.scanForNavigation(candidate, navigationId);
      if (navigationId !== this.linkNavigationId) return;
      if (!result?.items.length) continue;
      const target = this.resolveNavigationTarget(candidate, result, excluded, direction);
      if (!target) continue;
      this.linkNavigationCursor = undefined;
      if (target.url !== candidate) {
        this.linkedSource = target.linkedSource;
        this.linkedList = target.linkedList;
        this.prefetcher.remember(target.url, target.result);
        this.openOffPage(target.url, true, target.result);
        if (target.linkedList?.length) this.prefetcher.warmAround(target.linkedList, -1);
        return;
      }
      if (keepExistingList) {
        this.prefetcher.remember(candidate, target.result);
        this.openOffPage(candidate, true, target.result);
        const at = this.linkedList?.indexOf(candidate) ?? -1;
        if (this.linkedList?.length) this.prefetcher.warmAround(this.linkedList, at);
        return;
      }
      const anchor = pageAnchors?.get(this.normalizeUrl(candidate));
      if (anchor) {
        this.prefetcher.remember(candidate, target.result);
        this.openPageLink(anchor, target.result);
        return;
      }
    }
    if (navigationId === this.linkNavigationId) this.linkNavigationCursor = undefined;
  }

  /** Steps through a linked page's list, skipping empty/failing links. */
  private openAdjacentLinked(direction: 1 | -1) {
    const context = this.linkedList?.length && this.linkedSource
      ? {source: this.linkedSource, links: this.linkedList}
      : this.linkedContextForCurrent();
    if (!context) return false;
    this.linkedList = context.links;
    this.linkedSource = context.source;
    const current = this.linkNavigationCursor ?? this.openUrl;
    const candidates = this.orderedCandidates(context.links, direction, current);
    if (!candidates.length) return false;
    const excluded = new Set(context.links.map(url => this.normalizeUrl(url)));
    excluded.add(this.normalizeUrl(context.source));
    void this.navigateCandidates(candidates, direction, excluded, undefined, true);
    return true;
  }

  /** Walks page links in document order and only lands on ones that resolve to media. */
  openAdjacentPrepared(direction: 1 | -1) {
    const anchors = [...document.querySelectorAll<HTMLAnchorElement>("a[href]")].filter(anchor => this.settingsFor(anchor));
    const byUrl = new Map<string, HTMLAnchorElement>(), urls: string[] = [];
    for (const anchor of anchors) {
      const key = this.normalizeUrl(anchor.href);
      if (byUrl.has(key)) continue;
      byUrl.set(key, anchor);
      urls.push(anchor.href);
    }
    const current = this.linkNavigationCursor ?? this.openUrl ?? this.intent.currentAnchor?.href ?? null;
    const candidates = this.orderedCandidates(urls, direction, current);
    if (!candidates.length) return false;
    void this.navigateCandidates(candidates, direction, this.currentPageUrls(), byUrl);
    return true;
  }

  /** When a gallery built from linked pages appears, prepare the first links of its list so N is instant. */
  private warmLinkedList() {
    const context = this.linkedList?.length && this.linkedSource
      ? {source: this.linkedSource, links: this.linkedList}
      : this.linkedContextForCurrent();
    if (!context) return;
    this.linkedList = context.links;
    this.linkedSource = context.source;
    this.prefetcher.warmAround(context.links, context.links.indexOf(this.openUrl!));
  }

  private rememberPosition(url: string, index: number) {
    this.positions.delete(url);
    this.positions.set(url, index);
    while (this.positions.size > RESUME_MEMORY) this.positions.delete(this.positions.keys().next().value!);
  }

  private cancelScan(scan: ActiveScan) {
    chrome.runtime.sendMessage({type: "LINKPEEK_CANCEL_SCAN", url: scan.url, token: scan.token}).catch(() => undefined);
    if (this.activeScan?.token === scan.token) this.activeScan = undefined;
  }

  /** Stops caring about a scan; depending on settings it keeps running briefly or to the end, so reopening is instant. */
  private detachOrCancel(scan: ActiveScan, reason: "switch" | "out") {
    const mode = scan.settings.continueAfterClose;
    if (mode === "always" || (mode === "brief" && reason === "out")) {
      if (this.activeScan?.token === scan.token) this.activeScan = undefined;
      if (mode === "brief") window.setTimeout(() => this.cancelScan(scan), BRIEF_CONTINUE_MS);
      return;
    }
    this.cancelScan(scan);
  }

  /** Opens a preview. `keepList` keeps the linked page's list N is stepping through. */
  async activate(anchor: HTMLAnchorElement, x: number, y: number, keepList = false, resolved?: ScanResult) {
    this.intent.clearTimers();
    if (this.isOpenAnchor(anchor) && !resolved) return;
    this.cancelNavigationProbe();
    this.linkNavigationId++;
    this.linkNavigationCursor = undefined;
    if (!keepList) {
      this.linkedList = undefined;
      this.linkedSource = undefined;
    }
    if (this.activeScan) this.detachOrCancel(this.activeScan, "switch");
    const settings = this.settingsFor(anchor);
    if (!settings) return;
    const url = anchor.href, id = ++this.requestId;
    this.openAnchor = anchor;
    this.openUrl = url;
    this.lastPoint = {x, y};
    this.viewer.openLoading(x, y, settings, anchor.textContent?.trim().slice(0, 80) || "Scanning link…", settings.resumePosition ? this.positions.get(url) : undefined);
    if (resolved) {
      this.activeScan = undefined;
      this.prefetcher.remember(url, resolved);
      this.viewer.show(resolved);
      this.warmLinkedList();
      return;
    }
    const token = `${Date.now()}-${id}-${Math.random().toString(36).slice(2)}`;
    this.activeScan = {url, token, settings};
    // A prepared gallery shows in the first frame; the full scan then fills in the rest.
    const prepared = this.prefetcher.cached(url);
    if (prepared) this.viewer.show(prepared);
    const request: ScanRequest = {type: "LINKPEEK_SCAN", url, kind: classifyLink(url), token};
    try {
      const response = await chrome.runtime.sendMessage(request) as ScanResponse | undefined;
      if (id !== this.requestId || this.activeScan?.token !== token) return;
      if (!response) throw new Error("LinkPeek's background service did not answer. Try again.");
      if ("cancelled" in response) return;
      if ("error" in response) throw new Error(response.error);
      this.prefetcher.remember(url, response);
      this.viewer.show(response);
      this.warmLinkedList();
    } catch (error) {
      if (id === this.requestId && this.activeScan?.token === token) this.viewer.error(error instanceof Error ? error.message : String(error));
    } finally {
      if (this.activeScan?.token === token) this.activeScan = undefined;
    }
  }
}
