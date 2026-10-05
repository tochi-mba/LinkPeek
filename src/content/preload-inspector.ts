/**
 * The preload inspector: colour-coded outlines on every link on the page, and
 * an accordion in the bottom-left corner listing links by preparation state.
 *
 * It costs nothing while closed. While open, updates are coalesced to at most
 * a few per second, only open accordion groups render rows, and a link's
 * outline is touched only when its state actually changes.
 */
import {escapeHtml} from "../shared/dom";
import {REX, rexCss} from "../shared/theme";
import type {PreloadEntry, PreloadPriority, PreloadState} from "./link-prefetcher";

export interface PreloadInspectorHost {
  snapshot(): PreloadEntry[];
  setPriority(urls: Iterable<string>, priority: PreloadPriority): void;
  openUrl(url: string): void;
  subscribe(listener: () => void): () => void;
}

export const INSPECTOR_GROUPS: ReadonlyArray<[PreloadState, string]> = [
  ["loading", "Loading"],
  ["queued", "Queued"],
  ["prepared", "Prepared"],
  ["backoff", "Waiting to retry"],
  ["not-started", "Not started"],
  ["blocked", "Not previewable"]
];

/** Fewest milliseconds between two redraws while preparation is busy. */
const MIN_REDRAW_MS = 200;
/** Rows shown per open group; the rest are counted. */
const MAX_ROWS = 150;
const STATE_ATTR = "linkpeekPreloadState";
const PRIORITY_ATTR = "linkpeekPreloadPriority";

/** Outlines the inspector puts on the page's own links, keyed by state and priority. */
const PAGE_OUTLINES = `
[data-linkpeek-preload-state="loading"]{outline:2px solid ${REX.live}!important;outline-offset:2px!important}
[data-linkpeek-preload-state="queued"]{outline:2px dashed ${REX.live}!important;outline-offset:2px!important}
[data-linkpeek-preload-state="backoff"]{outline:2px dotted ${REX.live}!important;outline-offset:2px!important}
[data-linkpeek-preload-state="prepared"]{outline:2px solid ${REX.signal}!important;outline-offset:2px!important}
[data-linkpeek-preload-state="not-started"]{outline:1px dashed ${REX.muted}!important;outline-offset:2px!important}
[data-linkpeek-preload-state="blocked"]{outline:1px dotted rgba(133,141,131,.45)!important;outline-offset:2px!important}
[data-linkpeek-preload-priority="high"]{box-shadow:0 0 0 2px ${REX.signal}!important}
[data-linkpeek-preload-priority="maximum"]{box-shadow:0 0 0 3px ${REX.live}!important}
`;

const PANEL_CSS = `${rexCss}
.pi{width:min(440px,calc(100vw - 24px));max-height:min(70vh,640px);display:flex;flex-direction:column;overflow:hidden;
  background:${REX.panel};color:${REX.text};border:1px solid ${REX.line};border-radius:14px;box-shadow:0 18px 60px rgba(0,0,0,.55);font:13px/1.35 Inter,"Segoe UI",system-ui,sans-serif}
.pi.min{width:auto}
.pi-head{display:flex;align-items:center;gap:8px;padding:8px 8px 8px 12px;border-bottom:1px solid ${REX.line}}
.pi.min .pi-head{border-bottom:0}
.pi-brand{font-size:9px;letter-spacing:.14em;font-weight:800;color:${REX.signal};text-transform:uppercase}
.pi-sum{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:${REX.muted};font:700 11px ui-monospace,monospace}
.pi-sum b{color:${REX.text}}
.pi-btn{border:1px solid ${REX.line};background:${REX.raised};color:${REX.text};border-radius:8px;height:28px;min-width:28px;padding:0 8px;cursor:pointer}
.pi-btn:hover{border-color:${REX.signal};color:${REX.signal}}
.pi-tools{display:flex;align-items:center;gap:6px;padding:8px 12px;border-bottom:1px solid ${REX.line}}
.pi-tools span{margin-right:auto;color:${REX.muted};font-size:12px}
.pi-tools .pi-btn:disabled{opacity:.4;cursor:default}
.pi-list{overflow:auto;padding:4px 6px 6px}
.pi-group{border-bottom:1px solid ${REX.line}}
.pi-group:last-child{border-bottom:0}
.pi-group summary{display:flex;align-items:center;gap:8px;cursor:pointer;padding:9px 6px;font-weight:600;list-style:none}
.pi-group summary::-webkit-details-marker{display:none}
.pi-group summary::before{content:"›";color:${REX.muted};transition:transform .12s ease}
.pi-group[open] summary::before{transform:rotate(90deg)}
.pi-group summary .pi-count{margin-left:auto;color:${REX.muted};font:700 11px ui-monospace,monospace}
.pi-key{width:14px;height:10px;border-radius:3px;flex:none}
.pi-row{display:grid;grid-template-columns:22px 1fr;align-items:center;padding:2px 2px}
.pi-row input{accent-color:${REX.signal}}
.pi-open{width:100%;display:grid;grid-template-columns:minmax(0,1fr) auto;gap:8px;align-items:center;text-align:left;padding:6px;border:0;border-radius:8px;background:transparent;color:inherit;cursor:pointer}
.pi-open:hover{background:${REX.raised}}
.pi-open strong,.pi-open small{display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.pi-gif{display:inline-grid;place-items:center;width:14px;height:14px;margin-left:5px;border-radius:4px;background:${REX.signal};color:${REX.panel};font:800 8px/1 system-ui,sans-serif;vertical-align:1px}
.pi-page-gif{position:fixed;display:grid;place-items:center;width:18px;height:18px;box-sizing:border-box;border:2px solid ${REX.panel};border-radius:5px;
  background:${REX.signal};color:${REX.panel};box-shadow:0 2px 8px rgba(0,0,0,.45);font:900 9px/1 system-ui,sans-serif;
  transform:translate(-50%,-50%);pointer-events:none;z-index:2147483647}
.pi-open small{color:${REX.muted};font-size:11px;margin-top:2px}
.pi-state{font-size:11px;color:${REX.muted};white-space:nowrap}
.pi-tag{margin-left:6px;padding:1px 5px;border:1px solid ${REX.line};border-radius:999px;color:${REX.muted};font:700 9px ui-monospace,monospace;font-style:normal;letter-spacing:.06em;text-transform:uppercase;vertical-align:1px}
.pi-more,.pi-none{color:${REX.muted};padding:4px 8px 10px;font-size:12px}
[data-priority="high"] .pi-state{color:${REX.signal}}
[data-priority="maximum"] .pi-state{color:${REX.live}}
`;

/** The legend swatch for each state matches the outline it puts on the page. */
const SWATCH: Record<PreloadState, string> = {
  loading: `border:2px solid ${REX.live}`,
  queued: `border:2px dashed ${REX.live}`,
  backoff: `border:2px dotted ${REX.live}`,
  prepared: `border:2px solid ${REX.signal}`,
  "not-started": `border:1px dashed ${REX.muted}`,
  blocked: "border:1px dotted rgba(133,141,131,.6)"
};

function stateLabel(entry: PreloadEntry, now: number) {
  if (entry.state === "backoff" && entry.retryAt) return `retry in ${Math.max(0, Math.ceil((entry.retryAt - now) / 1000))}s`;
  return entry.state.replace("-", " ");
}

export class PreloadInspector {
  private root = document.createElement("div");
  private shadow = this.root.attachShadow({mode: "open"});
  private selected = new Set<string>();
  private openGroups = new Set<PreloadState>(["loading", "queued", "prepared"]);
  private minimized = false;
  private unsubscribe?: () => void;
  private pageStyle?: HTMLStyleElement;
  private outlined = new Set<HTMLAnchorElement>();
  private signature = "";
  private timer: number | undefined;
  private frame = 0;
  private badgeFrame = 0;
  private lastDraw = 0;
  private lastEntries: PreloadEntry[] = [];

  constructor(private source: PreloadInspectorHost) {
    this.root.dataset.linkpeekInspector = "true";
    this.root.style.cssText = "position:fixed;left:12px;bottom:12px;z-index:2147483647;";
    this.shadow.addEventListener("click", event => this.onClick(event));
    this.shadow.addEventListener("change", event => this.onChange(event));
    this.shadow.addEventListener("toggle", event => this.onToggle(event), true);
  }

  /** The inspector's host element, so clicks inside it are not "outside the preview". */
  get host() {
    return this.root;
  }

  get isOpen() {
    return this.root.isConnected;
  }

  toggle() {
    if (this.isOpen) this.close();
    else this.open();
  }

  open() {
    if (this.isOpen) return;
    document.documentElement.append(this.root);
    this.pageStyle = Object.assign(document.createElement("style"), {textContent: PAGE_OUTLINES});
    this.pageStyle.dataset.linkpeekInspectorStyle = "true";
    document.documentElement.append(this.pageStyle);
    this.unsubscribe = this.source.subscribe(() => this.requestDraw());
    window.addEventListener("scroll", this.onViewport, true);
    window.addEventListener("resize", this.onViewport);
    this.draw();
  }

  close() {
    if (!this.isOpen) return;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    clearTimeout(this.timer);
    cancelAnimationFrame(this.frame);
    cancelAnimationFrame(this.badgeFrame);
    window.removeEventListener("scroll", this.onViewport, true);
    window.removeEventListener("resize", this.onViewport);
    this.timer = undefined;
    this.frame = 0;
    this.badgeFrame = 0;
    this.lastEntries = [];
    this.root.remove();
    this.pageStyle?.remove();
    this.pageStyle = undefined;
    for (const anchor of this.outlined) {
      delete anchor.dataset[STATE_ATTR];
      delete anchor.dataset[PRIORITY_ATTR];
    }
    this.outlined.clear();
    this.signature = "";
  }

  /** Escape closes the inspector before anything else sees the key. */
  key(event: KeyboardEvent) {
    if (!this.isOpen || event.key !== "Escape") return false;
    this.close();
    return true;
  }

  /** Keeps shadow-root GIF badges pinned to links while the page scrolls or resizes. */
  private onViewport = () => {
    if (!this.isOpen || this.badgeFrame) return;
    this.badgeFrame = requestAnimationFrame(() => {
      this.badgeFrame = 0;
      this.renderPageGifBadges(this.lastEntries);
    });
  };

  /** Coalesces bursts of changes into one redraw per frame, at most every MIN_REDRAW_MS. */
  private requestDraw() {
    if (this.timer !== undefined || this.frame) return;
    const wait = Math.max(0, this.lastDraw + MIN_REDRAW_MS - performance.now());
    this.timer = window.setTimeout(() => {
      this.timer = undefined;
      this.frame = requestAnimationFrame(() => {
        this.frame = 0;
        this.draw();
      });
    }, wait);
  }

  private onToggle(event: Event) {
    const group = event.target as HTMLDetailsElement;
    const state = group.dataset.group as PreloadState;
    if (group.open === this.openGroups.has(state)) return;
    if (group.open) this.openGroups.add(state);
    else this.openGroups.delete(state);
    this.draw(true);
  }

  private onChange(event: Event) {
    const input = event.target as HTMLInputElement, url = input.dataset.select!;
    if (input.checked) this.selected.add(url);
    else this.selected.delete(url);
    this.draw(true);
  }

  private onClick(event: Event) {
    const element = (event.target as Element).closest<HTMLElement>("[data-action],[data-open]");
    if (!element) return;
    const action = element.dataset.action;
    if (action === "close") return this.close();
    if (action === "minimize") {
      this.minimized = !this.minimized;
      return this.draw(true);
    }
    if (action === "normal" || action === "high" || action === "maximum") {
      this.source.setPriority([...this.selected], action);
      this.selected.clear();
      return this.draw(true);
    }
    if (element.dataset.open) this.source.openUrl(element.dataset.open);
  }

  /** Rebuilds the panel and updates outlines; skipped when nothing visible changed, unless forced. */
  private draw(force = false) {
    this.lastDraw = performance.now();
    const entries = this.source.snapshot(), now = Date.now();
    this.lastEntries = entries;
    const urls = new Set(entries.map(entry => entry.url));
    for (const url of this.selected) if (!urls.has(url)) this.selected.delete(url);
    this.updateOutlines(entries);
    // URLs cannot contain spaces or newlines, so these separators are unambiguous.
    const signature = entries.map(entry => `${entry.url} ${entry.state} ${entry.priority} ${entry.hasGif ? "gif" : ""}`).join("\n");
    if (!force && signature === this.signature) {
      this.renderPageGifBadges(entries);
      return;
    }
    this.signature = signature;
    const byState = new Map<PreloadState, PreloadEntry[]>(INSPECTOR_GROUPS.map(([state]) => [state, []]));
    for (const entry of entries) byState.get(entry.state)!.push(entry);
    const count = (state: PreloadState) => byState.get(state)!.length;
    const summary = `<b>${count("prepared")}</b> ready · <b>${count("loading")}</b> loading · <b>${count("queued")}</b> queued`;
    const list = this.shadow.querySelector(".pi-list"), scroll = list?.scrollTop ?? 0;
    const groups = INSPECTOR_GROUPS.map(([state, title]) => this.groupMarkup(state, title, byState.get(state)!, now)).join("");
    const tools = `<div class="pi-tools"><span>${this.selected.size} selected</span>`
      + ["normal", "high", "maximum"].map(priority => `<button type="button" class="pi-btn" data-action="${priority}" ${this.selected.size ? "" : "disabled"}>${priority[0].toUpperCase()}${priority.slice(1)}</button>`).join("")
      + `</div>`;
    this.shadow.innerHTML = `<style>${PANEL_CSS}</style><section class="pi${this.minimized ? " min" : ""}" role="dialog" aria-label="LinkPeek preload inspector">`
      + `<header class="pi-head"><span class="pi-brand">Preload</span><span class="pi-sum">${summary}</span>`
      + `<button type="button" class="pi-btn" data-action="minimize" aria-label="${this.minimized ? "Expand" : "Collapse"} inspector">${this.minimized ? "▴" : "▾"}</button>`
      + `<button type="button" class="pi-btn" data-action="close" aria-label="Close preload inspector">×</button></header>`
      + (this.minimized ? "" : `${tools}<div class="pi-list">${groups}</div>`)
      + `</section>`;
    const fresh = this.shadow.querySelector(".pi-list");
    if (fresh) fresh.scrollTop = scroll;
    this.renderPageGifBadges(entries);
  }

  /** Real shadow-root badges cannot be hidden or restyled by the host page. */
  private renderPageGifBadges(entries: PreloadEntry[]) {
    this.shadow.querySelectorAll(".pi-page-gif").forEach(badge => badge.remove());
    const gifs = new Set(entries.filter(entry => entry.hasGif).map(entry => entry.url));
    if (!gifs.size) return;
    for (const anchor of document.querySelectorAll<HTMLAnchorElement>("a[href]")) {
      if (!gifs.has(anchor.href)) continue;
      const rect = anchor.getClientRects()[0] ?? anchor.getBoundingClientRect();
      if (!rect || (rect.width <= 0 && rect.height <= 0) || rect.bottom < 0 || rect.top > innerHeight || rect.right < 0 || rect.left > innerWidth) continue;
      const badge = document.createElement("i");
      badge.className = "pi-page-gif";
      badge.textContent = "▶";
      badge.title = "Contains GIF";
      badge.setAttribute("aria-label", "Contains GIF");
      const left = Math.max(9, Math.min(innerWidth - 9, rect.right + 8));
      const top = Math.max(9, Math.min(innerHeight - 9, rect.top + Math.min(9, Math.max(5, rect.height / 2))));
      badge.style.left = `${Math.round(left)}px`;
      badge.style.top = `${Math.round(top)}px`;
      this.shadow.append(badge);
    }
  }

  private groupMarkup(state: PreloadState, title: string, entries: PreloadEntry[], now: number) {
    const open = this.openGroups.has(state);
    const rows = open ? entries.slice(0, MAX_ROWS).map(entry => {
      const priority = entry.priority === "normal" ? "" : ` · ${entry.priority}`;
      return `<div class="pi-row" data-priority="${entry.priority}">`
        + `<input type="checkbox" data-select="${escapeHtml(entry.url)}" aria-label="Select ${escapeHtml(entry.label)}"${this.selected.has(entry.url) ? " checked" : ""}>`
        + `<button type="button" class="pi-open" data-open="${escapeHtml(entry.url)}" title="Preview ${escapeHtml(entry.url)}">`
        + `<span><strong>${escapeHtml(entry.label)}${entry.hasGif ? '<i class="pi-gif" aria-label="Contains GIF" title="Contains GIF">▶</i>' : ""}${entry.source === "linked" ? '<em class="pi-tag">linked page</em>' : ""}</strong><small>${escapeHtml(entry.title || entry.url)}</small></span>`
        + `<span class="pi-state">${escapeHtml(stateLabel(entry, now))}${priority}</span></button></div>`;
    }).join("") : "";
    const more = open && entries.length > MAX_ROWS ? `<div class="pi-more">and ${entries.length - MAX_ROWS} more</div>` : "";
    const none = open && !entries.length ? `<div class="pi-none">None</div>` : "";
    return `<details class="pi-group" data-group="${state}"${open ? " open" : ""}><summary><span class="pi-key" style="${SWATCH[state]}"></span>${title}<span class="pi-count">${entries.length}</span></summary>${rows}${more}${none}</details>`;
  }

  /** Writes outline attributes only where they differ, so the page restyles as little as possible. */
  private updateOutlines(entries: PreloadEntry[]) {
    const byUrl = new Map(entries.map(entry => [entry.url, entry]));
    const current = new Set<HTMLAnchorElement>();
    for (const anchor of document.querySelectorAll<HTMLAnchorElement>("a[href]")) {
      const entry = byUrl.get(anchor.href);
      if (!entry) continue;
      current.add(anchor);
      if (anchor.dataset[STATE_ATTR] !== entry.state) anchor.dataset[STATE_ATTR] = entry.state;
      if (entry.priority === "normal") {
        if (PRIORITY_ATTR in anchor.dataset) delete anchor.dataset[PRIORITY_ATTR];
      } else if (anchor.dataset[PRIORITY_ATTR] !== entry.priority) {
        anchor.dataset[PRIORITY_ATTR] = entry.priority;
      }
    }
    for (const anchor of this.outlined) {
      if (current.has(anchor)) continue;
      delete anchor.dataset[STATE_ATTR];
      delete anchor.dataset[PRIORITY_ATTR];
    }
    this.outlined = current;
  }
}
