/**
 * The preview panel: a focus view (one media item, zoomable) and a virtualized
 * grid, mounted in a Shadow DOM so the host page's CSS cannot reach it.
 *
 * Moving between items swaps only the media element; the panel, its listeners
 * and the gesture controller stay in place. Buttons use one delegated click
 * handler keyed by data-action, shared with the keyboard shortcuts.
 */
import type {Budget} from "../content/resource-governor";
import {escapeHtml, policyAllows} from "../shared/dom";
import {isFavorite, toggleFavorite} from "../shared/favorites";
import {linkLabel, safeDownloadName, safeFolderName, uniqueMediaItems, type MediaItem, type ScanResult} from "../shared/media";
import {DEFAULT_SETTINGS, type LinkPeekSettings, type ShortcutAction} from "../shared/settings";
import {isTypingEvent, matchesCombo} from "../shared/shortcuts";
import {GestureController} from "./gesture";
import {MediaPreloader} from "./media-preloader";
import {PanelGeometry, validGeometry, type Geometry, type ResizeEdge} from "./panel-geometry";
import {overlayCss} from "./styles";
import * as markup from "./viewer-markup";
import {VirtualGrid} from "./virtual-grid";

type GifPlayerLike = {init: () => Promise<void>; destroy: () => void; key: (event: KeyboardEvent) => boolean; loopMs: () => number};
export type GifModule = {
  GifPlayer: new (stage: HTMLElement, url: string, settings: LinkPeekSettings, onNotice?: (message: string) => void, onWidth?: (width: number) => void) => GifPlayerLike;
  prepareGif: (url: string, maxMb: number) => Promise<unknown>;
};
export type View = markup.View;
export type ViewerState = {view?: View; gridThumbSize?: number; expanded?: boolean; geometry?: Partial<Geometry>};

/** Shortcut actions the viewer handles itself, in matching order. Link actions belong to the page. */
const KEY_ACTIONS: readonly ShortcutAction[] = [
  "next", "previous", "grid", "expand", "pin", "favorite", "open", "openPage", "download", "downloadAll", "copy", "slideshow",
  "popOut", "fill", "rotate", "zoomIn", "zoomOut", "resetZoom", "help"
];
/** How long the first Shift+D waits for the second before forgetting it. */
const CONFIRM_MS = 3000;
/** Longest a video or GIF holds a slide while it plays through. */
const PLAY_THROUGH_MAX_MS = 60_000;
/** How often a slideshow at the end of a growing gallery looks for the next item. */
const MORE_POLL_MS = 1000;
const TOAST_MS = 900;
const BUSY_AFTER_MS = 120;
const ZOOM_STEP = 1.2;
const MIN_THUMB = 48;
const MAX_THUMB = 320;
const THUMB_STEP = 16;

export class Viewer {
  readonly host = document.createElement("div");
  readonly panel = document.createElement("section");
  private shadow = this.host.attachShadow({mode: "open"});
  private root = document.createElement("div");
  settings: LinkPeekSettings = DEFAULT_SETTINGS;
  result?: ScanResult;
  index = 0;
  view: View = "focus";
  zoom = 1;
  tx = 0;
  ty = 0;
  pinned = false;
  help = false;
  onDismiss?: (explicit: boolean) => void;
  onPosition?: (url: string, index: number) => void;
  /** A result reached the screen (first show or a change); the mirror window follows these. */
  onShown?: () => void;
  /** Asked before a slideshow starts; returning true means the host started its own (the shuffle). */
  onSlideshowStart?: () => boolean;
  /** Each item shown in single view. */
  onSeen?: (item: MediaItem) => void;
  /** Reached the end of a gallery that is still growing. */
  onNeedMore?: () => void;
  /** Every item turned out too small to count, leaving the gallery empty. */
  onEmptied?: (url: string) => void;
  /** Asked before expanding; returning true means the host handled it (the mirror goes full screen instead). */
  onExpand?: () => boolean;
  private expanded = false;
  private gridThumbSize = 120;
  private remembered: {view?: View; gridThumbSize?: number; expanded?: boolean} = {};
  private geometry: PanelGeometry;
  private preloader: MediaPreloader;
  private gesture?: GestureController;
  private grid?: VirtualGrid;
  private gifPlayer?: GifPlayerLike;
  private gifModule?: Promise<GifModule>;
  private loadGifPlayer: () => Promise<GifModule>;
  private stage?: HTMLElement;
  private closeTimer?: number;
  private toastTimer?: number;
  private slideshowTimer?: number;
  /** The floating always-on-top window holding the preview, while popped out. */
  private pip?: Window;
  /** False in windows (the mirror) that must not write layout memory shared with page panels. */
  private persistEnabled = true;
  /** The panel fills the window it is in (the mirror window); floating does the same. */
  private fillsWindow = false;
  /** The page host can hide its copy while a mirror window is following it. */
  private concealed = false;
  private slideshow = false;
  private slideshowPaused = false;
  private waitingForMore = false;
  private failure?: string;
  private title = "";
  private openX = 0;
  private openY = 0;
  private pendingIndex: number | null = null;
  private pendingStart: number | null = null;
  private navigationVersion = 0;
  private renderVersion = 0;
  private favorite = false;
  private favoriteVersion = 0;
  private rejectedMedia = new Set<string>();
  /** Degrees the current media is turned (R). */
  private rotation = 0;
  /** Filling the panel instead of fitting it (W). */
  private filled = false;
  private downloadAllUntil = 0;
  private ringCycle = 0;
  /** The hover countdown, beside the pointer; outside the panel so it shows before a preview opens. */
  private ring = Object.assign(document.createElement("div"), {
    className: "lp-ring",
    innerHTML: `<svg viewBox="0 0 20 20" aria-hidden="true"><circle class="lp-ring-track" cx="10" cy="10" r="8"/><circle class="lp-ring-arc" cx="10" cy="10" r="8" pathLength="100"/></svg>`
  });

  /** `loadGifPlayer` defaults to the separately built gif-player.js, loaded only when a GIF is shown. */
  constructor(options: {budget: () => Budget; loadGifPlayer?: () => Promise<GifModule>; persist?: boolean}) {
    this.loadGifPlayer = options.loadGifPlayer ?? (() => import(chrome.runtime.getURL("gif-player.js")) as Promise<GifModule>);
    this.root.className = "lp-root";
    this.shadow.append(Object.assign(document.createElement("style"), {textContent: overlayCss}), this.root, this.ring);
    document.documentElement.appendChild(this.host);
    this.preloader = new MediaPreloader(options.budget);
    this.geometry = new PanelGeometry(this.panel, () => this.persistState());
    this.persistEnabled = options.persist ?? true;
    this.panel.addEventListener("click", this.onPanelClick);
    this.panel.addEventListener("dblclick", this.onPanelDoubleClick);
    this.panel.addEventListener("pointerdown", this.onPanelPointerDown);
    this.panel.addEventListener("mousedown", this.onPanelMouseDown);
    this.panel.addEventListener("mouseup", this.onPanelMouseUp);
    this.panel.addEventListener("auxclick", this.onPanelAuxClick);
    this.panel.addEventListener("mouseenter", () => this.cancelClose());
    this.panel.addEventListener("mouseleave", () => {
      if (!this.pinned && !this.geometry.manipulating && this.settings.activationMode !== "click") this.scheduleClose(this.settings.closeDelay);
    });
    window.addEventListener("resize", () => {
      if (this.isOpen && !this.expanded) this.geometry.reclamp(this.settings);
    });
  }

  get isOpen() {
    return this.root.childElementCount > 0;
  }

  /** True inside the panel, or inside the forgiving bridge between the link and the panel. */
  containsPoint(x: number, y: number, from?: DOMRect) {
    if (!this.isOpen) return false;
    const panel = this.panel.getBoundingClientRect(), pad = Math.max(8, Math.round(this.settings.magneticBridgeStrength * 20));
    if (x >= panel.left - pad && x <= panel.right + pad && y >= panel.top - pad && y <= panel.bottom + pad) return true;
    if (!from || !this.settings.magneticBridge) return false;
    const left = Math.min(from.left, panel.left) - pad, right = Math.max(from.right, panel.right) + pad;
    const top = Math.min(from.top, panel.top) - pad, bottom = Math.max(from.bottom, panel.bottom) + pad;
    return x >= left && x <= right && y >= top && y <= bottom;
  }

  restoreViewerState(state?: ViewerState) {
    if (state?.view === "focus" || state?.view === "grid") this.remembered.view = state.view;
    if (Number.isFinite(state?.gridThumbSize)) this.remembered.gridThumbSize = Math.max(MIN_THUMB, Math.min(MAX_THUMB, Number(state!.gridThumbSize)));
    if (typeof state?.expanded === "boolean") this.remembered.expanded = state.expanded;
    this.geometry.remembered = validGeometry(state?.geometry);
  }

  private persistState() {
    this.remembered = {view: this.view, gridThumbSize: this.gridThumbSize, expanded: this.expanded};
    if (!this.persistEnabled) return;
    const viewerState: ViewerState = {...this.remembered};
    if (this.settings.rememberPanelGeometry && this.geometry.remembered) viewerState.geometry = this.geometry.remembered;
    try {
      chrome.storage.local.set({viewerState}).catch(() => undefined);
    } catch {
      // The extension was reloaded under this page; layout memory is not worth an error.
    }
  }

  /**
   * Shows the hover countdown beside the pointer. It fills over `durationMs`;
   * a ready (prepared) link shows in the signal colour. Alternating animation
   * names restart the fill without forcing a layout.
   */
  showHoverRing(x: number, y: number, durationMs: number, ready: boolean) {
    // The countdown sits at page pointer coordinates, which mean nothing in the floating window.
    if (this.pip) return;
    const ring = this.ring;
    ring.style.left = `${x + 14}px`;
    ring.style.top = `${y + 14}px`;
    ring.style.setProperty("--lp-ring-ms", `${Math.max(1, durationMs)}ms`);
    ring.dataset.cycle = String(this.ringCycle ^= 1);
    ring.className = `lp-ring lp-on${ready ? " lp-ready" : ""}`;
  }

  hideHoverRing() {
    this.ring.classList.remove("lp-on");
  }

  scheduleClose(delayMs: number) {
    if (this.pinned) return;
    this.cancelClose();
    this.closeTimer = window.setTimeout(() => this.close(), delayMs);
  }

  cancelClose() {
    clearTimeout(this.closeTimer);
    this.closeTimer = undefined;
  }

  /** Opens the panel in its loading state. `startIndex` resumes a gallery where it was left. */
  openLoading(x: number, y: number, settings: LinkPeekSettings, title = "Scanning link…", startIndex?: number) {
    this.cancelClose();
    this.stopSlideshow();
    this.teardownBody();
    if (!this.host.isConnected) document.documentElement.appendChild(this.host);
    this.settings = settings;
    this.help = false;
    this.result = undefined;
    this.failure = undefined;
    this.index = 0;
    this.pendingIndex = null;
    this.pendingStart = startIndex ?? null;
    this.favorite = false;
    this.rejectedMedia.clear();
    this.title = title;
    this.openX = x;
    this.openY = y;
    this.hideHoverRing();
    this.resetView();
    this.expanded = this.remembered.expanded ?? settings.startExpanded;
    this.gridThumbSize = this.remembered.gridThumbSize ?? settings.thumbnailSize;
    this.view = this.remembered.view ?? settings.defaultView;
    this.applyPanelStyle();
    this.geometry.place(x, y, settings);
    this.render();
    this.root.replaceChildren(this.panel);
  }

  /** Shows a scan result, merging progressive updates for the same URL into the open gallery. */
  show(incoming: ScanResult) {
    if (!this.isOpen) return;
    const previous = this.result?.url === incoming.url ? this.result : undefined;
    if (!previous) {
      // A different gallery starts from its first item and abandons any move in flight.
      this.index = 0;
      this.pendingIndex = null;
      this.navigationVersion++;
    }
    const items = uniqueMediaItems(previous ? [...previous.items, ...incoming.items] : incoming.items).items
      .filter(item => !this.rejectedMedia.has(item.id));
    const currentId = previous?.items[this.index]?.id;
    this.result = {
      ...previous, ...incoming, items,
      complete: Boolean(previous?.complete || incoming.complete),
      postsScanned: Math.max(previous?.postsScanned ?? 0, incoming.postsScanned ?? 0) || undefined,
      totalPosts: Math.max(previous?.totalPosts ?? 0, incoming.totalPosts ?? 0) || undefined,
      diagnostics: incoming.diagnostics ?? previous?.diagnostics
    };
    this.failure = undefined;
    let jumped = false;
    if (this.pendingStart !== null && (items.length > this.pendingStart || this.result.complete)) {
      jumped = this.index !== Math.min(this.pendingStart, Math.max(0, items.length - 1));
      this.index = Math.min(this.pendingStart, Math.max(0, items.length - 1));
      this.pendingStart = null;
    }
    this.index = Math.min(this.index, Math.max(0, items.length - 1));
    if (!previous?.items.length || jumped) {
      this.render();
      if (!previous) void this.refreshFavorite();
      this.onShown?.();
      return;
    }
    const changed = items.length !== previous.items.length || this.result.complete !== previous.complete || this.result.postsScanned !== previous.postsScanned || items[this.index]?.id !== currentId;
    if (!changed) return;
    this.preloader.reset(items, this.index, this.settings);
    if (this.view === "grid") {
      this.grid?.setItems(items);
      this.updateGridProgress();
      this.updateChrome();
    } else if (items[this.index]?.id !== currentId) {
      this.showFocusMedia();
    } else {
      this.updateChrome();
    }
    this.onShown?.();
  }

  /** Reports a failed scan. A gallery already on screen stays; the problem is only mentioned. */
  error(message: string) {
    if (!this.isOpen) return;
    if (this.result?.items.length) {
      this.toast(message);
      return;
    }
    this.failure = message;
    this.render();
  }

  close(force = false) {
    if (!this.isOpen || (this.pinned && !force)) return;
    if (force) this.pinned = false;
    this.popIn();
    this.cancelClose();
    this.stopSlideshow();
    this.geometry.cancel();
    this.renderVersion++;
    this.navigationVersion++;
    this.pendingIndex = null;
    this.teardownBody();
    this.preloader.dispose();
    this.root.replaceChildren();
    this.result = undefined;
    this.help = false;
    this.onDismiss?.(force);
  }

  /** Handles a key press while the panel is open. Returns true when the key was used. */
  key(event: KeyboardEvent) {
    if (!this.isOpen || isTypingEvent(event)) return false;
    const keys = this.settings.shortcuts, hit = (action: ShortcutAction) => matchesCombo(event, keys[action]);
    if (this.help) {
      if (event.key === "Escape" || hit("help") || hit("close")) {
        this.toggleHelp();
        return true;
      }
      return false;
    }
    if (event.key === "Escape" || hit("close")) {
      this.close(true);
      return true;
    }
    // While a slideshow runs, its pause key comes first (by default Space, which otherwise means next).
    if (this.slideshow && hit("pause")) return this.perform("pause");
    if (this.view === "focus" && this.gifPlayer?.key(event)) return true;
    if (this.view === "grid" && this.gridKey(event)) return true;
    const action = KEY_ACTIONS.find(hit);
    return action ? this.perform(action) : false;
  }

  /** Spatial keys in the grid: arrows move by tile and row, Enter opens the selected media. */
  private gridKey(event: KeyboardEvent) {
    if (event.ctrlKey || event.metaKey || event.altKey || !this.result?.items.length) return false;
    const columns = this.grid?.columns() ?? 1;
    const moves: Record<string, number> = {ArrowLeft: -1, ArrowRight: 1, ArrowUp: -columns, ArrowDown: columns};
    if (event.key in moves) {
      this.moveGridSelection(this.index + moves[event.key]);
      return true;
    }
    if (event.key === "Home" || event.key === "End") {
      this.moveGridSelection(event.key === "Home" ? 0 : this.result.items.length - 1);
      return true;
    }
    if (event.key === "Enter") {
      this.pick(this.index);
      return true;
    }
    return false;
  }

  private moveGridSelection(target: number) {
    this.index = Math.max(0, Math.min(this.result!.items.length - 1, target));
    this.grid?.setCurrent(this.index, "nearest");
    this.updateChrome();
    this.reportPosition();
  }

  /** Runs a button or shortcut action. */
  private perform(action: string): boolean {
    const item = this.result?.items[this.index];
    switch (action) {
      case "next":
      case "previous":
        void this.navigate(action === "next" ? 1 : -1).then(() => this.keepSlideshowGoing());
        return true;
      case "pause":
        this.toggleSlideshowPause();
        return true;
      case "grid":
        this.toggleView();
        return true;
      case "expand":
        if (this.onExpand?.()) return true;
        this.expanded = !this.expanded;
        this.persistState();
        this.applyPanelStyle();
        this.render();
        return true;
      case "pin":
        this.pinned = !this.pinned;
        this.renderHeader();
        this.toast(this.pinned ? "Pinned open" : "Unpinned");
        return true;
      case "favorite":
        void this.toggleFavorite();
        return true;
      case "open":
      case "post":
        if (item) window.open(action === "post" ? item.sourceUrl : item.originalUrl, "_blank", "noopener");
        return true;
      case "openPage": {
        const page = this.pageUrl();
        if (page) window.open(page, "_blank", "noopener");
        return true;
      }
      case "downloadAll":
        this.downloadAll();
        return true;
      case "fill":
        this.toggleFill();
        return true;
      case "rotate":
        this.rotate();
        return true;
      case "popOut":
        void this.popOut();
        return true;
      case "download":
        if (item) this.download(item);
        return true;
      case "copy":
        if (item) void this.copyLink(item);
        return true;
      case "slideshow":
        if (this.slideshow) this.stopSlideshow(true);
        else if (!this.onSlideshowStart?.()) this.startSlideshow();
        return true;
      case "zoomIn":
      case "zoomOut":
        if (this.view === "grid") this.resizeTiles(action === "zoomIn" ? THUMB_STEP : -THUMB_STEP);
        else this.applyZoom(action === "zoomIn" ? ZOOM_STEP : 1 / ZOOM_STEP, (this.stage?.clientWidth ?? 0) / 2, (this.stage?.clientHeight ?? 0) / 2);
        return true;
      case "resetZoom":
        this.resetView();
        this.paintTransform();
        return true;
      case "grid-smaller":
      case "grid-bigger":
        this.resizeTiles(action === "grid-bigger" ? THUMB_STEP : -THUMB_STEP);
        return true;
      case "help":
        this.toggleHelp();
        return true;
      case "close":
        this.close(true);
        return true;
      default:
        return false;
    }
  }

  private onPanelClick = (event: MouseEvent) => {
    const control = (event.target as Element).closest?.<HTMLElement>("[data-action]");
    if (control) this.perform(control.dataset.action!);
  };

  private onPanelDoubleClick = (event: MouseEvent) => {
    if (!(event.target as Element).closest?.(".lp-title") || !this.settings.rememberPanelGeometry) return;
    this.geometry.remembered = undefined;
    this.geometry.place(this.openX, this.openY, this.settings);
    this.persistState();
    this.toast("Panel layout reset");
  };

  /** Stops middle-button autoscroll over the media, where middle-click opens the original instead. */
  private onPanelMouseDown = (event: MouseEvent) => {
    if (event.button === 1 && (event.target as Element).closest?.(".lp-stage, .lp-title")) event.preventDefault();
  };

  /** Mouse back/forward buttons step through the media instead of navigating the page. */
  private onPanelMouseUp = (event: MouseEvent) => {
    if (event.button !== 3 && event.button !== 4) return;
    event.preventDefault();
    event.stopPropagation();
    this.perform(event.button === 3 ? "previous" : "next");
  };

  /** Middle-click: the media's original, or the linked page from the title, in a background tab. */
  private onPanelAuxClick = (event: MouseEvent) => {
    if (event.button !== 1) return;
    const target = event.target as Element, item = this.result?.items[this.index];
    const url = target.closest?.(".lp-title") ? this.pageUrl() : target.closest?.(".lp-caption") ? item?.sourceUrl : target.closest?.(".lp-stage") ? item?.originalUrl : undefined;
    if (!url) return;
    event.preventDefault();
    chrome.runtime.sendMessage({type: "LINKPEEK_OPEN_TAB", url, active: false})
      .then(() => this.toast("Opened in a background tab"))
      .catch(() => window.open(url, "_blank", "noopener"));
  };

  private onPanelPointerDown = (event: PointerEvent) => {
    if (this.expanded || this.pip || event.button !== 0) return;
    const target = event.target as Element, handle = target.closest?.<HTMLElement>("[data-resize]");
    if (handle && this.settings.resizablePanel) {
      this.cancelClose();
      this.geometry.begin(event, handle.dataset.resize as ResizeEdge);
    } else if (this.settings.draggablePanel && target.closest?.(".lp-head") && !target.closest("button,input,select")) {
      this.cancelClose();
      this.geometry.begin(event, "move");
    }
  };

  private applyPanelStyle() {
    const s = this.settings, style = this.panel.style;
    this.panel.className = `lp-panel${this.expanded ? " lp-expanded" : ""}${s.reducedMotion ? " lp-calm" : ""}${this.fillsWindow || this.pip ? " lp-popped" : ""}`;
    this.panel.setAttribute("role", "dialog");
    style.setProperty("--lp-maxh", `${s.panelMaxVh}vh`);
    style.setProperty("--lp-stageh", `${s.focusHeightVh}vh`);
    style.setProperty("--lp-expandedw", `${s.expandedWidthVw}vw`);
    style.setProperty("--lp-expandedh", `${s.expandedHeightVh}vh`);
    style.background = `rgba(17, 21, 18, ${Math.max(0.1, 1 - s.transparency)})`;
    style.backdropFilter = `blur(${s.blur}px)`;
  }

  private headerTitle() {
    if (!this.result) return this.title;
    try {
      return this.result.title || new URL(this.result.url).hostname;
    } catch {
      return this.result.url;
    }
  }

  /** The page the media on screen belongs to: the gallery's link, or in a shuffle, the link this item came from. */
  private pageUrl() {
    return this.result?.mixed ? this.result.items[this.index]?.sourceUrl : this.result?.url;
  }

  private headerMarkup() {
    return markup.headerMarkup({
      title: this.headerTitle(), count: this.result?.items.length, view: this.view, expanded: this.expanded, pinned: this.pinned,
      favorite: this.favorite, slideshow: this.slideshow, slideshowPaused: this.slideshowPaused, popped: Boolean(this.pip), fills: this.fillsWindow, help: this.help, settings: this.settings
    });
  }

  private footerMarkup() {
    return markup.footerMarkup({
      result: this.result, index: this.pendingIndex ?? this.index, view: this.view, gridThumbSize: this.gridThumbSize,
      slideshow: this.slideshow, slideshowPaused: this.slideshowPaused, settings: this.settings
    });
  }

  private bodyMarkup() {
    const result = this.result, item = result?.items[this.index];
    if (this.failure) return markup.errorMarkup(this.failure);
    if (!result || (!result.items.length && !result.complete)) return markup.loadingMarkup;
    if (!item) return markup.emptyMarkup;
    if (this.view === "grid") return markup.gridMarkup(result);
    return markup.stageMarkup(item, this.settings, item.type === "image" && this.preloader.isReady(item));
  }

  private teardownBody() {
    this.grid?.destroy();
    this.grid = undefined;
    this.gesture?.destroy();
    this.gesture = undefined;
    this.gifPlayer?.destroy();
    this.gifPlayer = undefined;
    this.stage = undefined;
  }

  /** Rebuilds the whole panel. Used when the view changes; moving between items does not come here. */
  private render() {
    const version = ++this.renderVersion;
    this.teardownBody();
    this.panel.setAttribute("aria-label", `LinkPeek preview: ${this.headerTitle()}`);
    const resize = this.settings.resizablePanel && !this.expanded ? markup.resizeHandles() : "";
    this.panel.innerHTML = this.headerMarkup() + this.bodyMarkup() + this.footerMarkup() + resize
      + `<div class="lp-live" aria-live="polite"></div><div class="lp-toast" role="status"></div>`
      + (this.help ? markup.helpMarkup(this.settings.shortcuts, this.result?.items[this.index]?.type === "gif") : "");
    const result = this.result, item = result?.items[this.index];
    if (!result || !item || this.failure) return;
    this.preloader.reset(result.items, this.index, this.settings);
    if (this.view === "grid") {
      this.grid = new VirtualGrid(this.panel.querySelector<HTMLElement>(".lp-grid")!, result.items, {
        cell: this.gridThumbSize, current: this.index, onPick: index => this.pick(index),
        onWidth: (index, width) => {
          const candidate = this.result?.items[index];
          if (candidate && candidate.previewUrl === candidate.originalUrl) this.rejectIfTooNarrow(candidate, width, version);
        }
      });
      return;
    }
    this.stage = this.panel.querySelector<HTMLElement>(".lp-stage")!;
    this.gesture = new GestureController(this.stage, {
      next: count => this.navigateFromGesture(count ?? 1),
      previous: count => this.navigateFromGesture(-(count ?? 1)),
      scrub: delta => this.navigateFromGesture(delta > 0 ? this.settings.maxImagesPerSwipe : -this.settings.maxImagesPerSwipe),
      pan: (dx, dy) => this.pan(dx, dy),
      zoom: (factor, x, y) => this.applyZoom(factor, x, y),
      doubleClick: (x, y) => this.onDoubleClick(x, y),
      isZoomed: () => this.zoom > 1.01
    }, this.settings);
    this.fillMedia(item, version);
  }

  private renderHeader() {
    this.panel.querySelector(".lp-head")?.replaceWith(this.fragment(this.headerMarkup()));
  }

  private fragment(html: string) {
    const template = document.createElement("template");
    template.innerHTML = html;
    return template.content;
  }

  /** Refreshes the counter, status and actions after navigation or a progress update. */
  private updateChrome() {
    this.panel.querySelector(".lp-foot")?.replaceWith(this.fragment(this.footerMarkup()));
    const meta = this.panel.querySelector(".lp-meta");
    if (meta) meta.textContent = String(this.result?.items.length ?? "");
  }

  private updateGridProgress() {
    const bar = this.panel.querySelector(".lp-grid-progress");
    if (!bar || !this.result) return;
    if (this.result.complete) bar.remove();
    else bar.lastElementChild!.textContent = `Still scanning · ${markup.progressText(this.result)}`;
  }

  /** The small "where it came from" link in the corner of the media; a link, so it opens that page. */
  private updateCaption(item: MediaItem) {
    const text = this.settings.showSourceTitle ? markup.captionText(item, this.result) : "";
    let caption = this.stage?.querySelector<HTMLAnchorElement>(".lp-caption");
    if (!text) return caption?.remove();
    if (!caption) {
      caption = Object.assign(document.createElement("a"), {className: "lp-caption", target: "_blank", rel: "noopener"});
      this.stage!.append(caption);
    }
    caption.textContent = text;
    caption.href = item.sourceUrl;
    caption.title = `Open ${item.sourceUrl}`;
  }

  /** Places the item's media in the stage: the decoded image, a GIF player or a video. */
  private fillMedia(item: MediaItem, version: number) {
    const slot = this.stage?.querySelector(".lp-image-slot");
    const decoded = slot ? this.preloader.element(item) : undefined;
    if (slot && decoded) {
      decoded.className = "lp-image";
      decoded.alt = item.filename || "Preview image";
      slot.replaceWith(decoded);
    }
    if (item.type === "gif") void this.mountGif(item, version);
    this.updateCaption(item);
    this.onSeen?.(item);
    // In a shuffle each item may come from a different link, so the saved-link star follows it.
    if (this.result?.mixed) void this.refreshFavorite();
    this.watchActualWidth(item, version);
    this.paintTransform();
    void this.prepareNextGif();
  }

  /** Swaps the media for the current item without rebuilding the panel. */
  private showFocusMedia(failed = false) {
    const item = this.result!.items[this.index], holder = this.stage?.querySelector(".lp-media");
    if (!holder) return this.render();
    const version = ++this.renderVersion;
    this.gifPlayer?.destroy();
    this.gifPlayer = undefined;
    holder.innerHTML = markup.mediaMarkup(item, this.settings, !failed && item.type === "image" && this.preloader.isReady(item), failed);
    const tip = this.stage!.querySelector(".lp-tip");
    if (tip) tip.textContent = markup.tipText(item);
    this.fillMedia(item, version);
    this.updateChrome();
    const live = this.panel.querySelector(".lp-live");
    if (live) live.textContent = `Media ${this.index + 1} of ${this.result!.items.length}`;
  }

  /** Removes media whose real decoded width is below the configured threshold. */
  private rejectIfTooNarrow(item: MediaItem, width: number, version: number) {
    if (!width || width >= this.settings.minWidth || version !== this.renderVersion || !this.result) return;
    const at = this.result.items.findIndex(entry => entry.id === item.id);
    if (at < 0) return;
    this.rejectedMedia.add(item.id);
    const items = this.result.items.filter(entry => entry.id !== item.id), wasCurrent = at === this.index;
    this.result = {...this.result, items};
    if (at < this.index) this.index--;
    this.index = Math.min(this.index, Math.max(0, items.length - 1));
    if (!items.length) {
      this.render();
      return this.onEmptied?.(this.result.url);
    }
    // Drop it in place: the grid keeps its scroll position and the stage keeps its listeners.
    this.preloader.reset(items, this.index, this.settings);
    if (this.view === "grid") {
      this.grid?.setItems(items);
      this.updateChrome();
    } else if (wasCurrent) {
      this.navigationVersion++;
      this.pendingIndex = null;
      this.showFocusMedia();
    } else {
      this.updateChrome();
    }
  }

  /** Browser-decoded dimensions catch media whose HTML omitted or misstated width. */
  private watchActualWidth(item: MediaItem, version: number) {
    if (this.settings.minWidth <= 0) return;
    if (item.type === "video") {
      const video = this.stage?.querySelector<HTMLVideoElement>(".lp-video");
      if (!video) return;
      const check = () => this.rejectIfTooNarrow(item, video.videoWidth, version);
      if (video.readyState >= 1) check();
      else video.addEventListener("loadedmetadata", check, {once: true});
      return;
    }
    if (item.type === "image" && item.previewUrl === item.originalUrl) {
      const image = this.stage?.querySelector<HTMLImageElement>(".lp-image");
      if (!image) return;
      const check = () => this.rejectIfTooNarrow(item, image.naturalWidth, version);
      if (image.complete && image.naturalWidth) check();
      else image.addEventListener("load", check, {once: true});
      return;
    }
    // A thumbnail says nothing about the original's dimensions. Do not download
    // full-resolution stills just to measure them. GIFs report their decoded size.
  }

  private loadGifModule() {
    this.gifModule ??= this.loadGifPlayer();
    return this.gifModule;
  }

  private async mountGif(item: MediaItem, version: number) {
    try {
      const module = await this.loadGifModule();
      if (version !== this.renderVersion || this.view !== "focus" || this.result?.items[this.index] !== item) return;
      const player = new module.GifPlayer(this.stage!, item.originalUrl, this.settings, message => this.toast(message), width => this.rejectIfTooNarrow(item, width, version));
      this.gifPlayer = player;
      await player.init();
    } catch (error) {
      if (version !== this.renderVersion) return;
      const mount = this.stage?.querySelector(".lp-gif-mount");
      if (mount) mount.innerHTML = `<div class="lp-gif-fallback"><img class="lp-image" src="${escapeHtml(item.originalUrl)}" alt="Animated GIF"><span>Native GIF playback</span></div>`;
      this.toast(error instanceof Error ? error.message : "GIF controls unavailable");
    }
  }

  /** Starts decoding the next GIF's frames in the background so its controls are ready on arrival. */
  private async prepareNextGif() {
    const items = this.result?.items ?? [], next = items[this.settings.wrapAround ? (this.index + 1) % items.length : this.index + 1];
    if (next?.type !== "gif") return;
    try {
      const module = await this.loadGifModule();
      await module.prepareGif(next.originalUrl, this.settings.gifDecodeMaxMb);
    } catch {
      // Preparation is opportunistic; the player retries when the GIF is shown.
    }
  }

  private navigateFromGesture(delta: number) {
    void this.navigate(delta).then(() => this.keepSlideshowGoing());
  }

  /** Moves through the gallery. The counter updates at once; the media swaps when it is decoded. */
  private async navigate(delta: number) {
    const items = this.result?.items;
    if (!items?.length) return;
    const base = this.pendingIndex ?? this.index;
    if (!this.result!.complete && base + delta >= items.length) {
      // A gallery that is still growing waits for more rather than wrapping back to the start.
      this.onNeedMore?.();
      this.toast("Loading more…");
      return;
    }
    const target = this.settings.wrapAround ? ((base + delta) % items.length + items.length) % items.length : Math.max(0, Math.min(items.length - 1, base + delta));
    this.pendingStart = null;
    if (target === base) {
      if (!this.settings.wrapAround) this.toast(delta > 0 ? "Last item" : "First item");
      return;
    }
    if (this.view === "grid") {
      this.moveGridSelection(target);
      return;
    }
    const version = ++this.navigationVersion;
    this.pendingIndex = target;
    this.updateChrome();
    this.preloader.schedule(target, Math.sign(delta));
    const busy = window.setTimeout(() => this.stage?.classList.add("lp-busy"), BUSY_AFTER_MS);
    const loaded = await this.preloader.ensure(items[target]);
    clearTimeout(busy);
    // Progress updates replace the item list while a long thread scans; only a different item cancels the move.
    if (version !== this.navigationVersion || this.result?.items[target]?.id !== items[target].id) return;
    this.stage?.classList.remove("lp-busy");
    this.index = target;
    this.pendingIndex = null;
    if (this.settings.resetZoomPerImage) this.resetView();
    this.showFocusMedia(!loaded);
    this.reportPosition();
  }

  private reportPosition() {
    if (this.result) this.onPosition?.(this.result.url, this.index);
  }

  private pick(index: number) {
    this.index = index;
    this.view = "focus";
    this.persistState();
    this.render();
    this.reportPosition();
  }

  private toggleView() {
    this.stopSlideshow();
    this.view = this.view === "grid" ? "focus" : "grid";
    this.persistState();
    this.render();
  }

  private resizeTiles(step: number) {
    this.gridThumbSize = Math.max(MIN_THUMB, Math.min(MAX_THUMB, this.gridThumbSize + step));
    this.persistState();
    this.grid?.setCell(this.gridThumbSize);
    this.updateChrome();
    this.toast(`${this.gridThumbSize}px tiles`);
  }

  /** Starts a slideshow of the gallery on screen. Public so the shuffle can start one on the gallery it builds. */
  startSlideshow() {
    if (!this.result?.items.length) return;
    this.slideshow = true;
    this.slideshowPaused = false;
    this.waitingForMore = false;
    if (this.view === "grid") {
      this.view = "focus";
      this.render();
    } else {
      this.renderHeader();
      this.updateChrome();
    }
    this.toast(`Slideshow · every ${this.settings.slideshowSeconds}s`);
    this.queueSlide();
  }

  private queueSlide(delay = this.slideDelay()) {
    clearTimeout(this.slideshowTimer);
    this.slideshowTimer = window.setTimeout(() => void this.advanceSlide(), delay);
  }

  private async advanceSlide() {
    const items = this.result?.items ?? [];
    if (this.index >= items.length - 1) {
      if (!this.result?.complete) {
        // Still growing (a long thread loading, or the shuffle finding more): wait for the next item.
        this.onNeedMore?.();
        if (!this.waitingForMore) this.toast("Finding more media…");
        this.waitingForMore = true;
        return this.queueSlide(MORE_POLL_MS);
      }
      // A finished shuffle stops rather than replay what was just seen.
      if (!this.settings.wrapAround || this.result?.mixed) {
        this.stopSlideshow();
        this.toast("End of gallery");
        return;
      }
    }
    this.waitingForMore = false;
    await this.navigate(1);
    if (this.slideshow && !this.slideshowPaused) this.queueSlide();
  }

  /**
   * How long the item on screen stays up: the slideshow speed, or for a video
   * or GIF that should play through, the rest of its running time (capped).
   */
  private slideDelay() {
    const base = this.settings.slideshowSeconds * 1000, item = this.result?.items[this.index];
    if (!this.settings.slideshowPlayThrough || !item) return base;
    let playing = 0;
    if (item.type === "video") {
      const video = this.stage?.querySelector<HTMLVideoElement>(".lp-video");
      if (video && (video.autoplay || !video.paused) && Number.isFinite(video.duration) && video.duration > 0) {
        playing = (video.duration - video.currentTime) * 1000;
      } else if (video?.readyState === 0) {
        // Its length is not known yet: look again once it is.
        video.addEventListener("loadedmetadata", () => {
          if (this.slideshow && !this.slideshowPaused && this.result?.items[this.index] === item) this.queueSlide();
        }, {once: true});
      }
    } else if (item.type === "gif") {
      playing = this.gifPlayer?.loopMs() ?? 0;
    }
    return Math.min(PLAY_THROUGH_MAX_MS, Math.max(base, playing));
  }

  /** After moving by hand during a slideshow, the next slide is a full interval away again. */
  private keepSlideshowGoing() {
    if (this.slideshow && !this.slideshowPaused) this.queueSlide();
  }

  private pauseSlideshow() {
    if (!this.slideshow || this.slideshowPaused) return;
    this.slideshowPaused = true;
    clearTimeout(this.slideshowTimer);
    this.renderHeader();
    this.updateChrome();
  }

  private toggleSlideshowPause() {
    if (!this.slideshow) return;
    if (this.slideshowPaused) {
      this.slideshowPaused = false;
      this.renderHeader();
      this.updateChrome();
      this.toast("Slideshow playing");
      this.queueSlide();
    } else {
      this.pauseSlideshow();
      this.toast("Paused · Space to resume");
    }
  }

  private stopSlideshow(announce = false) {
    if (!this.slideshow) return;
    this.slideshow = false;
    this.slideshowPaused = false;
    this.waitingForMore = false;
    clearTimeout(this.slideshowTimer);
    if (!this.isOpen) return;
    this.renderHeader();
    this.updateChrome();
    if (announce) this.toast("Slideshow stopped");
  }

  private toggleHelp() {
    this.help = !this.help;
    if (this.help) this.panel.append(this.fragment(markup.helpMarkup(this.settings.shortcuts, this.result?.items[this.index]?.type === "gif")));
    else this.panel.querySelector(".lp-help")?.remove();
    this.panel.querySelector(".lp-helpbtn")?.setAttribute("aria-expanded", String(this.help));
    this.panel.querySelector<HTMLElement>(this.help ? ".lp-help-close" : ".lp-helpbtn")?.focus();
  }

  private download(item: MediaItem) {
    chrome.runtime.sendMessage({type: "LINKPEEK_DOWNLOAD", url: item.originalUrl, filename: safeDownloadName(item)})
      .then((response: {error?: string} | undefined) => this.toast(response?.error ? "Download failed" : "Downloading…"))
      .catch(() => this.toast("Download failed"));
  }

  /** Downloads every original into one folder; the first press asks for a second within a few seconds. */
  private downloadAll() {
    const result = this.result;
    if (!result?.items.length) return;
    if (result.items.length === 1) return this.download(result.items[0]);
    if (Date.now() > this.downloadAllUntil) {
      this.downloadAllUntil = Date.now() + CONFIRM_MS;
      this.toast(`Press again to download all ${result.items.length}`);
      return;
    }
    this.downloadAllUntil = 0;
    const items = result.items.map(item => ({url: item.originalUrl, filename: safeDownloadName(item)}));
    chrome.runtime.sendMessage({type: "LINKPEEK_DOWNLOAD_ALL", folder: safeFolderName(this.headerTitle()), items})
      .then((response: {error?: string; started?: number} | undefined) => {
        const started = response?.error ? 0 : response?.started ?? items.length;
        this.toast(!started ? "Downloads failed" : started < items.length ? `Downloading ${started} of ${items.length} files…` : `Downloading ${items.length} files…`);
      })
      .catch(() => this.toast("Downloads failed"));
  }

  /** The element the zoom and pan transform applies to. */
  private mediaElement() {
    return this.stage?.querySelector<HTMLElement>(".lp-image");
  }

  /** W: fill the panel (scroll to pan along the long side), or back to fitting it. */
  private toggleFill() {
    const media = this.mediaElement(), stage = this.stage;
    if (this.view !== "focus" || !media || !stage?.clientWidth || !media.offsetWidth) return;
    if (this.filled) {
      this.resetZoom();
      this.paintTransform();
      this.toast("Fit");
      return;
    }
    const turned = this.rotation % 180 !== 0, width = turned ? media.offsetHeight : media.offsetWidth, height = turned ? media.offsetWidth : media.offsetHeight;
    this.zoom = Math.min(this.settings.maxZoom, Math.max(stage.clientWidth / width, stage.clientHeight / height));
    // Start at the top-left corner; clamping then centres the axis that fits.
    this.tx = -media.offsetLeft;
    this.ty = -media.offsetTop;
    this.filled = true;
    this.paintTransform();
    this.toast("Fill · scroll to pan");
  }

  /** R: a quarter turn clockwise. */
  private rotate() {
    if (this.view !== "focus" || !this.mediaElement()) return;
    this.rotation = (this.rotation + 90) % 360;
    this.resetZoom();
    this.paintTransform();
    this.toast(this.rotation ? `Rotated ${this.rotation}°` : "Upright");
  }

  private async copyLink(item: MediaItem) {
    // A site can block clipboard writes, and plain-http pages have no clipboard.
    if (!policyAllows("clipboard-write")) return this.toast("This site doesn’t allow copying");
    const copied = await navigator.clipboard?.writeText(item.originalUrl).then(() => true, () => false);
    this.toast(copied ? "Media link copied" : "Couldn’t copy the link");
  }

  private resetZoom() {
    this.zoom = 1;
    this.tx = this.ty = 0;
    this.filled = false;
  }

  /** Zoom, fill and rotation back to the media's natural fit. */
  private resetView() {
    this.resetZoom();
    this.rotation = 0;
  }

  /**
   * Keeps the panel working but unseen, while a mirror window shows previews
   * on another screen. Floating previews are never hidden.
   */
  conceal(hidden: boolean) {
    this.concealed = hidden;
    this.applyVisibility();
  }

  private applyVisibility() {
    this.host.style.visibility = this.concealed && !this.pip ? "hidden" : "";
  }

  /** Makes the panel fill the window it is in, for the mirror window. */
  fillWindow() {
    this.fillsWindow = true;
    this.panel.classList.add("lp-popped");
    this.renderHeader();
  }

  /** Jumps straight to an item, for the mirror window following browsing on another screen. */
  jumpTo(index: number) {
    const items = this.result?.items;
    if (!this.isOpen || !items?.length || this.pendingIndex !== null) return;
    const target = Math.max(0, Math.min(items.length - 1, index));
    if (target === this.index) return;
    if (this.view === "grid") return this.moveGridSelection(target);
    this.index = target;
    this.showFocusMedia();
  }

  applyZoom(factor: number, x: number, y: number) {
    // Looking closer pauses a slideshow rather than ending it.
    this.pauseSlideshow();
    const old = this.zoom;
    this.zoom = Math.max(1, Math.min(this.settings.maxZoom, this.zoom * factor));
    if (old === this.zoom && factor > 1 && old > 1) {
      this.resetZoom();
    } else {
      const ratio = this.zoom / old;
      this.tx = x - (x - this.tx) * ratio;
      this.ty = y - (y - this.ty) * ratio;
    }
    if (this.zoom === 1) this.tx = this.ty = 0;
    this.paintTransform();
    this.toast(`${Math.round(this.zoom * 100)}%`);
  }

  pan(dx: number, dy: number) {
    if (this.zoom <= 1) return;
    this.tx += dx;
    this.ty += dy;
    this.paintTransform();
  }

  /**
   * Keeps zoomed media covering the stage: it cannot be dragged past its own
   * edges, and an axis that fits is centred. Skipped without layout or while turned.
   */
  private clampPan() {
    const media = this.mediaElement(), stage = this.stage;
    if (!media || !stage?.clientWidth || !media.offsetWidth || this.rotation || this.zoom <= 1) return;
    const clampAxis = (offset: number, view: number, size: number, start: number) =>
      size <= view ? (view - size) / 2 - start : Math.min(-start, Math.max(view - size - start, offset));
    this.tx = clampAxis(this.tx, stage.clientWidth, media.offsetWidth * this.zoom, media.offsetLeft);
    this.ty = clampAxis(this.ty, stage.clientHeight, media.offsetHeight * this.zoom, media.offsetTop);
  }

  onDoubleClick(x: number, y: number) {
    const mode = this.settings.doubleClick;
    if (mode === "next") {
      this.navigateFromGesture(1);
    } else if (mode === "fullscreen") {
      if (document.fullscreenElement) void document.exitFullscreen();
      // Where the site blocks full screen, the panel expands to fill the tab instead.
      else if (this.panel.requestFullscreen && policyAllows("fullscreen")) void this.panel.requestFullscreen().catch(() => this.perform("expand"));
      else this.perform("expand");
    } else if (this.zoom > 1 && this.settings.secondDoubleClick === "fit") {
      this.resetZoom();
      this.paintTransform();
      this.toast("Fit");
    } else {
      this.applyZoom(this.settings.doubleClickZoom, x, y);
    }
  }

  paintTransform() {
    this.clampPan();
    const media = this.mediaElement(), holder = this.stage?.querySelector<HTMLElement>(".lp-media");
    if (media) media.style.transform = `translate(${this.tx}px, ${this.ty}px) scale(${this.zoom})`;
    if (!holder || !this.stage) return;
    // A quarter turn swaps the box the media fits into, so it still fits the stage once turned.
    const turned = this.rotation % 180 !== 0;
    holder.classList.toggle("lp-turned", turned);
    holder.style.width = turned ? `${this.stage.clientHeight}px` : "";
    holder.style.height = turned ? `${this.stage.clientWidth}px` : "";
    holder.style.rotate = this.rotation ? `${this.rotation}deg` : "";
  }

  /**
   * Floats the preview in its own always-on-top window (document
   * picture-in-picture): it stays over every tab and application, and is
   * dragged, resized and closed like any window. Hovering links on the page
   * keeps feeding it. Called again, it brings the preview back into the page.
   */
  async popOut() {
    if (this.pip) return this.popIn("Back in the page");
    const api = (window as Window & {documentPictureInPicture?: {requestWindow(options: {width: number; height: number}): Promise<Window>}}).documentPictureInPicture;
    if (!api) return this.toast("Floating needs a Chromium 116+ browser");
    if (!this.isOpen) return;
    try {
      const pip = await api.requestWindow({width: Math.max(360, this.panel.offsetWidth || 520), height: Math.max(260, this.panel.offsetHeight || 420)});
      this.pip = pip;
      this.applyVisibility();
      pip.document.body.style.margin = "0";
      pip.document.body.style.background = "#080A09";
      pip.document.body.append(this.host);
      pip.document.addEventListener("keydown", this.onPipKey);
      pip.addEventListener("pagehide", () => this.popIn(), {once: true});
      this.panel.classList.add("lp-popped");
      // Floating is an explicit ask to keep it: leaving links on the page must not close it.
      this.pinned = true;
      this.renderHeader();
      this.toast("Floating above every window");
    } catch {
      this.toast("Couldn’t open the floating window");
    }
  }

  /** The floating window has its own document, so its keys are brought to the viewer. */
  private onPipKey = (event: KeyboardEvent) => {
    if (!this.key(event)) return;
    event.preventDefault();
    event.stopPropagation();
  };

  /** Returns the preview to the page and closes the floating window. */
  private popIn(announce?: string) {
    const pip = this.pip;
    if (!pip) return;
    this.pip = undefined;
    this.applyVisibility();
    pip.document.removeEventListener("keydown", this.onPipKey);
    document.documentElement.append(this.host);
    this.panel.classList.toggle("lp-popped", this.fillsWindow);
    if (!pip.closed) pip.close();
    this.renderHeader();
    if (announce) this.toast(announce);
  }

  private async refreshFavorite() {
    const url = this.pageUrl(), version = ++this.favoriteVersion;
    if (!url) return;
    try {
      const value = await isFavorite(url);
      if (version !== this.favoriteVersion || this.pageUrl() !== url || this.favorite === value) return;
      this.favorite = value;
      this.renderHeader();
    } catch {
      // Storage unavailable: the star simply stays empty.
    }
  }

  private async toggleFavorite() {
    const current = this.result, url = this.pageUrl();
    if (!current || !url) return;
    try {
      const outcome = current.mixed
        ? await toggleFavorite({url, title: linkLabel(url), mediaCount: current.items.filter(item => item.sourceUrl === url).length})
        : await toggleFavorite({url, title: this.headerTitle(), mediaCount: current.items.length});
      if (this.pageUrl() !== url) return;
      this.favorite = outcome.saved;
      this.renderHeader();
      this.toast(outcome.saved ? "Link saved" : "Saved link removed");
    } catch {
      this.toast("Couldn’t update saved links");
    }
  }

  toast(text: string) {
    const toast = this.panel.querySelector(".lp-toast");
    if (!toast) return;
    toast.textContent = text;
    toast.classList.add("lp-on");
    clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => toast.classList.remove("lp-on"), TOAST_MS);
  }
}
