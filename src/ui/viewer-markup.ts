/** HTML for the viewer's parts. Pure functions of state, so rendering stays predictable. */
import {escapeHtml} from "../shared/dom";
import {linkLabel, type MediaItem, type ScanResult} from "../shared/media";
import type {LinkPeekSettings, ShortcutAction, Shortcuts} from "../shared/settings";
import {comboLabel} from "../shared/shortcuts";
import {RESIZE_EDGES} from "./panel-geometry";

export type View = "focus" | "grid";

/** "G", or "G / Shift+G" for two bindings; empty when the action has no key. */
export function keyHint(shortcuts: Shortcuts, action: ShortcutAction) {
  return shortcuts[action].slice(0, 2).map(comboLabel).join(" / ");
}

function withKey(label: string, shortcuts: Shortcuts, action: ShortcutAction) {
  const hint = keyHint(shortcuts, action);
  return hint ? `${label} (${hint})` : label;
}

function button(action: string, glyph: string, label: string, title: string, pressed?: boolean, extraClass = "", attributes = "") {
  const state = pressed === undefined ? "" : ` aria-pressed="${pressed}"`;
  return `<button type="button" class="lp-btn ${extraClass}" data-action="${action}" aria-label="${escapeHtml(label)}" title="${escapeHtml(title)}"${state}${attributes}>${glyph}</button>`;
}

export interface HeaderState {
  title: string;
  count?: number;
  view: View;
  expanded: boolean;
  pinned: boolean;
  favorite: boolean;
  slideshow: boolean;
  slideshowPaused: boolean;
  /** The preview floats in its own always-on-top window. */
  popped: boolean;
  help: boolean;
  settings: LinkPeekSettings;
}

/** While a slideshow runs the button pauses and resumes it; S itself stops it. */
function slideshowButton(state: HeaderState) {
  const keys = state.settings.shortcuts;
  if (!state.slideshow) return button("slideshow", "▶", "Start slideshow", withKey("Slideshow", keys, "slideshow"), false, "lp-slideshow");
  const label = state.slideshowPaused ? "Resume slideshow" : "Pause slideshow";
  return button("pause", state.slideshowPaused ? "▶" : "❚❚", label, withKey(label, keys, "pause"), true, "lp-slideshow");
}

export function headerMarkup(state: HeaderState) {
  const {settings, view} = state, keys = settings.shortcuts, quick = settings.quickViewControls;
  const density = quick && view === "grid"
    ? button("grid-smaller", "−", "Smaller thumbnails", "Smaller thumbnails", undefined, "lp-grid-more") + button("grid-bigger", "+", "Larger thumbnails", "Larger thumbnails", undefined, "lp-grid-bigger")
    : "";
  const grid = view === "grid"
    ? button("grid", "▣", "Back to single media", withKey("Single media", keys, "grid"), true, "lp-gridbtn")
    : button("grid", "▦", "Show all media as a grid", withKey("Grid", keys, "grid"), false, "lp-gridbtn");
  const expand = quick ? button("expand", state.expanded ? "↙" : "⛶", state.expanded ? "Restore size" : "Expand", withKey(state.expanded ? "Restore size" : "Expand", keys, "expand"), state.expanded, "lp-expandbtn") : "";
  return `<header class="lp-head">`
    + `<span class="lp-title" title="Drag to move · double-click to reset the layout">${escapeHtml(state.title)}</span>`
    + `<span class="lp-meta">${state.count ?? ""}</span>`
    + density + grid + expand
    + slideshowButton(state)
    + button("favorite", state.favorite ? "★" : "☆", state.favorite ? "Remove saved link" : "Save link", withKey(state.favorite ? "Remove saved link" : "Save link", keys, "favorite"), state.favorite, "lp-favorite")
    + button("help", "?", "Show controls", withKey("Controls", keys, "help"), undefined, "lp-helpbtn", ` aria-expanded="${state.help}"`)
    + button("popOut", state.popped ? "⇲" : "⇱", state.popped ? "Back into the page" : "Float above every window", withKey(state.popped ? "Back into the page" : "Float above every window", keys, "popOut"), state.popped, "lp-popout")
    + button("pin", "⌖", state.pinned ? "Unpin preview" : "Pin preview", withKey(state.pinned ? "Unpin preview" : "Pin preview", keys, "pin"), state.pinned, "lp-pin")
    + button("close", "×", "Close", withKey("Close", keys, "close"), undefined, "lp-close")
    + `</header>`;
}

export interface FooterState {
  result?: ScanResult;
  index: number;
  view: View;
  gridThumbSize: number;
  slideshow: boolean;
  slideshowPaused: boolean;
  settings: LinkPeekSettings;
}

export function progressText(result: ScanResult | undefined) {
  if (!result) return "Loading";
  const media = `${result.items.length} media`;
  if (result.complete) return `${media} · Complete`;
  return result.totalPosts ? `${media} · ${result.postsScanned ?? 0}/${result.totalPosts} posts` : `${media} · Scanning`;
}

export function countText(index: number, total: number) {
  return `${total ? index + 1 : 0} / ${total}`;
}

export function footerMarkup(state: FooterState) {
  const {result, settings} = state, keys = settings.shortcuts, total = result?.items.length ?? 0, item = result?.items[state.index];
  const nav = total
    ? button("previous", "↑", "Previous media", withKey("Previous", keys, "previous"), undefined, "lp-nav lp-previous")
      + `<span class="lp-count">${countText(state.index, total)}</span>`
      + button("next", "↓", "Next media", withKey("Next", keys, "next"), undefined, "lp-nav lp-next")
    : `<span class="lp-count">${countText(0, 0)}</span>`;
  const post = item?.postNumber ? `<button type="button" class="lp-post" data-action="post" title="Open this post">Post #${item.postNumber}${item.author ? ` · ${escapeHtml(item.author)}` : ""} ↗</button>` : "";
  const tiles = state.view === "grid" ? `<span class="lp-tiles">${Math.round(state.gridThumbSize)}px tiles</span>` : "";
  const actions = item
    ? button("open", "↗", "Open original", withKey("Open original", keys, "open"), undefined, "lp-action")
      + button("download", "⤓", "Download original", withKey("Download", keys, "download"), undefined, "lp-action")
      + button("copy", "⧉", "Copy media link", withKey("Copy link", keys, "copy"), undefined, "lp-action")
    : "";
  const status = !state.slideshow ? progressText(result) : state.slideshowPaused ? "Paused · Space to resume" : `Slideshow · ${settings.slideshowSeconds}s`;
  return `<footer class="lp-foot"><div class="lp-navgroup">${nav}</div>${post}${tiles}<span class="lp-spacer"></span>${actions}<span class="lp-signal">${escapeHtml(status)}</span></footer>`;
}

/** The media element for one item. Images that are already decoded get a slot the viewer fills in. */
export function mediaMarkup(item: MediaItem, settings: LinkPeekSettings, decoded: boolean, failed = false) {
  if (failed) {
    return `<div class="lp-media-error"><strong>This image did not load.</strong><span>The site may block previews or the file may be gone.</span><button type="button" class="lp-text-btn" data-action="open">Open original ↗</button></div>`;
  }
  if (item.type === "gif") return `<div class="lp-gif-mount"></div>`;
  if (item.type === "video") {
    const flags = [settings.videoAutoplay ? "autoplay" : "", settings.videoMuted ? "muted" : "", "loop", "playsinline", "controls"].filter(Boolean).join(" ");
    const poster = item.posterUrl ? ` poster="${escapeHtml(item.posterUrl)}"` : "";
    return `<video class="lp-image lp-video" src="${escapeHtml(item.originalUrl)}"${poster} preload="metadata" ${flags}></video>`;
  }
  if (decoded) return `<div class="lp-image-slot"></div>`;
  return `<img class="lp-image" src="${escapeHtml(item.previewUrl)}" alt="${escapeHtml(item.filename || "Preview image")}" decoding="async">`;
}

/**
 * Where an item came from, when that adds something to the header: the page or
 * post title (always in a shuffle, otherwise when it differs from the gallery's
 * own), the post number and the author.
 */
export function captionText(item: MediaItem | undefined, result: ScanResult | undefined) {
  if (!item || !result) return "";
  const elsewhere = result.mixed || item.sourceUrl !== result.url;
  const title = result.mixed || (elsewhere && item.sourceTitle !== result.title) ? item.sourceTitle || linkLabel(item.sourceUrl) : "";
  return [title, item.postNumber ? `Post #${item.postNumber}` : "", item.author ? `by ${item.author}` : ""].filter(Boolean).join(" · ");
}

export function tipText(item: MediaItem | undefined) {
  if (item?.type === "gif") return "Scroll to browse · Space to pause";
  if (item?.type === "video") return "Scroll to browse · click the video for its controls";
  return "Scroll to browse · Pinch to zoom";
}

export function stageMarkup(item: MediaItem, settings: LinkPeekSettings, decoded: boolean) {
  const tip = settings.showLearningTips ? `<div class="lp-tip">${tipText(item)}</div>` : "";
  return `<div class="lp-stage"><div class="lp-media">${mediaMarkup(item, settings, decoded)}</div>${tip}</div>`;
}

export function gridMarkup(result: ScanResult) {
  const scanning = result.complete ? "" : `<div class="lp-grid-progress"><span class="lp-loading-dot"></span><span>Still scanning · ${escapeHtml(progressText(result))}</span></div>`;
  return `${scanning}<div class="lp-grid" role="listbox" aria-label="All media"></div>`;
}

export const loadingMarkup = `<div class="lp-loading"><span class="lp-loading-dot"></span><span>Preparing media…</span></div>`;
export const emptyMarkup = `<div class="lp-empty"><strong>No posted media here.</strong><span>Images in page chrome (avatars, icons, logos) are skipped on purpose.</span></div>`;

export function errorMarkup(message: string) {
  return `<div class="lp-error"><strong>Preview unavailable</strong><span>${escapeHtml(message)}</span></div>`;
}

export function resizeHandles() {
  return RESIZE_EDGES.map(edge => `<span class="lp-resize lp-resize-${edge}" data-resize="${edge}" aria-hidden="true"></span>`).join("");
}

const HELP_GROUPS: Array<[string, Array<[ShortcutAction, string]>]> = [
  ["Browse", [["next", "Next media"], ["previous", "Previous media"], ["grid", "Grid / single media"], ["slideshow", "Slideshow (shuffle when on)"], ["pause", "Pause / resume the slideshow"]]],
  ["Links", [["nextLink", "Next link with media (skip empty pages)"], ["previousLink", "Previous link with media"], ["openPage", "Open the linked page"]]],
  ["This media", [["open", "Open original"], ["download", "Download original"], ["downloadAll", "Download the whole gallery (press twice)"], ["copy", "Copy media link"], ["favorite", "Save this link"]]],
  ["Zoom", [["fill", "Fill the panel / fit"], ["rotate", "Rotate"], ["zoomIn", "Zoom in"], ["zoomOut", "Zoom out"], ["resetZoom", "Reset zoom"]]],
  ["Panel", [["expand", "Expand / restore"], ["pin", "Pin open"], ["popOut", "Float above every window"], ["help", "These controls"], ["close", "Close"]]]
];

export function helpMarkup(shortcuts: Shortcuts, gif: boolean) {
  const rows = (pairs: Array<[string, string]>) => pairs.map(([key, label]) => `<kbd>${escapeHtml(key)}</kbd><span>${escapeHtml(label)}</span>`).join("");
  const gestures = rows([
    ["scroll ↕", "Previous / next media"], ["swipe ↔", "Fast scrub"], ["pinch", "Zoom at the pointer"],
    ["double-click", "Zoom here / fit"], ["double-click + drag", "Pan while zoomed"], ["mouse back / forward", "Previous / next media"],
    ["middle-click", "Original in a background tab"], ["drag title", "Move the panel"], ["drag an edge", "Resize the panel"]
  ]);
  const gifRows = gif ? `<h4>GIF</h4><div class="lp-help-grid">${rows([["Space", "Play / pause"], [", / .", "Previous / next frame"], ["[ / ]", "Slower / faster"], ["timeline scroll", "Scrub frames"]])}</div>` : "";
  const groups = HELP_GROUPS.map(([title, actions]) => {
    const bound = actions.filter(([action]) => shortcuts[action].length).map(([action, label]): [string, string] => [keyHint(shortcuts, action), label]);
    return bound.length ? `<h4>${title}</h4><div class="lp-help-grid">${rows(bound)}</div>` : "";
  }).join("");
  const inspector = shortcuts.preloadInspector[0];
  const inspectorRow = inspector ? `<h4>Preparation</h4><div class="lp-help-grid">${rows([[`${comboLabel(inspector)}, then ${comboLabel(inspector).split("+").pop()}`, "Preload inspector"]])}</div>` : "";
  return `<div class="lp-help" role="dialog" aria-label="One-hand controls">`
    + `<button type="button" class="lp-btn lp-help-close" data-action="help" aria-label="Close controls" title="Close controls">×</button>`
    + `<h3>One-hand controls</h3><h4>Touchpad and mouse</h4><div class="lp-help-grid">${gestures}</div>${gifRows}${groups}${inspectorRow}`
    + `<p class="lp-help-foot">Change any key in LinkPeek settings → Keyboard.</p></div>`;
}
