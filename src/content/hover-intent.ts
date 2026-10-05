/**
 * Decides when hovering a link means "show me".
 *
 * A link opens after the hover delay, sooner when the pointer comes to rest on
 * a link whose media is already prepared. Moving across a link, a link that
 * slides under a still pointer while the page scrolls, and a link whose preview
 * was just dismissed never open by themselves.
 *
 * While a preview is open, other links are slow to take over: links on the path
 * between the open link and its preview never do, and any other link needs the
 * longer switch delay, so reaching for the preview never swaps it out.
 */
import type {LinkPeekSettings} from "../shared/settings";

export interface IntentViewer {
  readonly host: HTMLElement;
  readonly isOpen: boolean;
  readonly pinned: boolean;
  containsPoint(x: number, y: number, from?: DOMRect): boolean;
  cancelClose(): void;
}

export interface IntentHost {
  settings(): LinkPeekSettings;
  /** Effective settings when this link may be previewed here, otherwise undefined. */
  settingsFor(anchor: HTMLAnchorElement): LinkPeekSettings | undefined;
  viewer: IntentViewer;
  isPrepared(url: string): boolean;
  isOpenAnchor(anchor: HTMLAnchorElement): boolean;
  /** Where the link whose preview is open sits, for the path to the preview. */
  openAnchorRect(): DOMRect | undefined;
  isScanning(): boolean;
  /** The pointer reached a previewable link. */
  onReach(anchor: HTMLAnchorElement): void;
  /** The pointer stayed on a link long enough to justify deeper preparation. */
  onLinger(anchor: HTMLAnchorElement): void;
  onActivate(anchor: HTMLAnchorElement, x: number, y: number): void;
  /** The pointer left the current link without moving into the preview. */
  onLeave(anchor: HTMLAnchorElement): void;
  /** A link will open in `delayMs` unless the pointer moves on (drives the hover ring). */
  onArm(anchor: HTMLAnchorElement, delayMs: number, x: number, y: number): void;
  /** The pending open was cancelled or happened. */
  onDisarm(): void;
}

/** How long the pointer must be motionless to count as resting on a link. */
const STILL_MS = 90;
const REARM_AFTER_MS = 90;
const REARM_DELAY_MAX_MS = 160;
const LINGER_MAX_MS = 100;
/** Pointer samples further apart than this say nothing about its current speed. */
const VELOCITY_WINDOW_MS = 100;

export function anchorFrom(target: EventTarget | null): HTMLAnchorElement | null {
  return (target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null ?? null;
}

export class HoverIntent {
  private current: HTMLAnchorElement | null = null;
  private currentUrl: string | null = null;
  private dismissed: {anchor: HTMLAnchorElement; url: string} | null = null;
  private armTimer: number | undefined;
  private stillTimer: number | undefined;
  private rearmTimer: number | undefined;
  private lingerTimer: number | undefined;
  private startX = 0;
  private startY = 0;
  private x = innerWidth / 2;
  private y = innerHeight / 2;
  private vx = 0;
  private vy = 0;
  private alt = false;
  private lastEventAt = -Infinity;
  private lastPhysicalMoveAt = -Infinity;
  private lastScrollAt = -Infinity;

  constructor(private host: IntentHost) {}

  pointer() {
    return {x: this.x, y: this.y, vx: this.vx, vy: this.vy};
  }

  get currentAnchor() {
    return this.current;
  }

  /** Makes `anchor` the link under consideration without arming it (keyboard navigation). */
  setCurrent(anchor: HTMLAnchorElement | null) {
    this.current = anchor;
    this.currentUrl = anchor?.href ?? null;
  }

  /** The preview was closed on purpose: do not reopen it until the pointer leaves the link. */
  dismiss() {
    const under = anchorFrom(document.elementFromPoint?.(this.x, this.y) ?? null);
    if (this.current && under === this.current) this.dismissed = {anchor: this.current, url: this.currentUrl!};
    this.clearTimers();
    this.setCurrent(null);
  }

  onScroll() {
    this.lastScrollAt = performance.now();
    // Chrome may re-hit-test the element under the stationary pointer just
    // before delivering scroll. Cancel anything that hit-test armed; a real
    // pointer move will re-arm it through onPointerMove.
    if (this.host.settings().ignoreScrollHover) {
      this.clearTimer("armTimer");
      this.clearTimer("stillTimer");
      this.clearTimer("lingerTimer");
      this.clearTimer("rearmTimer");
    }
  }

  /** Records the pointer; returns true when it actually moved (not a re-hit-test after scrolling). */
  private track(event: PointerEvent) {
    const now = performance.now(), dt = Math.max(1, now - this.lastEventAt);
    const dx = event.clientX - this.x, dy = event.clientY - this.y;
    // A pointer event at the same spot is the browser re-hit-testing after a scroll, not the hand moving.
    const moved = Math.abs(dx) >= 1 || Math.abs(dy) >= 1;
    if (moved) {
      this.lastPhysicalMoveAt = now;
      const fresh = dt <= VELOCITY_WINDOW_MS;
      this.vx = fresh ? this.vx * 0.6 + (dx / dt) * 0.4 : 0;
      this.vy = fresh ? this.vy * 0.6 + (dy / dt) * 0.4 : 0;
    }
    this.x = event.clientX;
    this.y = event.clientY;
    this.alt = event.altKey;
    this.lastEventAt = now;
    return moved;
  }

  /** The pointer is inside the open preview, its margin, or the corridor from its link to it. */
  private onPathToPreview() {
    return this.host.viewer.isOpen && this.host.viewer.containsPoint(this.x, this.y, this.host.openAnchorRect());
  }

  private isCurrent(anchor: HTMLAnchorElement) {
    return anchor === this.current && anchor.href === this.currentUrl;
  }

  private inViewer(event: Event) {
    return event.composedPath().includes(this.host.viewer.host);
  }

  onPointerOver(event: PointerEvent) {
    this.track(event);
    if (this.host.settings().activationMode === "click") return;
    if (this.inViewer(event)) return this.host.viewer.cancelClose();
    const anchor = anchorFrom(event.target);
    if (anchor) this.consider(anchor);
  }

  onPointerMove(event: PointerEvent) {
    const physical = this.track(event);
    if (this.inViewer(event)) return this.host.viewer.cancelClose();
    const settings = this.host.settings(), mode = settings.activationMode;
    if (mode !== "click") {
      const anchor = anchorFrom(event.target);
      if (anchor && !this.isCurrent(anchor)) this.consider(anchor);
    }
    if (this.onPathToPreview()) return this.host.viewer.cancelClose();
    const current = this.current;
    // Only a real hand movement arms a link; a link that scrolled under the pointer waits for one.
    if (!current || mode === "click" || this.host.isOpenAnchor(current) || !physical) return;
    if (mode === "modifier") {
      if (!event.altKey) return this.clearTimers();
      if (this.armTimer === undefined) return this.arm(current);
    }
    if (this.armTimer !== undefined && Math.hypot(event.clientX - this.startX, event.clientY - this.startY) > settings.cancelMovePx) {
      // Sweeping across a large link: wait until the pointer settles again.
      this.clearTimer("armTimer");
      this.clearTimer("stillTimer");
    }
    if (this.armTimer === undefined && !this.host.isScanning()) {
      this.clearTimer("rearmTimer");
      const url = current.href;
      this.rearmTimer = window.setTimeout(() => {
        this.rearmTimer = undefined;
        if (this.current === current && current.href === url) this.arm(current, Math.min(REARM_DELAY_MAX_MS, settings.hoverDelay));
      }, REARM_AFTER_MS);
    }
  }

  onPointerOut(event: PointerEvent) {
    const anchor = anchorFrom(event.target);
    if (!anchor) return;
    const to = event.relatedTarget as Node | null;
    if (to && (anchor.contains(to) || to === this.host.viewer.host || this.host.viewer.host.contains(to))) return;
    if (this.dismissed?.anchor === anchor) this.dismissed = null;
    if (anchor !== this.current) return;
    this.clearTimers();
    this.host.onLeave(anchor);
    if (!this.host.isOpenAnchor(anchor)) this.setCurrent(null);
  }

  /** Content changed under a resting pointer: a link may have appeared or been recycled there. */
  onMutation() {
    if (this.host.settings().activationMode === "click") return;
    const anchor = anchorFrom(document.elementFromPoint?.(this.x, this.y) ?? null);
    if (anchor) this.consider(anchor);
  }

  private consider(anchor: HTMLAnchorElement) {
    const settings = this.host.settingsFor(anchor);
    if (!settings) {
      if (anchor === this.current) {
        this.clearTimers();
        this.setCurrent(null);
      }
      return;
    }
    if (this.dismissed && this.dismissed.anchor === anchor && this.dismissed.url === anchor.href) return;
    this.dismissed = null;
    this.host.onReach(anchor);
    if (this.host.viewer.pinned && this.host.viewer.isOpen) return;
    if (this.host.isOpenAnchor(anchor)) return;
    const scrolledUnder = settings.ignoreScrollHover && this.lastScrollAt > this.lastPhysicalMoveAt;
    if (this.isCurrent(anchor)) {
      if (this.armTimer === undefined && !scrolledUnder && settings.activationMode !== "modifier") this.arm(anchor);
      this.armLinger(anchor);
      return;
    }
    this.clearTimers();
    this.setCurrent(anchor);
    if ((settings.activationMode === "modifier" && !this.alt) || scrolledUnder) return;
    this.arm(anchor);
    this.armLinger(anchor);
  }

  private arm(anchor: HTMLAnchorElement, delay = this.host.settings().hoverDelay) {
    this.clearTimer("armTimer");
    this.clearTimer("stillTimer");
    const settings = this.host.settings(), switching = this.host.viewer.isOpen && !this.host.isOpenAnchor(anchor);
    // On the way to the open preview: the link underneath is not a request to switch.
    if (switching && this.onPathToPreview()) return;
    if (switching) delay = Math.max(delay, settings.switchDelay);
    this.startX = this.x;
    this.startY = this.y;
    const url = anchor.href;
    this.armTimer = window.setTimeout(() => this.fire(anchor, url), delay);
    this.host.onArm(anchor, delay, this.x, this.y);
    if (!switching && settings.quickOpenWhenStill && delay >= 2 * STILL_MS) {
      this.stillTimer = window.setTimeout(() => this.checkStill(anchor, url), Math.max(STILL_MS, delay / 2));
    }
  }

  /** Opens early once the pointer rests on a link whose media is ready. */
  private checkStill(anchor: HTMLAnchorElement, url: string) {
    this.stillTimer = undefined;
    if (this.current !== anchor || anchor.href !== url || !this.host.isPrepared(url)) return;
    const restingFor = performance.now() - this.lastPhysicalMoveAt;
    if (restingFor >= STILL_MS) this.fire(anchor, url);
    else this.stillTimer = window.setTimeout(() => this.checkStill(anchor, url), STILL_MS - restingFor);
  }

  private armLinger(anchor: HTMLAnchorElement) {
    if (this.lingerTimer !== undefined) return;
    const url = anchor.href, delay = Math.min(LINGER_MAX_MS, this.host.settings().hoverDelay * 0.35);
    this.lingerTimer = window.setTimeout(() => {
      this.lingerTimer = undefined;
      if (this.current === anchor && anchor.href === url) this.host.onLinger(anchor);
    }, delay);
  }

  private fire(anchor: HTMLAnchorElement, url: string) {
    this.clearTimers();
    if (this.current === anchor && anchor.href === url) this.host.onActivate(anchor, this.x, this.y);
  }

  private clearTimer(name: "armTimer" | "stillTimer" | "rearmTimer" | "lingerTimer") {
    if (name === "armTimer" && this.armTimer !== undefined) this.host.onDisarm();
    clearTimeout(this[name]);
    this[name] = undefined;
  }

  clearTimers() {
    this.clearTimer("armTimer");
    this.clearTimer("stillTimer");
    this.clearTimer("rearmTimer");
    this.clearTimer("lingerTimer");
  }
}
