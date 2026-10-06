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
import DragSelect from "dragselect";
import {escapeHtml} from "../shared/dom";
import {LIBRARY_CACHE, libraryFileName, readHistory, readLibrary, savedUrlOf, type HistoryEntry, type LibraryEntry} from "../shared/history";
import {linkLabel, type MediaItem} from "../shared/media";
import type {AuditTickMessage} from "../shared/messages";
import {SeenMedia, recordSeen} from "../shared/seen-media";
import {DEFAULT_SETTINGS, loadSettings, type LinkPeekSettings} from "../shared/settings";
import {mineTags, titleHasTag, type TitleTag} from "../shared/title-tags";

/** Entries rendered per step as the list scrolls. */
const PAGE = 240;
const CONFIRM_MS = 3000;
const WHEEL_STEP_MS = 220;
/** A video slide may play itself out for at most this long. */
const PLAY_MAX_MS = 60_000;

type View = "seen" | "saved";
type Filter = "all" | "unseen" | "seen";
type Kind = "all" | "gif" | "video" | "image";
type Sort = "newest" | "oldest" | "title" | "largest";

/** What one of each kind is called, in the seen and the saved view. */
const NOUNS: Record<Kind, [string, string]> = {all: ["item", "file"], gif: ["GIF", "GIF"], video: ["video", "video"], image: ["picture", "picture"]};

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
  /** Measured pixel size and weight, known for saved files. */
  w?: number;
  h?: number;
  bytes?: number;
  /** Its copy in Downloads / LinkPeek Library, when one was made. */
  dl?: number;
}

export function rowFromHistory(entry: HistoryEntry): Row {
  return {at: entry.a, type: entry.t, title: entry.n, source: entry.s, open: entry.o, saved: savedUrlOf(entry), thumb: entry.p, seen: true};
}

export function rowFromLibrary([url, entry]: [string, LibraryEntry]): Row {
  const type = entry.type ?? (/\.gif(?:$|[?#])/i.test(url) ? "gif" : "image");
  return {
    at: entry.at, type, title: entry.title, source: entry.source ?? url, open: entry.original ?? url, saved: url,
    thumb: type === "image" ? url : entry.preview ?? "", seen: entry.seen !== false,
    w: entry.w, h: entry.h, bytes: entry.bytes, dl: entry.dl
  };
}

const $ = (id: string) => document.getElementById(id)!;
let view: View = "seen";
let filter: Filter = "all";
let kind: Kind = "all";
let sort: Sort = "newest";
/** The active tag's normalised key, or null for no tag. */
let tag: string | null = null;
let tags: TitleTag[] = [];
let settings: LinkPeekSettings = DEFAULT_SETTINGS;
/** Everything ever seen, anywhere, so the slideshow can promise something new. */
const seenMedia = new SeenMedia();
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

function displayTitle(row: Row) {
  return row.title || linkLabel(row.source);
}

function tile(row: Row, index: number) {
  const title = displayTitle(row);
  const badges = (row.type === "image" ? "" : `<span class="h-badge">${row.type === "gif" ? "GIF" : "▶"}</span>`) + (view === "saved" && !row.seen ? `<span class="h-new">Not seen yet</span>` : "");
  const picture = row.thumb ? `<img data-src="${escapeHtml(row.thumb)}" alt="" decoding="async">` : `<span class="h-none">${row.type === "video" ? "Video" : "No preview"}</span>`;
  return `<figure class="h-tile${chosen.has(row) ? " h-selected" : ""}" data-row="${index}"><a class="h-media" href="${escapeHtml(row.open)}" target="_blank" rel="noopener" data-index="${index}" title="Open">${picture}${badges}</a>`
    + `<button type="button" class="h-pick" data-pick aria-pressed="${String(chosen.has(row))}" aria-label="Select">✓</button>`
    + `<figcaption><a href="${escapeHtml(row.source)}" target="_blank" rel="noopener" title="${escapeHtml(row.source)}">${escapeHtml(title)}</a>`
    + `<time datetime="${new Date(row.at).toISOString()}">${new Date(row.at).toLocaleTimeString(undefined, {hour: "2-digit", minute: "2-digit"})}</time></figcaption></figure>`;
}

/** Shows each new thumbnail (still holding data-src) from its saved copy when there is one, else from the web. */
async function fillThumbnails() {
  for (const image of document.querySelectorAll<HTMLImageElement>("img[data-src]")) {
    const row = shown[Number(image.closest<HTMLElement>("[data-index]")!.dataset.index)], network = image.dataset.src!;
    image.removeAttribute("data-src");
    // The grid may be refiltered while a saved copy is being read; a tile no longer backed by a row is left alone.
    if (!row) continue;
    // A picture's saved copy is its thumbnail; a GIF's or video's is the original, too heavy for a tile.
    image.src = (row.type === "image" ? await savedCopy(row.saved) : undefined) ?? network;
  }
}

/** The heading a row files under: the day for date orders, a letter for titles, a size band for sizes. */
function headingFor(row: Row) {
  if (sort === "title") {
    const first = displayTitle(row).trim().charAt(0).toUpperCase();
    return /\p{L}/u.test(first) ? first : "#";
  }
  if (sort === "largest") {
    const bytes = row.bytes!;
    if (bytes >= 10 * 1024 * 1024) return "10 MB and up";
    return bytes >= 1024 * 1024 ? "1 to 10 MB" : "Under 1 MB";
  }
  return dayLabel(row.at);
}

/** Renders the next page of rows, starting a new heading where it changes. */
function renderMore() {
  const days = $("days"), start = rendered, next = shown.slice(rendered, rendered + PAGE);
  let grid = days.lastElementChild?.querySelector(".h-grid") ?? null, lastDay = days.lastElementChild?.getAttribute("data-day") ?? "";
  const pieces: string[] = [];
  next.forEach((row, offset) => {
    const label = headingFor(row);
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
  refreshSelectables();
  return fillThumbnails();
}

/** Whether the row's title carries the tag, remembered per title so filtering stays instant. */
const tagHits = new Map<string, boolean>();
function rowHasTag(row: Row, key: string) {
  const memo = `${key}\u0000${row.title ?? ""}`;
  let hit = tagHits.get(memo);
  if (hit === undefined) tagHits.set(memo, hit = titleHasTag(row.title ?? "", key));
  return hit;
}

/** The rows of the current view, seen-state filter, kind of media and tag, before searching. */
function current() {
  let base = view === "seen" ? seenRows : filter === "all" ? savedRows : savedRows.filter(row => row.seen === (filter === "seen"));
  if (kind !== "all") base = base.filter(row => row.type === kind);
  if (tag) base = base.filter(row => rowHasTag(row, tag!));
  return base;
}

/**
 * Mines the tag chips from every title on record. The active tag survives
 * only while it is still offered, so the chips always explain the filter.
 */
function computeTags() {
  tags = mineTags([...seenRows, ...savedRows].map(row => row.title ?? ""));
  if (tag && !tags.some(mined => mined.key === tag)) {
    tag = null;
    writeAddress();
  }
  const host = $("tags");
  host.innerHTML = tags.map(mined =>
    `<button type="button" class="h-chip" data-tag="${escapeHtml(mined.key)}" aria-pressed="${String(mined.key === tag)}" title="${mined.count.toLocaleString()} titles">${escapeHtml(mined.label)}</button>`).join("");
  host.hidden = !tags.length;
}

function summary() {
  const base = current(), query = ($("search") as HTMLInputElement).value.trim(), noun = NOUNS[kind][view === "seen" ? 0 : 1];
  if (!base.length) {
    if (tag) return `Nothing here carries \u201c${tag}\u201d.`;
    if (kind !== "all") return `No ${noun}s ${view === "seen" ? "in the history" : "among the saved files"} yet.`;
    if (view === "seen") return "Nothing here yet. What you open in LinkPeek appears here, newest first.";
    return filter === "unseen" ? "Nothing preloaded is waiting: everything saved has been seen." : "Nothing is saved on this device yet. Prepared and shown media is saved here as LinkPeek works.";
  }
  if (query) return `${shown.length.toLocaleString()} of ${base.length.toLocaleString()} match “${query}”`;
  return `${base.length.toLocaleString()} ${noun}${base.length === 1 ? "" : "s"}, newest first`;
}

/** Shows the right buttons as active for the current view and filter. */
function paintControls() {
  for (const button of document.querySelectorAll<HTMLElement>("[data-show]")) button.setAttribute("aria-pressed", String(button.dataset.show === view));
  for (const button of document.querySelectorAll<HTMLElement>("[data-filter]")) button.setAttribute("aria-pressed", String(button.dataset.filter === filter));
  for (const button of document.querySelectorAll<HTMLElement>("[data-kind]")) button.setAttribute("aria-pressed", String(button.dataset.kind === kind));
  for (const button of document.querySelectorAll<HTMLElement>("[data-tag]")) button.setAttribute("aria-pressed", String(button.dataset.tag === tag));
  const order = $("sort") as HTMLSelectElement;
  order.value = sort;
  // Only saved files know their size, so the seen view cannot order by it.
  order.querySelector<HTMLOptionElement>('option[value="largest"]')!.disabled = view === "seen";
  $("filters").hidden = view !== "saved";
  $("audit").hidden = view !== "saved";
  $("clear").textContent = view === "seen" ? "Clear history" : "Delete saved media";
}

// ---- Selecting many at once ----

let selecting = false;
/** The rows picked, by identity, so they survive re-sorts and paging. */
const chosen = new Set<Row>();
/** The rubber band, alive only while selecting. */
let band: DragSelect<HTMLElement> | undefined;
let deleteStep: TwoStep | undefined;

function tilesNow() {
  return [...document.querySelectorAll<HTMLElement>(".h-tile")];
}

function refreshSelectables() {
  band?.setSettings({selectables: tilesNow()});
}

/** Paints every tile's picked state and the bar's count. */
function paintSelection() {
  for (const el of tilesNow()) {
    const picked = chosen.has(shown[Number(el.dataset.row)]);
    el.classList.toggle("h-selected", picked);
    el.querySelector("[data-pick]")!.setAttribute("aria-pressed", String(picked));
  }
  $("selbar").hidden = !selecting;
  $("selCount").textContent = `${chosen.size.toLocaleString()} selected`;
}

function enterSelecting() {
  if (selecting) return;
  selecting = true;
  document.body.classList.add("h-selecting");
  $("select").setAttribute("aria-pressed", "true");
  $("selDelete").textContent = deleteLabel();
  deleteStep = new TwoStep($("selDelete"), deleteLabel);
  band = new DragSelect<HTMLElement>({area: $("days"), draggability: false, selectables: tilesNow(), selectedClass: "h-banded"});
  // A drag of the band settles the whole selection; click toggles go through toggleRow below.
  band.subscribe("DS:end", ({items}) => {
    chosen.clear();
    for (const el of items) chosen.add(shown[Number(el.dataset.row)]);
    paintSelection();
  });
  paintSelection();
}

function exitSelecting() {
  if (!selecting) return;
  selecting = false;
  document.body.classList.remove("h-selecting");
  $("select").setAttribute("aria-pressed", "false");
  band?.stop();
  band = undefined;
  chosen.clear();
  paintSelection();
}

function deleteLabel() {
  return view === "seen" ? "Remove from history" : "Delete files";
}

function toggleRow(el: HTMLElement) {
  const row = shown[Number(el.dataset.row)];
  if (chosen.has(row)) {
    chosen.delete(row);
    band?.removeSelection(el);
  } else {
    chosen.add(row);
    band?.addSelection(el);
  }
  paintSelection();
}

/** Deletes the picked rows: saved files leave with their Downloads copies, seen rows leave the history. */
async function deleteChosen() {
  const rows = [...chosen];
  if (!rows.length) return;
  const noun = view === "seen" ? "entries" : "files";
  if (!deleteStep!.confirm(`Press again to remove ${rows.length.toLocaleString()} ${noun}`)) return;
  if (view === "seen") {
    await chrome.runtime.sendMessage({type: "LINKPEEK_HISTORY_REMOVE", entries: rows.map(row => ({a: row.at, o: row.open}))}).catch(() => undefined);
    seenRows = seenRows.filter(row => !chosen.has(row));
  } else {
    await chrome.runtime.sendMessage({type: "LINKPEEK_LIBRARY_REMOVE", urls: rows.map(row => row.saved)}).catch(() => undefined);
    savedRows = savedRows.filter(row => !chosen.has(row));
  }
  const message = view === "seen"
    ? `Removed ${rows.length.toLocaleString()} from the history`
    : `Deleted ${rows.length.toLocaleString()} files, Downloads copies included`;
  exitSelecting();
  computeTags();
  await apply();
  $("summary").textContent = message;
}

function searchWords() {
  return ($("search") as HTMLInputElement).value.trim().toLowerCase().split(/\s+/).filter(Boolean);
}

function matchesSearch(row: Row, words: string[]) {
  const text = `${row.title ?? ""} ${row.source} ${row.open}`.toLowerCase();
  return words.every(word => text.includes(word));
}

const ORDERS: Record<Sort, (a: Row, b: Row) => number> = {
  newest: (a, b) => b.at - a.at,
  oldest: (a, b) => a.at - b.at,
  title: (a, b) => displayTitle(a).localeCompare(displayTitle(b)) || b.at - a.at,
  largest: (a, b) => b.bytes! - a.bytes! || b.at - a.at
};

async function apply() {
  const words = searchWords();
  const base = current();
  shown = (words.length ? base.filter(row => matchesSearch(row, words)) : base).slice().sort(ORDERS[sort]);
  rendered = 0;
  paintControls();
  $("days").replaceChildren();
  $("summary").textContent = summary();
  await renderMore();
  // Rows no longer shown cannot stay picked, or Delete would act on what cannot be seen.
  const visible = new Set(shown);
  for (const row of [...chosen]) {
    if (!visible.has(row)) chosen.delete(row);
  }
  paintSelection();
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
  computeTags();
  await apply();
}

/** The file name a saved item gets in Downloads: when it was seen or saved, then its own name, so the folder sorts in order. */
function fileName(row: Row) {
  return libraryFileName(row.saved, row.at);
}

/**
 * Measures every saved file, removes ones below the minimum media size
 * (Downloads copies included), and fills in missing Downloads copies.
 */
async function auditSaved() {
  $("summary").textContent = "Checking the saved files…";
  const result = await chrome.runtime.sendMessage({type: "LINKPEEK_LIBRARY_AUDIT"}).catch(() => undefined) as {removed: number; mirrored: number} | undefined;
  savedRows = await readLibrary().then(entries => entries.map(rowFromLibrary)).catch(() => []);
  computeTags();
  await apply();
  $("summary").textContent = result
    ? `Checked every saved file: removed ${result.removed.toLocaleString()} below your minimum size, added ${result.mirrored.toLocaleString()} to Downloads / LinkPeek Library.`
    : "Couldn’t check the saved files.";
}

/** The file's own name, for the one-line progress of the saved-files check. */
function shortName(url: string) {
  const tail = url.split("/").pop()!.split("?")[0];
  return tail || url;
}

/** One line, updated live while the worker checks the saved files. */
function onAuditTick(tick: AuditTickMessage) {
  $("summary").textContent = `Checking saved files · ${tick.checked.toLocaleString()} of ${tick.total.toLocaleString()}`
    + ` · ${tick.removed.toLocaleString()} removed · ${tick.mirrored.toLocaleString()} added to Downloads · ${shortName(tick.url)}`
    + (tick.resting ? " · easing off to spare the browser" : "");
}

/** The ids of Downloads copies whose file is still on disk. */
async function inDownloads() {
  const found = await (chrome.downloads.search?.({filenameRegex: "LinkPeek Library"}) ?? Promise.resolve([])).catch(() => [] as chrome.downloads.DownloadItem[]);
  return new Set(found.filter(item => item.exists !== false).map(item => item.id));
}

async function saveAll() {
  const saved = (await Promise.all(shown.map(async row => ({row, url: await savedCopy(row.saved)})))).filter(item => item.url);
  if (!saved.length) {
    $("summary").textContent = "Nothing here is saved on this device yet. Turn on Settings → Privacy → Save what you see.";
    return;
  }
  // Files whose Downloads copy is still on disk are not written twice; rows from the seen view find theirs by address.
  const there = await inDownloads();
  const dlOf = new Map(savedRows.filter(row => row.dl !== undefined).map(row => [row.saved, row.dl!] as const));
  const wanted = saved.filter(({row}) => {
    const dl = row.dl ?? dlOf.get(row.saved);
    return dl === undefined || !there.has(dl);
  });
  if (!wanted.length) {
    $("summary").textContent = "Everything shown is already in Downloads / LinkPeek Library.";
    return;
  }
  if (!saveStep.confirm(`Press again to save ${wanted.length.toLocaleString()} files`)) return;
  let done = 0;
  for (const {row, url} of wanted) {
    await chrome.downloads.download({url: url!, filename: fileName(row), conflictAction: "uniquify", saveAs: false}).catch(() => undefined);
    $("summary").textContent = `Saving to Downloads / LinkPeek Library… ${++done} of ${wanted.length}`;
  }
  const skipped = saved.length - wanted.length;
  $("summary").textContent = `Saved ${wanted.length.toLocaleString()} files to Downloads / LinkPeek Library${skipped ? ` (${skipped.toLocaleString()} already there)` : ""}`;
}

// ---- The full-size viewer and the slideshow ----

/** The rows the viewer walks: the slideshow's queue while one plays, else what the grid shows. */
let playlist: Row[] | null = null;
let playing = false;
let paused = false;
let playTimer: ReturnType<typeof setTimeout> | undefined;
/** Something became seen while the viewer was open; the grid refreshes on close. */
let seenChanged = false;

function viewed() {
  return playlist ?? shown;
}

/** The row as the rest of LinkPeek knows media, for recording it as seen. */
function itemOf(row: Row): MediaItem {
  return {
    id: row.saved, type: row.type, originalUrl: row.open, previewUrl: row.type === "image" ? row.saved : row.thumb,
    posterUrl: row.type === "video" ? row.thumb : undefined, sourceUrl: row.source, sourceTitle: row.title, score: 1
  };
}

/** Opening a file full size counts as seeing it — in the history, the library and the shuffle's memory. */
function markSeen(row: Row) {
  if (row.seen) return;
  row.seen = true;
  seenChanged = true;
  recordSeen(seenMedia, itemOf(row), settings);
}

async function showItem(index: number) {
  const list = viewed();
  viewing = (index + list.length) % list.length;
  const row = list[viewing], copy = await savedCopy(row.saved);
  if (viewed()[viewing] !== row) return;
  // The saved copy works offline; without one, the original from the web. A slideshow's video plays once.
  const source = copy ?? row.open, stage = $("viewStage");
  stage.innerHTML = row.type === "video"
    ? `<video src="${escapeHtml(source)}" controls autoplay ${playing ? "" : "loop "}playsinline></video>`
    : `<img src="${escapeHtml(source)}" alt="">`;
  const title = $("viewTitle") as HTMLAnchorElement;
  title.textContent = displayTitle(row);
  title.href = row.source;
  ($("viewOriginal") as HTMLAnchorElement).href = row.open;
  const size = row.w ? ` · ${row.w}×${row.h}` : "";
  const weight = row.bytes ? ` · ${row.bytes >= 1024 * 1024 ? `${(row.bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(row.bytes / 1024))} KB`}` : "";
  const mode = playing ? (paused ? " · slideshow paused" : " · slideshow") : "";
  $("viewMeta").textContent = `${viewing + 1} of ${list.length}${size}${weight} · ${new Date(row.at).toLocaleString()}${copy ? " · saved on this device" : ""}${mode}`;
  markSeen(row);
  if (playing) {
    stage.querySelector("video")?.addEventListener("ended", () => advance(), {once: true});
    queueAdvance(row);
  }
}

/** Lines up the next slide: a still waits the configured seconds, a video gets to play itself out. */
function queueAdvance(row: Row) {
  clearTimeout(playTimer);
  if (paused) return;
  playTimer = setTimeout(advance, row.type === "video" ? PLAY_MAX_MS : Math.max(1, settings.slideshowSeconds) * 1000);
}

function advance() {
  clearTimeout(playTimer);
  // A video that ends while the slideshow is paused stays put.
  if (paused) return;
  if (viewing >= viewed().length - 1) {
    stopSlideshow("all caught up");
    return;
  }
  void showItem(viewing + 1);
}

function stopSlideshow(note?: string) {
  clearTimeout(playTimer);
  playing = false;
  paused = false;
  $("viewPause").hidden = true;
  if (note) $("viewMeta").textContent += ` · ${note}`;
}

function shuffleRows(rows: Row[]) {
  for (let i = rows.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [rows[i], rows[j]] = [rows[j], rows[i]];
  }
  return rows;
}

/**
 * Plays everything saved but never seen — not here, not in any tab, not ever —
 * honouring the kind, tag and search filters. GIFs always come first, and
 * every slide shown is recorded as seen.
 */
function startSlideshow() {
  const words = searchWords();
  let pool = savedRows.filter(row => !row.seen && !seenMedia.has({originalUrl: row.open}));
  if (kind !== "all") pool = pool.filter(row => row.type === kind);
  if (tag) pool = pool.filter(row => rowHasTag(row, tag!));
  if (words.length) pool = pool.filter(row => matchesSearch(row, words));
  playlist = [...shuffleRows(pool.filter(row => row.type === "gif")), ...shuffleRows(pool.filter(row => row.type !== "gif"))];
  if (!playlist.length) {
    playlist = null;
    $("summary").textContent = "Nothing new to play: everything saved that matches has been seen.";
    return;
  }
  playing = true;
  paused = false;
  const pause = $("viewPause");
  pause.hidden = false;
  pause.textContent = "Pause";
  $("view").hidden = false;
  void showItem(0);
}

function togglePause() {
  if (!playing) return;
  paused = !paused;
  $("viewPause").textContent = paused ? "Resume" : "Pause";
  $("viewMeta").textContent = $("viewMeta").textContent!.replace(/ · slideshow( paused)?$/, paused ? " · slideshow paused" : " · slideshow");
  if (paused) clearTimeout(playTimer);
  else queueAdvance(viewed()[viewing]);
}

function openViewer(index: number) {
  playlist = null;
  $("view").hidden = false;
  void showItem(index);
}

function closeViewer() {
  stopSlideshow();
  playlist = null;
  $("view").hidden = true;
  $("viewStage").replaceChildren();
  viewing = -1;
  if (seenChanged) {
    seenChanged = false;
    void apply();
  }
}

function step(delta: number) {
  if (viewing >= 0) void showItem(viewing + delta);
}

async function saveViewed() {
  const row = viewed()[viewing];
  await chrome.downloads.download({url: await savedCopy(row.saved) ?? row.open, filename: fileName(row), conflictAction: "uniquify", saveAs: false}).catch(() => undefined);
}

function onKey(event: KeyboardEvent) {
  if (viewing < 0) {
    if (event.key === "Escape" && selecting) {
      exitSelecting();
      event.preventDefault();
    }
    return;
  }
  const moves: Record<string, number> = {ArrowRight: 1, ArrowDown: 1, " ": 1, ArrowLeft: -1, ArrowUp: -1};
  if (event.key === " " && playing) togglePause();
  else if (event.key === "Escape") closeViewer();
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
  const media = params.get("media");
  kind = media === "gif" || media === "video" || media === "image" ? media : "all";
  const order = params.get("sort");
  sort = order === "oldest" || order === "title" || order === "largest" ? order : "newest";
  tag = params.get("tag");
}

function writeAddress() {
  const params = new URLSearchParams();
  if (view === "saved") params.set("view", "saved");
  if (view === "saved" && filter !== "all") params.set("filter", filter);
  if (kind !== "all") params.set("media", kind);
  if (sort !== "newest") params.set("sort", sort);
  if (tag) params.set("tag", tag);
  history.replaceState(null, "", `${location.pathname}${params.size ? `?${params}` : ""}`);
}

async function start() {
  clearStep = new TwoStep($("clear"), () => view === "seen" ? "Clear history" : "Delete saved media");
  saveStep = new TwoStep($("saveAll"), () => "Save all to Downloads");
  readAddress();
  settings = await loadSettings().catch(() => DEFAULT_SETTINGS);
  void seenMedia.load();
  [seenRows, savedRows] = await Promise.all([
    readHistory().then(entries => entries.map(rowFromHistory)).catch(() => []),
    readLibrary().then(entries => entries.map(rowFromLibrary)).catch(() => [])
  ]);
  computeTags();
  await apply();
  new IntersectionObserver(entries => {
    if (entries.some(entry => entry.isIntersecting) && rendered < shown.length) void renderMore();
  }, {rootMargin: "800px 0px"}).observe($("more"));
  $("search").addEventListener("input", () => void apply());
  $("clear").addEventListener("click", () => void clearView());
  $("saveAll").addEventListener("click", () => void saveAll());
  $("audit").addEventListener("click", () => void auditSaved());
  $("play").addEventListener("click", startSlideshow);
  $("select").addEventListener("click", () => selecting ? exitSelecting() : enterSelecting());
  $("selAll").addEventListener("click", () => {
    for (const row of shown) chosen.add(row);
    paintSelection();
  });
  $("selCancel").addEventListener("click", exitSelecting);
  $("selDelete").addEventListener("click", () => void deleteChosen());
  chrome.runtime.onMessage.addListener((msg: {type?: string}) => {
    if (msg?.type === "LINKPEEK_AUDIT_TICK") onAuditTick(msg as AuditTickMessage);
    return false;
  });
  $("viewPause").addEventListener("click", togglePause);
  $("sort").addEventListener("change", () => {
    sort = ($("sort") as HTMLSelectElement).value as Sort;
    writeAddress();
    void apply();
  });
  $("tags").addEventListener("click", event => {
    const button = (event.target as Element).closest<HTMLElement>("[data-tag]");
    if (!button) return;
    tag = tag === button.dataset.tag ? null : button.dataset.tag!;
    writeAddress();
    void apply();
  });
  document.querySelector(".history-head")!.addEventListener("click", event => {
    const button = (event.target as Element).closest<HTMLElement>("[data-show],[data-filter],[data-kind]");
    if (!button) return;
    if (button.dataset.show) {
      view = button.dataset.show as View;
      // The seen view cannot order by size, and a selection made in one view means nothing in the other.
      if (view === "seen" && sort === "largest") sort = "newest";
      exitSelecting();
    } else if (button.dataset.kind) kind = button.dataset.kind as Kind;
    else filter = button.dataset.filter as Filter;
    writeAddress();
    void apply();
  });
  $("days").addEventListener("click", event => {
    const target = event.target as Element;
    const pick = target.closest<HTMLElement>("[data-pick]");
    if (pick) {
      enterSelecting();
      toggleRow(pick.closest<HTMLElement>(".h-tile")!);
      return;
    }
    const media = target.closest<HTMLElement>("[data-index]");
    if (!media) return;
    // A held Ctrl or Cmd starts selecting right from the grid.
    if (selecting || event.ctrlKey || event.metaKey) {
      event.preventDefault();
      enterSelecting();
      toggleRow(media.closest<HTMLElement>(".h-tile")!);
      return;
    }
    if (event.button !== 0 || event.shiftKey) return;
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
