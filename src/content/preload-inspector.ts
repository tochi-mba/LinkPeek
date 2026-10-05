import {REX, rexCss} from "../shared/theme";
import {escapeHtml} from "../shared/dom";
import type {PreloadEntry, PreloadPriority, PreloadState} from "./link-prefetcher";

export interface PreloadInspectorHost {
  snapshot(): PreloadEntry[];
  setPriority(urls: Iterable<string>, priority: PreloadPriority): void;
  openUrl(url: string): void;
  subscribe(listener: () => void): () => void;
}

const GROUPS: Array<[PreloadState, string]> = [
  ["loading", "Loading"],
  ["queued", "Queued"],
  ["backoff", "Retry / backoff"],
  ["prepared", "Prepared"],
  ["not-started", "Not started"],
  ["blocked", "Blocked"]
];

const OUTLINE_STYLE = `
[data-linkpeek-preload-state="loading"]{outline:2px solid ${REX.live}!important;outline-offset:2px!important}
[data-linkpeek-preload-state="queued"]{outline:2px dashed ${REX.live}!important;outline-offset:2px!important}
[data-linkpeek-preload-state="backoff"]{outline:2px dotted ${REX.live}!important;outline-offset:2px!important}
[data-linkpeek-preload-state="prepared"]{outline:2px solid ${REX.signal}!important;outline-offset:2px!important}
[data-linkpeek-preload-state="not-started"]{outline:1px dashed ${REX.muted}!important;outline-offset:2px!important}
[data-linkpeek-preload-state="blocked"]{outline:1px dotted ${REX.muted}!important;outline-offset:2px!important}
[data-linkpeek-preload-priority="high"]{box-shadow:0 0 0 2px ${REX.signal}!important}
[data-linkpeek-preload-priority="maximum"]{box-shadow:0 0 0 3px ${REX.live}!important}
`;

function stateLabel(entry: PreloadEntry) {
  if (entry.state !== "backoff" || !entry.retryAt) return entry.state.replace("-", " ");
  const seconds = Math.max(0, Math.ceil((entry.retryAt - Date.now()) / 1000));
  return `backoff · ${seconds}s`;
}

function groupMarkup(state: PreloadState, title: string, entries: PreloadEntry[], selected: Set<string>) {
  const rows = entries.filter(entry => entry.state === state).map(entry => {
    const checked = selected.has(entry.url) ? " checked" : "";
    const priority = entry.priority === "normal" ? "" : ` · ${entry.priority}`;
    const subtitle = entry.title || entry.url;
    return `<div class="pi-row" data-state="${entry.state}" data-priority="${entry.priority}">
      <input type="checkbox" data-select="${escapeHtml(entry.url)}" aria-label="Select ${escapeHtml(entry.label)}"${checked}>
      <button type="button" class="pi-open" data-open="${escapeHtml(entry.url)}">
        <span class="pi-dot"></span><span class="pi-copy"><strong>${escapeHtml(entry.label)}</strong><small>${escapeHtml(subtitle)}</small></span>
        <span class="pi-state">${escapeHtml(stateLabel(entry))}${priority}</span>
      </button>
    </div>`;
  }).join("");
  return `<details class="pi-group" open><summary>${escapeHtml(title)} <span>${entries.filter(entry => entry.state === state).length}</span></summary>${rows || '<div class="pi-none">None</div>'}</details>`;
}

/** Live queue/debug UI for LinkPeek preloading. */
export class PreloadInspector {
  private root = document.createElement("div");
  private shadow = this.root.attachShadow({mode: "open"});
  private selected = new Set<string>();
  private unsubscribe?: () => void;
  private pageStyle?: HTMLStyleElement;

  constructor(private source: PreloadInspectorHost) {
    this.root.dataset.linkpeekInspector = "true";
    this.root.style.cssText = "position:fixed;left:12px;bottom:12px;z-index:2147483647;";
    this.shadow.addEventListener("click", event => this.onClick(event));
    this.shadow.addEventListener("change", event => this.onChange(event));
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
    this.unsubscribe = this.source.subscribe(() => this.render());
    this.render();
  }

  close() {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.root.remove();
    this.clearOutlines();
  }

  key(event: KeyboardEvent) {
    if (!this.isOpen || event.key !== "Escape") return false;
    this.close();
    return true;
  }

  private onChange(event: Event) {
    const input = event.target as HTMLInputElement;
    const url = input.dataset.select;
    if (!url) return;
    if (input.checked) this.selected.add(url);
    else this.selected.delete(url);
    this.render();
  }

  private onClick(event: Event) {
    const element = (event.target as Element).closest<HTMLElement>("[data-action],[data-open]");
    if (!element) return;
    const action = element.dataset.action;
    if (action === "close") {
      this.close();
      return;
    }
    if (action === "normal" || action === "high" || action === "maximum") {
      this.source.setPriority(this.selected, action);
      return;
    }
    const url = element.dataset.open;
    if (url) this.source.openUrl(url);
  }

  private render() {
    const entries = this.source.snapshot();
    const available = new Set(entries.map(entry => entry.url));
    for (const url of this.selected) if (!available.has(url)) this.selected.delete(url);
    const scrollTop = this.shadow.querySelector(".pi-list")?.scrollTop ?? 0;
    const collapsed = [...this.shadow.querySelectorAll<HTMLDetailsElement>(".pi-group")].map(group => !group.open);
    const focus = this.shadow.activeElement as HTMLElement | null;
    const focusKey = focus?.dataset.select ?? focus?.dataset.open ?? focus?.dataset.action;
    const counts = Object.fromEntries(GROUPS.map(([state]) => [state, entries.filter(entry => entry.state === state).length])) as Record<PreloadState, number>;
    const active = entries.find(entry => entry.state === "loading") ?? entries.find(entry => entry.state === "queued") ?? entries.find(entry => entry.state === "backoff");
    const selected = this.selected.size;
    this.shadow.innerHTML = `<style>
      ${rexCss}.pi{width:min(520px,calc(100vw - 24px));max-height:min(72vh,680px);overflow:hidden;display:flex;flex-direction:column;background:${REX.panel};color:${REX.text};border:1px solid ${REX.line};border-radius:14px;box-shadow:0 18px 60px ${REX.ink};font:13px/1.35 Inter,Segoe UI,system-ui,sans-serif}
      .pi-head{display:flex;gap:10px;align-items:flex-start;padding:12px 12px 9px;border-bottom:1px solid ${REX.line}}.pi-head b{font-size:14px}.pi-title{min-width:0;flex:1}.pi-title small{display:block;color:${REX.muted};white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:2px}.pi-close{border:0;background:${REX.raised};color:${REX.text};border-radius:8px;width:28px;height:28px;cursor:pointer}
      .pi-live{padding:8px 12px;background:${REX.raised};color:${REX.text};white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.pi-live strong{color:${REX.signal}}
      .pi-tools{display:flex;align-items:center;gap:6px;padding:8px 12px;border-bottom:1px solid ${REX.line}}.pi-tools span{margin-right:auto;color:${REX.muted}}.pi-tools button{border:1px solid ${REX.line};background:${REX.raised};color:${REX.text};border-radius:8px;padding:5px 8px;cursor:pointer}.pi-tools button:hover{background:${REX.raised}}
      .pi-list{overflow:auto;padding:6px}.pi-group{border-bottom:1px solid ${REX.line}}.pi-group summary{cursor:pointer;padding:8px;color:${REX.text};font-weight:600}.pi-group summary span{float:right;color:${REX.muted}}.pi-row{display:grid;grid-template-columns:24px 1fr;align-items:center;padding:3px 4px}.pi-row input{accent-color:${REX.signal}}.pi-open{width:100%;border:0;background:transparent;color:inherit;display:grid;grid-template-columns:10px minmax(0,1fr) auto;gap:8px;align-items:center;text-align:left;padding:7px;border-radius:8px;cursor:pointer}.pi-open:hover{background:${REX.raised}}.pi-dot{width:8px;height:8px;border-radius:50%;background:${REX.muted}}.pi-copy{min-width:0}.pi-copy strong,.pi-copy small{display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.pi-copy small{color:${REX.muted};font-size:11px;margin-top:2px}.pi-state{font-size:11px;color:${REX.muted}}.pi-none{color:${REX.muted};padding:4px 12px 10px}
      [data-state="prepared"] .pi-dot{background:${REX.signal}}[data-state="loading"] .pi-dot{background:${REX.live}}[data-state="queued"] .pi-dot{background:${REX.live}}[data-state="backoff"] .pi-dot{background:${REX.live}}[data-state="blocked"] .pi-dot{background:${REX.muted}}
      [data-priority="high"] .pi-state{color:${REX.signal}}[data-priority="maximum"] .pi-state{color:${REX.live}}
    </style>
    <section class="pi" role="dialog" aria-label="LinkPeek preload inspector">
      <header class="pi-head"><div class="pi-title"><b>Preload Inspector</b><small>${escapeHtml(document.title || location.href)}</small></div><button class="pi-close" data-action="close" aria-label="Close preload inspector">×</button></header>
      <div class="pi-live"><strong>${counts.loading}</strong> loading · ${counts.queued} queued · ${counts.prepared} prepared${active ? ` · active: ${escapeHtml(active.title || active.label)}` : ""}</div>
      <div class="pi-tools"><span>${selected} selected</span><button data-action="normal">Normal</button><button data-action="high">High</button><button data-action="maximum">Maximum</button></div>
      <div class="pi-list">${GROUPS.map(([state, title]) => groupMarkup(state, title, entries, this.selected)).join("")}</div>
    </section>`;
    this.shadow.querySelector(".pi-list")!.scrollTop = scrollTop;
    this.shadow.querySelectorAll<HTMLDetailsElement>(".pi-group").forEach((group, index) => { group.open = !collapsed[index]; });
    if (focusKey) {
      [...this.shadow.querySelectorAll<HTMLElement>("[data-select],[data-open],[data-action]")]
        .find(element => (element.dataset.select ?? element.dataset.open ?? element.dataset.action) === focusKey)?.focus({preventScroll: true});
    }
    this.applyOutlines(entries);
  }

  private applyOutlines(entries: PreloadEntry[]) {
    if (!this.pageStyle) {
      this.pageStyle = document.createElement("style");
      this.pageStyle.dataset.linkpeekInspectorStyle = "true";
      this.pageStyle.textContent = OUTLINE_STYLE;
      document.documentElement.append(this.pageStyle);
    }
    const byUrl = new Map(entries.map(entry => [entry.url, entry]));
    for (const anchor of document.querySelectorAll<HTMLAnchorElement>("a[href]")) {
      const entry = byUrl.get(anchor.href);
      if (!entry) {
        delete anchor.dataset.linkpeekPreloadState;
        delete anchor.dataset.linkpeekPreloadPriority;
        continue;
      }
      anchor.dataset.linkpeekPreloadState = entry.state;
      anchor.dataset.linkpeekPreloadPriority = entry.priority;
    }
  }

  private clearOutlines() {
    this.pageStyle?.remove();
    this.pageStyle = undefined;
    for (const anchor of document.querySelectorAll<HTMLAnchorElement>("[data-linkpeek-preload-state]")) {
      delete anchor.dataset.linkpeekPreloadState;
      delete anchor.dataset.linkpeekPreloadPriority;
    }
  }
}
