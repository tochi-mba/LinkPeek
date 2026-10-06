/**
 * The library page, in two views:
 *
 * - Seen: everything LinkPeek has shown, newest first, grouped by day.
 * - Saved on this device: every file kept, from links prepared in the
 *   background as well as from what was shown, filterable to what you have
 *   not seen yet (the preloaded media) or have.
 *
 * Thumbnails come from the saved copies when there are any, so the page works
 * offline; the list grows as you scroll and search filters it. Clicking an item
 * opens it full size (arrows, scroll or the mouse's side buttons move through,
 * Escape closes). "Save all to Downloads" writes the saved files of the current
 * view into a LinkPeek Library folder, named by when they were seen or saved.
 */
import {escapeHtml} from "../shared/dom";
import {LIBRARY_CACHE, readHistory, readLibrary, savedUrlOf, type HistoryEntry, type LibraryEntry} from "../shared/history";
import {linkLabel, safeDownloadName, type MediaItem} from "../shared/media";

/** Entries rendered per step as the list scrolls. */
const PAGE = 240;
const CONFIRM_MS = 3000;
const WHEEL_STEP_MS = 220;

type View = "seen" | "saved";
type Filter = "all" | "unseen" | "seen";

/** One item on the page, whichever view it came from. */
export interface Row {
  at: number;
  type: MediaItem["type"];
  title?: string;
  /** Page or post it came from. */
  source: string;
  /** Opened on the web. */
  open: string;
  /** Its file in the library, if kept. */
  saved: string;
  /** Still for the grid ("" when there is none). */
  thumb: string;
  seen: boolean;
}

export function rowFromHistory(entry: HistoryEntry): Row {
  return {at: entry.a, type: entry.t, title: entry.n, source: entry.s, open: entry.o, saved: savedUrlOf(entry), thumb: entry.p, seen: true};
}

export function rowFromLibrary([url, entry]: [string, LibraryEntry]): Row {
  const type = entry.type ?? (/\.gif(?:$|[?#])/i.test(url) ? "gif" : "image");
  return {
    at: entry.at, type, title: entry.title, source: entry.source ?? url, open: entry.original ?? url, saved: url,
    thumb: type === "image" ? url : entry.preview ?? "", seen: entry.seen !== false
  };
}

const $ = (id: string) => document.getElementById(id)!;
let view: View = "seen";
let filter: Filter = "all";
let seenRows: Row[] = [];
let savedRows: Row[] = [];
let shown: Row[] = [];
let rendered = 0;
let viewing = -1;
let lastWheel = 0;
/** Object URLs of saved copies already read, so each file is read from the cache once. */
const local = new Map<string, string>();
let cache: Promise<Cache | undefined> | undefined;

function openCache() {
  cache ??= (typeof caches === "undefined" ? Promise.resolve(undefined) : caches.open(LIBRARY_CACHE).catch(() => undefined));
  return cache;
}

/** The saved copy of a file as an object URL, or undefined when none is kept. */
async function savedCopy(url: string) {
  if (local.has(url)) return local.get(url);
  const hit = await (await openCache())?.match(url);
  if (!hit) return undefined;
  const objectUrl = URL.createObjectURL(await hit.blob());
  local.set(url, objectUrl);
  return objectUrl;
}

function dayLabel(at: number, now = new Date()) {
  const day = new Date(at), today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const start = new Date(day.getFullYear(), day.getMonth(), day.getDate()).getTime();
  if (start === today) return "Today";
  if (start === today - 86_400_000) return "Yesterday";
  return day.toLocaleDateString(undefined, {weekday: "long", day: "numeric", month: "long", year: day.getFullYear() === now.getFullYear() ? undefined : "numeric"});
}

function tile(row: Row, index: number) {
  const title = row.title || linkLabel(row.source);
  const badges = (row.type === "image" ? "" : `<span class="h-badge">${row.type === "gif" ? "GIF" : "▶"}</span>`) + (view === "saved" && !row.seen ? `<span class="h-new">Not seen yet</span>` : "");
  const picture = row.thumb ? `<img data-src="${escapeHtml(row.thumb)}" alt="" decoding="async">` : `<span class="h-none">${row.type === "video" ? "Video" : "No preview"}</span>`;
  return `<figure class="h-tile"><a class="h-media" href="${escapeHtml(row.open)}" target="_blank" rel="noopener" data-index="${index}" title="Open">${picture}${badges}</a>`
    + `<figcaption><a href="${escapeHtml(row.source)}" target="_blank" rel="noopener" title="${escapeHtml(row.source)}">${escapeHtml(title)}</a>`
    + `<time datetime="${new Date(row.at).toISOString()}">${new Date(row.at).toLocaleTimeString(undefined, {hour: "2-digit", minute: "2-digit"})}</time></figcaption></figure>`;
}

/** Shows each new thumbnail (still holding data-src) from its saved copy when there is one, else from the web. */
async function fillThumbnails() {
  for (const image of document.querySelectorAll<HTMLImageElement>("img[data-src]")) {
    const row = shown[Number(image.closest<HTMLElement>("[data-index]")!.dataset.index)], network = image.dataset.src!;
    image.removeAttribute("data-src");
    // A picture's saved copy is its thumbnail; a GIF's or video's is the original, too heavy for a tile.
    image.src = (row.type === "image" ? await savedCopy(row.saved) : undefined) ?? network;
  }
}

/** Renders the next page of rows, starting a new day heading where the day changes. */
function renderMore() {
  const days = $("days"), start = rendered, next = shown.slice(rendered, rendered + PAGE);
  let grid = days.lastElementChild?.querySelector(".h-grid") ?? null, lastDay = days.lastElementChild?.getAttribute("data-day") ?? "";
  const pieces: string[] = [];
  next.forEach((row, offset) => {
    const label = dayLabel(row.at);
    if (label !== lastDay) {
      // A heading always exists before any tile, so a pending run belongs to the grid being left.
      if (pieces.length) grid!.insertAdjacentHTML("beforeend", pieces.splice(0).join(""));
      days.insertAdjacentHTML("beforeend", `<section class="h-day" data-day="${escapeHtml(label)}"><h2>${escapeHtml(label)}</h2><div class="h-grid"></div></section>`);
      grid = days.lastElementChild!.querySelector(".h-grid");
      lastDay = label;
    }
    pieces.push(tile(row, start + offset));
  });
  if (pieces.length) grid!.insertAdjacentHTML("beforeend", pieces.join(""));
  rendered += next.length;
  return fillThumbnails();
}

/** The rows of the current view and filter, before searching. */
function current() {
  if (view === "seen") return seenRows;
  return filter === "all" ? savedRows : savedRows.filter(row => row.seen === (filter === "seen"));
}

function summary() {
  const base = current(), query = ($("search") as HTMLInputElement).value.trim();
  if (!base.length) {
    if (view === "seen") return "Nothing here yet. What you open in LinkPeek appears here, newest first.";
    return filter === "unseen" ? "Nothing preloaded is waiting: everything saved has been seen." : "Nothing is saved on this device yet. Prepared and shown media is saved here as LinkPeek works.";
  }
  if (query) return `${shown.length.toLocaleString()} of ${base.length.toLocaleString()} match “${query}”`;
  const noun = view === "seen" ? "item" : "file";
  return `${base.length.toLocaleString()} ${noun}${base.length === 1 ? "" : "s"}, newest first`;
}

/** Shows the right buttons as active for the current view and filter. */
function paintControls() {
  for (const button of document.querySelectorAll<HTMLElement>("[data-show]")) button.setAttribute("aria-pressed", String(button.dataset.show === view));
  for (const button of document.querySelectorAll<HTMLElement>("[data-filter]")) button.setAttribute("aria-pressed", String(button.dataset.filter === filter));
  $("filters").hidden = view !== "saved";
  $("clear").textContent = view === "seen" ? "Clear history" : "Delete saved media";
}

function apply() {
  const words = ($("search") as HTMLInputElement).value.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const base = current();
  shown = words.length ? base.filter(row => {
    const text = `${row.title ?? ""} ${row.source} ${row.open}`.toLowerCase();
    return words.every(word => text.includes(word));
  }) : base;
  rendered = 0;
  paintControls();
  $("days").replaceChildren();
  $("summary").textContent = summary();
  return renderMore();
}

/** A button that asks for a second press within a few seconds; only the second one acts. */
class TwoStep {
  private until = 0;

  constructor(private button: HTMLElement, private idle: () => string) {}

  confirm(ask: string) {
    if (Date.now() <= this.until) {
      this.until = 0;
      this.button.textContent = this.idle();
      return true;
    }
    const until = this.until = Date.now() + CONFIRM_MS;
    this.button.textContent = ask;
    setTimeout(() => {
      if (this.until !== until) return;
      this.until = 0;
      this.button.textContent = this.idle();
    }, CONFIRM_MS);
    return false;
  }
}

let clearStep: TwoStep, saveStep: TwoStep;

/** Clears the history, or deletes the saved files, depending on the view. */
async function clearView() {
  if (view === "seen") {
    if (!clearStep.confirm("Press again to clear")) return;
    await chrome.runtime.sendMessage({type: "LINKPEEK_HISTORY_CLEAR"});
    seenRows = [];
  } else {
    if (!clearStep.confirm("Press again to delete")) return;
    await chrome.runtime.sendMessage({type: "LINKPEEK_LIBRARY_CLEAR"});
    savedRows = [];
  }
  await apply();
}

/** The file name a saved item gets in Downloads: when it was seen or saved, then its own name, so the folder sorts in order. */
function fileName(row: Row) {
  const at = new Date(row.at), pad = (value: number) => String(value).padStart(2, "0");
  const day = `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
  return `LinkPeek Library/${day}/${pad(at.getHours())}.${pad(at.getMinutes())}.${pad(at.getSeconds())} ${safeDownloadName({originalUrl: row.saved})}`;
}

async function saveAll() {
  const saved = (await Promise.all(shown.map(async row => ({row, url: await savedCopy(row.saved)})))).filter(item => item.url);
  if (!saved.length) {
    $("summary").textContent = "Nothing here is saved on this device yet. Turn on Settings → Privacy → Save what you see.";
    return;
  }
  if (!saveStep.confirm(`Press again to save ${saved.length.toLocaleString()} files`)) return;
  let done = 0;
  for (const {row, url} of saved) {
    await chrome.downloads.download({url: url!, filename: fileName(row), conflictAction: "uniquify", saveAs: false}).catch(() => undefined);
    $("summary").textContent = `Saving to Downloads / LinkPeek Library… ${++done} of ${saved.length}`;
  }
  $("summary").textContent = `Saved ${saved.length.toLocaleString()} files to Downloads / LinkPeek Library`;
}

// ---- The full-size viewer ----

async function showItem(index: number) {
  viewing = (index + shown.length) % shown.length;
  const row = shown[viewing], copy = await savedCopy(row.saved);
  if (shown[viewing] !== row) return;
  // The saved copy works offline; without one, the original from the web.
  const source = copy ?? row.open, stage = $("viewStage");
  stage.innerHTML = row.type === "video"
    ? `<video src="${escapeHtml(source)}" controls autoplay loop playsinline></video>`
    : `<img src="${escapeHtml(source)}" alt="">`;
  const title = $("viewTitle") as HTMLAnchorElement;
  title.textContent = row.title || linkLabel(row.source);
  title.href = row.source;
  ($("viewOriginal") as HTMLAnchorElement).href = row.open;
  $("viewMeta").textContent = `${viewing + 1} of ${shown.length} · ${new Date(row.at).toLocaleString()}${copy ? " · saved on this device" : ""}`;
}

function openViewer(index: number) {
  $("view").hidden = false;
  void showItem(index);
}

function closeViewer() {
  $("view").hidden = true;
  $("viewStage").replaceChildren();
  viewing = -1;
}

function step(delta: number) {
  if (viewing >= 0) void showItem(viewing + delta);
}

async function saveViewed() {
  const row = shown[viewing];
  await chrome.downloads.download({url: await savedCopy(row.saved) ?? row.open, filename: fileName(row), conflictAction: "uniquify", saveAs: false}).catch(() => undefined);
}

function onKey(event: KeyboardEvent) {
  if (viewing < 0) return;
  const moves: Record<string, number> = {ArrowRight: 1, ArrowDown: 1, " ": 1, ArrowLeft: -1, ArrowUp: -1};
  if (event.key === "Escape") closeViewer();
  else if (event.key in moves) step(moves[event.key]);
  else return;
  event.preventDefault();
}

function onWheel(event: WheelEvent) {
  if (viewing < 0) return;
  event.preventDefault();
  if (Date.now() - lastWheel < WHEEL_STEP_MS || !event.deltaY) return;
  lastWheel = Date.now();
  step(event.deltaY > 0 ? 1 : -1);
}

/** The view and filter in the address, so the popup and the inspector can open "what was preloaded" directly. */
function readAddress() {
  const params = new URLSearchParams(location.search);
  view = params.get("view") === "saved" ? "saved" : "seen";
  const wanted = params.get("filter");
  filter = wanted === "unseen" || wanted === "seen" ? wanted : "all";
}

function writeAddress() {
  const params = new URLSearchParams();
  if (view === "saved") params.set("view", "saved");
  if (view === "saved" && filter !== "all") params.set("filter", filter);
  history.replaceState(null, "", `${location.pathname}${params.size ? `?${params}` : ""}`);
}

async function start() {
  clearStep = new TwoStep($("clear"), () => view === "seen" ? "Clear history" : "Delete saved media");
  saveStep = new TwoStep($("saveAll"), () => "Save all to Downloads");
  readAddress();
  [seenRows, savedRows] = await Promise.all([
    readHistory().then(entries => entries.map(rowFromHistory)).catch(() => []),
    readLibrary().then(entries => entries.map(rowFromLibrary)).catch(() => [])
  ]);
  await apply();
  new IntersectionObserver(entries => {
    if (entries.some(entry => entry.isIntersecting) && rendered < shown.length) void renderMore();
  }, {rootMargin: "800px 0px"}).observe($("more"));
  $("search").addEventListener("input", () => void apply());
  $("clear").addEventListener("click", () => void clearView());
  $("saveAll").addEventListener("click", () => void saveAll());
  document.querySelector(".history-head")!.addEventListener("click", event => {
    const button = (event.target as Element).closest<HTMLElement>("[data-show],[data-filter]");
    if (!button) return;
    if (button.dataset.show) view = button.dataset.show as View;
    else filter = button.dataset.filter as Filter;
    writeAddress();
    void apply();
  });
  $("days").addEventListener("click", event => {
    const media = (event.target as Element).closest<HTMLElement>("[data-index]");
    if (!media || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey) return;
    event.preventDefault();
    openViewer(Number(media.dataset.index));
  });
  $("view").addEventListener("click", event => {
    const action = (event.target as Element).closest<HTMLElement>("[data-view]")?.dataset.view;
    if (action === "close" || event.target === $("view")) closeViewer();
    else if (action) step(action === "next" ? 1 : -1);
  });
  // The mouse's back and forward buttons step through, like in the preview.
  $("view").addEventListener("mouseup", event => {
    if (event.button === 3 || event.button === 4) step(event.button === 4 ? 1 : -1);
  });
  $("viewSave").addEventListener("click", () => void saveViewed());
  document.addEventListener("keydown", onKey);
  $("view").addEventListener("wheel", onWheel, {passive: false});
  const stats = await chrome.runtime.sendMessage({type: "LINKPEEK_LIBRARY_STATS"}).catch(() => undefined) as {count?: number; bytes?: number} | undefined;
  if (stats?.count) $("saveAll").title = `${stats.count.toLocaleString()} files kept on this device (${(stats.bytes! / 1024 / 1024).toFixed(0)} MB) · save the ones shown into Downloads / LinkPeek Library`;
}

void start();
