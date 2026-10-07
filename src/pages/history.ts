/**
 * The library page, in two views:
 *
 * - History: everything LinkPeek has shown, newest first, grouped by day —
 *   the diary, which outlives the files themselves.
 * - Saved files: every file kept on this device, from links prepared in the
 *   background as well as from what was shown, filterable to what you have
 *   not seen yet (the preloaded media) or have.
 *
 * Thumbnails come from the saved copies when there are any, so the page works
 * offline; the list grows as you scroll and search filters it. Clicking an item
 * opens it full size (arrows, scroll or the mouse's side buttons move through,
 * Escape closes). Select mode sweeps up many rows for deleting together or for
 * writing their files into Downloads / LinkPeek Library by hand — the copies
 * usually arrive there on their own as files are saved.
 */
import DragSelect from "dragselect";
import {escapeHtml} from "../shared/dom";
import {FAVORITE_MEDIA, LIBRARY_CACHE, STILLS_CACHE, libraryFileName, readHistory, readLibrary, savedUrlOf, type HistoryEntry, type LibraryEntry} from "../shared/history";
import {linkLabel, type MediaItem} from "../shared/media";
import type {AuditTickMessage} from "../shared/messages";
import {SeenMedia, recordSeen} from "../shared/seen-media";
import {DEFAULT_SETTINGS, loadSettings, type LinkPeekSettings} from "../shared/settings";
import {mineTags, titleHasTag, type TitleTag} from "../shared/title-tags";
import {framePoint, gifStill, videoStill} from "./stills";
import {ZOOM_STEP, ZoomPan} from "./zoom";

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
/** Only favourites are shown (and played). */
let favoritesOnly = false;
let sort: Sort = "newest";
/** Chips shown in the row itself; the rest wait in the All-tags panel. */
const INLINE_TAGS = 24;
/** The All-tags panel is open. */
let tagsOpen = false;
/** The tags switched on, in the order they were picked. */
let activeTags: string[] = [];
/** Whether rows must carry every active tag, or any one of them. */
let tagMode: "all" | "any" = "all";
/** The display spelling of every tag ever offered, so a pressed chip keeps its label. */
const tagLabels = new Map<string, string>();
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

/** A size people can read: KB under a megabyte, then MB, then GB. */
function sizeLabel(bytes: number) {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/** The one thin bar under the summary, busy with a task's share of the work. */
function paintLive(fraction: number) {
  const bar = $("progress"), percent = Math.min(100, Math.round(fraction * 100));
  bar.hidden = false;
  bar.classList.add("h-bar-live");
  bar.removeAttribute("title");
  bar.setAttribute("aria-valuenow", String(percent));
  ($("progressFill") as HTMLElement).style.width = `${percent}%`;
}

/** The same bar at rest: how much of the space for saved media is used. */
function paintStorage() {
  const bar = $("progress");
  if (view !== "saved") {
    bar.hidden = true;
    return;
  }
  const used = savedRows.reduce((sum, row) => sum + row.bytes!, 0);
  const budget = settings.savedMediaBudgetMb * 1024 * 1024;
  const percent = Math.min(100, Math.round(used / budget * 100));
  bar.hidden = false;
  bar.classList.remove("h-bar-live");
  bar.title = `${sizeLabel(used)} of the ${sizeLabel(budget)} for saved media is used`;
  bar.setAttribute("aria-valuenow", String(percent));
  ($("progressFill") as HTMLElement).style.width = `${percent}%`;
}

/** A thumbnail that already knows its shape holds its place before it loads, so the collage never jumps. */
function shaped(picture: string, row: Row) {
  return row.w ? picture.replace("<img ", `<img style="aspect-ratio: ${row.w} / ${row.h}" `) : picture;
}

function tile(row: Row, index: number) {
  const title = displayTitle(row);
  const badges = (row.type === "image" ? "" : `<span class="h-badge">${row.type === "gif" ? "GIF" : "▶"}</span>`) + (view === "saved" && !row.seen ? `<span class="h-new">Not seen yet</span>` : "")
    + (favorites.has(row.saved) ? `<span class="h-fav" title="Favourite">★</span>` : "");
  // Moving media always gets a picture of itself; a site's own preview, if any, is the fallback.
  const fallback = row.thumb ? ` data-src="${escapeHtml(row.thumb)}"` : "";
  const picture = row.type !== "image" ? `<img data-still${fallback} alt="" decoding="async">`
    : row.thumb ? `<img data-src="${escapeHtml(row.thumb)}" alt="" decoding="async">` : `<span class="h-none">No preview</span>`;
  return `<figure class="h-tile${chosen.has(row) ? " h-selected" : ""}" data-row="${index}"><a class="h-media" href="${escapeHtml(row.open)}" target="_blank" rel="noopener" data-index="${index}" title="Open">${shaped(picture, row)}${badges}</a>`
    + `<button type="button" class="h-pick" data-pick aria-pressed="${String(chosen.has(row))}" aria-label="Select">✓</button>`
    + `<figcaption><a href="${escapeHtml(row.source)}" target="_blank" rel="noopener" title="${escapeHtml(row.source)}">${escapeHtml(title)}</a>`
    + `<time datetime="${new Date(row.at).toISOString()}">${new Date(row.at).toLocaleTimeString(undefined, {hour: "2-digit", minute: "2-digit"})}</time></figcaption></figure>`;
}

// ---- Stills for moving media ----

/** Object URLs of stills already made or read, so each is decoded once. */
const stillUrls = new Map<string, string>();
let stillsCache: Promise<Cache | undefined> | undefined;
const stillQueue: Array<() => Promise<void>> = [];
let stillsActive = 0;
/** Stills made at once: enough to keep up with scrolling, few enough to leave the page smooth. */
const STILL_WORKERS = 2;

function openStills() {
  stillsCache ??= (typeof caches === "undefined" ? Promise.resolve(undefined) : caches.open(STILLS_CACHE).catch(() => undefined));
  return stillsCache;
}

/** Files no still could be made from this visit, so a redraw does not fetch them again. */
const noStill = new Set<string>();

/** A GIF's first frame, or a video's frame from its stable point: made once, then kept on this device. */
async function stillFor(row: Row) {
  const known = stillUrls.get(row.saved);
  if (known || noStill.has(row.saved)) return known;
  const cache = await openStills();
  let blob = await cache?.match(row.saved).then(hit => hit?.blob());
  if (!blob) {
    blob = await makeStill(row).catch(() => undefined);
    if (!blob) {
      noStill.add(row.saved);
      return undefined;
    }
    await cache?.put(row.saved, new Response(blob, {headers: {"content-type": "image/jpeg"}})).catch(() => undefined);
  }
  const url = URL.createObjectURL(blob);
  stillUrls.set(row.saved, url);
  return url;
}

/** Reads the moving file — the saved copy when there is one, else the web — and takes its still. */
async function makeStill(row: Row) {
  if (row.type === "gif") {
    const kept = await (await openCache())?.match(row.saved);
    const bytes = kept ? await kept.blob() : await fetch(row.open).then(response => response.ok ? response.blob() : Promise.reject(new Error(`HTTP ${response.status}`)));
    return gifStill(bytes);
  }
  return videoStill(await savedCopy(row.saved) ?? row.open, row.saved);
}

/** Stills are made a couple at a time, top of the grid first. */
function queueStill(job: () => Promise<void>) {
  stillQueue.push(job);
  pumpStills();
}

function pumpStills() {
  while (stillsActive < STILL_WORKERS && stillQueue.length) {
    const job = stillQueue.shift()!;
    stillsActive++;
    void job().finally(() => {
      stillsActive--;
      pumpStills();
    });
  }
}

/**
 * When no still can be made (a cross-origin clip the page may not read
 * back), the tile shows the clip itself, paused near its start.
 */
async function pausedFrame(image: HTMLImageElement, row: Row) {
  const video = Object.assign(document.createElement("video"), {className: "h-still", muted: true, preload: "metadata", playsInline: true});
  video.src = `${await savedCopy(row.saved) ?? row.open}#t=${(framePoint(row.saved) * 10).toFixed(1)}`;
  image.replaceWith(video);
}

/** Puts the still on a tile, or the best fallback when none can be made. */
async function placeStill(image: HTMLImageElement, row: Row, fallback: string) {
  // The grid may have been redrawn while this waited its turn.
  if (!image.isConnected) return;
  const still = await stillFor(row);
  if (still) image.src = still;
  else if (fallback) image.src = fallback;
  else if (row.type === "video") await pausedFrame(image, row);
  else image.replaceWith(Object.assign(document.createElement("span"), {className: "h-none", textContent: "GIF"}));
}

/**
 * Shows each new thumbnail. A picture's comes from its saved copy when there
 * is one, else the web. A GIF shows its first frame while "play GIFs only on
 * hover" is on, and plays in place while it is off; a video shows the site's
 * own poster, or else a frame of its own.
 */
async function fillThumbnails() {
  for (const image of document.querySelectorAll<HTMLImageElement>("img[data-src], img[data-still]")) {
    const row = shown[Number(image.closest<HTMLElement>("[data-index]")!.dataset.index)], network = image.dataset.src ?? "";
    const moving = image.hasAttribute("data-still");
    image.removeAttribute("data-src");
    image.removeAttribute("data-still");
    // The grid may be refiltered while a saved copy is being read; a tile no longer backed by a row is left alone.
    if (!row) continue;
    if (!moving) image.src = await savedCopy(row.saved) ?? network;
    else if (row.type === "gif" && !settings.libraryGifHover) image.src = await savedCopy(row.saved) ?? row.open;
    else if (row.type === "video" && network) image.src = network;
    else queueStill(() => placeStill(image, row, network));
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

/** Whether a row passes the active tags: every one of them, or any, as chosen. */
function matchesTags(row: Row) {
  if (!activeTags.length) return true;
  return tagMode === "all" ? activeTags.every(key => rowHasTag(row, key)) : activeTags.some(key => rowHasTag(row, key));
}

/** The rows of the current view, seen-state filter and kind of media, before tags and searching. */
function untagged() {
  const base = view === "seen" ? seenRows : filter === "all" ? savedRows : savedRows.filter(row => row.seen === (filter === "seen"));
  return base.filter(row => (kind === "all" || row.type === kind) && (!favoritesOnly || favorites.has(row.saved)));
}

/** The rows of the current view, seen-state filter, kind of media and tags, before searching. */
function current() {
  return untagged().filter(matchesTags);
}

type MinedEntry = {key: string; tags: TitleTag[]};
/** How many minings are kept, in memory and on this device. */
const MINED_KEEP = 12;
/** Recent minings, newest first; shared with the stored copy, so reopening the page repeats none of the work. */
let mined: MinedEntry[] = [];
let minedSaveTimer: ReturnType<typeof setTimeout> | undefined;

/** A cheap fingerprint of the titles, for the memo and the stored cache. */
function titlesKey(titles: readonly string[]) {
  let hash = 2166136261;
  for (const title of titles) {
    for (let at = 0; at < title.length; at++) {
      hash ^= title.charCodeAt(at);
      hash = Math.imul(hash, 16777619);
    }
    hash ^= 31;
  }
  return `${titles.length}:${(hash >>> 0).toString(36)}`;
}

/** The tags these titles earn: from a recent mining when the same titles were mined before, else mined now. */
function minedTags(titles: string[]): TitleTag[] {
  const key = titlesKey(titles);
  let entry = mined.find(candidate => candidate.key === key);
  if (!entry) {
    entry = {key, tags: mineTags(titles)};
    mined = [entry, ...mined].slice(0, MINED_KEEP);
    // Written once things settle, not on every filter change.
    clearTimeout(minedSaveTimer);
    minedSaveTimer = setTimeout(() => void chrome.storage.local.set({libraryTags: mined}).catch(() => undefined), 1000);
  }
  return entry.tags;
}

/**
 * Loads the minings stored on this device (a cache that cannot be read just
 * means mining afresh), then mines the whole collection — usually straight
 * from that cache — to learn every tag's display spelling.
 */
async function computeTags() {
  if (!mined.length) {
    const stored = (await chrome.storage.local.get("libraryTags").catch(() => ({})) as Record<string, unknown>)["libraryTags"];
    if (Array.isArray(stored)) mined = stored.filter((entry: MinedEntry) => typeof entry?.key === "string" && Array.isArray(entry.tags)).slice(0, MINED_KEEP);
  }
  for (const tag of minedTags([...seenRows, ...savedRows].map(row => row.title ?? ""))) tagLabels.set(tag.key, tag.label);
}

function chipMarkup(key: string, label: string, count: number | null) {
  return `<button type="button" class="h-chip" data-tag="${escapeHtml(key)}" aria-pressed="${String(activeTags.includes(key))}"${count === null ? "" : ` title="${count.toLocaleString()} titles"`}>${escapeHtml(label)}</button>`;
}

/**
 * Every tag still worth offering, the active ones set aside. Matching all,
 * each pick narrows the rows, so the offer is re-mined from what remains;
 * matching any, each pick widens them, so everything stays on offer.
 */
function offeredTags() {
  const rows = tagMode === "all" ? current() : untagged();
  const offered = minedTags(rows.map(row => row.title ?? "")).filter(tag => !activeTags.includes(tag.key));
  for (const tag of offered) tagLabels.set(tag.key, tag.label);
  return offered;
}

/**
 * The chips on offer: every tag switched on stays first (pressed, so it can
 * be switched off), then the strongest of the rest — picking a tag narrows
 * the row to the tags that still lead anywhere. Everything beyond the row
 * waits in the All-tags panel, so thousands of files never crowd the page.
 */
function renderTags() {
  const offered = offeredTags();
  if (offered.length <= INLINE_TAGS) tagsOpen = false;
  const host = $("tags");
  host.innerHTML = [
    // With two or more tags on, one chip says how they combine, and flips it.
    activeTags.length > 1
      ? `<button type="button" id="tagMode" class="h-chip h-mode" title="Switch between files carrying every picked tag and files carrying any of them">${tagMode === "all" ? "Match all" : "Match any"}</button>`
      : "",
    ...activeTags.map(key => chipMarkup(key, tagLabels.get(key) ?? key, null)),
    ...offered.slice(0, INLINE_TAGS).map(mined => chipMarkup(mined.key, mined.label, mined.count)),
    offered.length > INLINE_TAGS
      ? `<button type="button" id="tagsMore" class="h-chip h-more" aria-expanded="${String(tagsOpen)}">${tagsOpen ? "Fewer tags ▴" : `All tags (${offered.length.toLocaleString()}) ▾`}</button>`
      : ""
  ].join("");
  host.hidden = !host.innerHTML;
  renderAllTags();
}

/** The panel with every tag on offer, narrowed as you type. */
function renderAllTags() {
  const panel = $("tagsAll");
  if (!tagsOpen) {
    panel.hidden = true;
    return;
  }
  panel.hidden = false;
  const find = ($("tagsFind") as HTMLInputElement).value.trim().toLowerCase();
  const offered = offeredTags();
  const matching = find ? offered.filter(mined => mined.key.includes(find) || mined.label.toLowerCase().includes(find)) : offered;
  $("tagsAllList").innerHTML = matching.map(mined => chipMarkup(mined.key, mined.label, mined.count)).join("")
    || `<span class="muted">No tag matches \u201c${escapeHtml(find)}\u201d.</span>`;
}

function summary() {
  const base = current(), query = ($("search") as HTMLInputElement).value.trim(), noun = NOUNS[kind][view === "seen" ? 0 : 1];
  if (!base.length) {
    if (activeTags.length) return `Nothing here carries ${activeTags.map(key => `\u201c${key}\u201d`).join(tagMode === "all" ? " + " : " or ")}.`;
    if (favoritesOnly) return "No favourites here yet. In the full-size view, B stars what is on screen.";
    if (kind !== "all") return `No ${noun}s ${view === "seen" ? "in the history" : "among the saved files"} yet.`;
    if (view === "seen") return "Nothing here yet. What you open in LinkPeek appears here, newest first.";
    return filter === "unseen" ? "Nothing preloaded is waiting: everything saved has been seen." : "Nothing is saved on this device yet. Prepared and shown media is saved here as LinkPeek works.";
  }
  if (query) return `${shown.length.toLocaleString()} of ${base.length.toLocaleString()} match “${query}”`;
  const count = `${base.length.toLocaleString()} ${noun}${base.length === 1 ? "" : "s"}, newest first`;
  // Saved files know their weight; the history is a diary, not a disk.
  return view === "saved" ? `${count} · ${sizeLabel(base.reduce((sum, row) => sum + row.bytes!, 0))} on this device` : count;
}

/** Shows the right buttons as active for the current view and filter. */
function paintControls() {
  for (const button of document.querySelectorAll<HTMLElement>("[data-show]")) button.setAttribute("aria-pressed", String(button.dataset.show === view));
  for (const button of document.querySelectorAll<HTMLElement>("[data-filter]")) button.setAttribute("aria-pressed", String(button.dataset.filter === filter));
  for (const button of document.querySelectorAll<HTMLElement>("[data-kind]")) button.setAttribute("aria-pressed", String(button.dataset.kind === kind));
  $("favOnly").setAttribute("aria-pressed", String(favoritesOnly));
  const order = $("sort") as HTMLSelectElement;
  order.value = sort;
  // Only saved files know their size, so the seen view cannot order by it.
  order.querySelector<HTMLOptionElement>('option[value="largest"]')!.disabled = view === "seen";
  $("filters").hidden = view !== "saved";
  $("clear").textContent = view === "seen" ? "Clear history" : "Delete saved files";
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
  deleteStep = new TwoStep($("selDelete"), deleteLabel, () => {
    $("summary").textContent = summary();
  });
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

/** Names exactly what a confirmed delete will take, a handful of files by name. */
function aboutToRemove(rows: Row[], what: string) {
  const names = rows.slice(0, 5).map(row => shortName(row.saved));
  const more = rows.length - names.length;
  const where = view === "seen" ? "from the history only" : "from this device and Downloads";
  return `About to remove ${what} ${where}: ${names.join(", ")}${more > 0 ? ` and ${more.toLocaleString()} more` : ""}`;
}

/** Deletes the picked rows: saved files leave with their Downloads copies, seen rows leave the history. */
async function deleteChosen() {
  const rows = [...chosen];
  if (!rows.length) return;
  const what = view === "seen" ? plural(rows.length, "entry", "entries") : plural(rows.length, "file");
  if (!deleteStep!.confirm(`Press again to remove ${what}`)) {
    $("summary").textContent = aboutToRemove(rows, what);
    return;
  }
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
  await computeTags();
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
  renderTags();
  paintPlay();
  $("days").replaceChildren();
  $("summary").textContent = summary();
  await renderMore();
  // Rows no longer shown cannot stay picked, or Delete would act on what cannot be seen.
  const visible = new Set(shown);
  for (const row of [...chosen]) {
    if (!visible.has(row)) chosen.delete(row);
  }
  paintSelection();
  paintStorage();
}

/**
 * A button that asks for a second press within a few seconds; only the second
 * one acts. While it waits, the caller shows what is about to happen; letting
 * it lapse calls `onIdle` so that warning is taken back too.
 */
class TwoStep {
  private until = 0;

  constructor(private button: HTMLElement, private idle: () => string, private onIdle: () => void) {}

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
      this.onIdle();
    }, CONFIRM_MS);
    return false;
  }
}

let clearStep: TwoStep;

const plural = (count: number, one: string, many = `${one}s`) => `${count.toLocaleString()} ${count === 1 ? one : many}`;

/** Clears the history, or deletes the saved files, depending on the view — after saying exactly what will go. */
async function clearView() {
  if (view === "seen") {
    if (!clearStep.confirm("Press again to clear")) {
      $("summary").textContent = `About to clear the whole history: ${plural(seenRows.length, "entry", "entries")}. Saved files stay.`;
      return;
    }
    await chrome.runtime.sendMessage({type: "LINKPEEK_HISTORY_CLEAR"});
    seenRows = [];
    // Stills of what was shown go too; saved files' stills are simply remade when next needed.
    stillUrls.clear();
    stillsCache = undefined;
    await (typeof caches === "undefined" ? undefined : caches.delete(STILLS_CACHE).catch(() => undefined));
  } else {
    if (!clearStep.confirm("Press again to delete")) {
      const bytes = savedRows.reduce((sum, row) => sum + row.bytes!, 0);
      $("summary").textContent = `About to delete every saved file: ${plural(savedRows.length, "file")} (${sizeLabel(bytes)}), Downloads copies included.`;
      return;
    }
    await chrome.runtime.sendMessage({type: "LINKPEEK_LIBRARY_CLEAR"});
    savedRows = [];
  }
  await computeTags();
  await apply();
}

/** The file name a saved item gets in Downloads: when it was seen or saved, then its own name, so the folder sorts in order. */
function fileName(row: Row) {
  return libraryFileName(row.saved, row.at);
}

/**
 * Measures every saved file and every history entry, removes what is below
 * the minimum media size (Downloads copies included), and fills in missing
 * Downloads copies.
 */
async function auditSaved() {
  $("summary").textContent = "Checking the saved files…";
  paintLive(0);
  const result = await chrome.runtime.sendMessage({type: "LINKPEEK_LIBRARY_AUDIT"}).catch(() => undefined) as {removed: number; mirrored: number; historyRemoved: number} | undefined;
  [seenRows, savedRows] = await Promise.all([
    readHistory().then(entries => entries.map(rowFromHistory)).catch(() => []),
    readLibrary().then(entries => entries.map(rowFromLibrary)).catch(() => [])
  ]);
  await computeTags();
  await apply();
  $("summary").textContent = result
    ? `Checked every saved file and the history: removed ${plural(result.removed, "file")} and ${plural(result.historyRemoved, "history entry", "history entries")} below your minimum size, added ${result.mirrored.toLocaleString()} to Downloads / LinkPeek Library.`
    : "Couldn’t check the saved files.";
}

/** A rough time left, in friendly units. */
function etaLabel(ms: number) {
  const seconds = Math.round(ms / 1000);
  return seconds < 90 ? `about ${Math.max(1, seconds)}s left` : `about ${Math.round(seconds / 60)} min left`;
}

/** The file's own name, for the one-line progress of the saved-files check. */
function shortName(url: string) {
  const tail = url.split("/").pop()!.split("?")[0];
  return tail || url;
}

let auditStart = 0;

/** One line and the bar, updated live while the worker checks the saved files. */
function onAuditTick(tick: AuditTickMessage) {
  auditStart ||= Date.now();
  paintLive(tick.checked / tick.total);
  const left = (tick.total - tick.checked) * (Date.now() - auditStart) / tick.checked;
  const files = tick.phase === "files";
  $("summary").textContent = `${files ? "Checking saved files" : "Checking the history"} · ${Math.round(tick.checked / tick.total * 100)}%`
    + ` · ${tick.checked.toLocaleString()} of ${tick.total.toLocaleString()}`
    + ` · ${tick.removed.toLocaleString()} removed${files ? ` · ${tick.mirrored.toLocaleString()} added to Downloads` : ""} · ${shortName(tick.url)}`
    + (tick.checked >= 5 && tick.checked < tick.total ? ` · ${etaLabel(left)}` : "")
    + (tick.resting ? " · easing off to spare the browser" : "");
  // Done — the bar goes back to showing the space used (a check the worker ran by itself ends here too).
  if (tick.checked === tick.total) {
    auditStart = 0;
    paintStorage();
  }
}

/** The ids of Downloads copies whose file is still on disk. */
async function inDownloads() {
  const found = await (chrome.downloads.search?.({filenameRegex: "LinkPeek Library"}) ?? Promise.resolve([])).catch(() => [] as chrome.downloads.DownloadItem[]);
  return new Set(found.filter(item => item.exists !== false).map(item => item.id));
}

/**
 * Writes the picked rows' files into Downloads by hand — the saved copy when
 * one is kept, the original otherwise — skipping copies already on disk.
 * This is the manual path for when automatic copies are turned off.
 */
async function saveChosen() {
  const rows = [...chosen];
  if (!rows.length) return;
  const there = await inDownloads();
  const dlOf = new Map(savedRows.filter(row => row.dl !== undefined).map(row => [row.saved, row.dl!] as const));
  const wanted = rows.filter(row => {
    const dl = row.dl ?? dlOf.get(row.saved);
    return dl === undefined || !there.has(dl);
  });
  if (!wanted.length) {
    exitSelecting();
    $("summary").textContent = "Everything picked is already in Downloads / LinkPeek Library.";
    return;
  }
  let done = 0;
  const began = Date.now();
  for (const row of wanted) {
    await chrome.downloads.download({url: await savedCopy(row.saved) ?? row.open, filename: fileName(row), conflictAction: "uniquify", saveAs: false}).catch(() => undefined);
    const left = (wanted.length - ++done) * (Date.now() - began) / done;
    $("summary").textContent = `Saving to Downloads / LinkPeek Library… ${done} of ${wanted.length}${done >= 2 && done < wanted.length ? ` · ${etaLabel(left)}` : ""}`;
    paintLive(done / wanted.length);
  }
  const skipped = rows.length - wanted.length;
  exitSelecting();
  paintStorage();
  $("summary").textContent = `Saved ${wanted.length.toLocaleString()} to Downloads / LinkPeek Library${skipped ? ` (${skipped.toLocaleString()} already there)` : ""}`;
}

// ---- The full-size viewer and the slideshow ----

/** The rows the viewer walks: the slideshow's queue while one plays, else what the grid shows. */
let playlist: Row[] | null = null;
let playing = false;
let paused = false;
let playTimer: ReturnType<typeof setTimeout> | undefined;
/** Something the grid shows changed while the viewer was open (seen, deleted, favourited); the grid redraws on close. */
let gridStale = false;
/** The viewer's meta line without the slideshow suffix, so pause can redraw it. */
let metaBase = "";
/** A delete waiting for Enter (or the button) to confirm it. */
let confirming = false;
/** Controls fade after this long without the pointer or a key, leaving the media alone on screen. */
const IDLE_MS = 2500;
let idleTimer: ReturnType<typeof setTimeout> | undefined;
/** Zoom and pan for the media on screen; every new item starts fitted. */
let zoom: ZoomPan;
/** Files picked as favourites (by their saved address): starred, filterable, and never trimmed for space or by the size check. */
let favorites = new Set<string>();

/** What the slideshow adds to the meta line: its state, and roughly how long the rest will take. */
function modeSuffix() {
  if (!playing) return "";
  if (paused) return " · slideshow paused";
  const remaining = viewed().length - viewing - 1;
  return ` · slideshow${remaining > 0 ? ` · ${etaLabel(remaining * Math.max(1, settings.slideshowSeconds) * 1000)}` : ""}`;
}

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
  gridStale = true;
  recordSeen(seenMedia, itemOf(row), settings);
}

/** Shows the controls again, and hides them once the pointer and keys have been still for a moment. */
function wake() {
  $("view").classList.remove("h-idle");
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    // A question waiting on screen, or the key list, keeps the controls up.
    if (!confirming && $("viewHelp").hidden) $("view").classList.add("h-idle");
  }, IDLE_MS);
}

/** The zoom readout, and a zoomed video's own controls: hidden while zoomed, where they would only be in the way. */
function paintZoom(level: number) {
  const readout = $("viewZoom");
  readout.hidden = level === 1;
  readout.textContent = `${Math.round(level * 100)}%`;
  $("viewStage").classList.toggle("h-zoomed", level > 1);
  const video = $("viewStage").querySelector("video");
  if (video) video.controls = level === 1;
}

/** Looking closer pauses a slideshow rather than leaving it running underneath. */
function zoomBy(factor: number, x?: number, y?: number) {
  if (playing && !paused) togglePause();
  zoom.zoomBy(factor, x, y);
}

function paintFavorite(row: Row | undefined) {
  const on = Boolean(row && favorites.has(row.saved)), button = $("viewFav");
  button.textContent = on ? "★" : "☆";
  button.setAttribute("aria-pressed", String(on));
  button.title = on ? "Favourite: kept whatever happens (B to unstar)" : "Favourite: keep it whatever happens (B)";
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
  zoom.reset();
  const title = $("viewTitle") as HTMLAnchorElement;
  title.textContent = displayTitle(row);
  title.href = row.source;
  ($("viewOriginal") as HTMLAnchorElement).href = row.open;
  const size = row.w ? ` · ${row.w}×${row.h}` : "";
  const weight = row.bytes ? ` · ${sizeLabel(row.bytes)}` : "";
  metaBase = `${viewing + 1} of ${list.length}${size}${weight} · ${new Date(row.at).toLocaleString()}${copy ? " · saved on this device" : ""}`;
  $("viewMeta").textContent = metaBase + modeSuffix();
  paintFavorite(row);
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

/** What a slideshow started now would play: saved, never seen anywhere, and passing the kind, favourites, tags and search. */
function unseenPool() {
  const words = searchWords();
  return savedRows.filter(row => !row.seen && !seenMedia.has({originalUrl: row.open})
    && (kind === "all" || row.type === kind) && (!favoritesOnly || favorites.has(row.saved)) && matchesTags(row) && (!words.length || matchesSearch(row, words)));
}

/** Labels the play button with how much there is to play, so the tags' effect is visible before starting. */
function paintPlay() {
  const count = unseenPool().length;
  $("play").textContent = count ? `▶ Play unseen · ${count.toLocaleString()}` : "▶ Play unseen";
}

function paintPause() {
  const pause = $("viewPause");
  pause.textContent = paused ? "▶" : "⏸";
  pause.title = paused ? "Resume (Space)" : "Pause (Space)";
  pause.setAttribute("aria-label", paused ? "Resume" : "Pause");
}

/**
 * Plays everything saved but never seen — not here, not in any tab, not ever —
 * honouring the kind, favourites, tags (all or any, as chosen) and search.
 * Moving media leads: GIFs first, then videos, then pictures, each group
 * shuffled, and every slide shown is recorded as seen.
 */
function startSlideshow() {
  const pool = unseenPool();
  playlist = (["gif", "video", "image"] as const).flatMap(type => shuffleRows(pool.filter(row => row.type === type)));
  if (!playlist.length) {
    playlist = null;
    $("summary").textContent = "Nothing new to play: everything saved that matches has been seen.";
    return;
  }
  playing = true;
  paused = false;
  $("viewPause").hidden = false;
  paintPause();
  showViewer();
  void showItem(0);
}

function togglePause() {
  if (!playing) return;
  paused = !paused;
  paintPause();
  $("viewMeta").textContent = metaBase + modeSuffix();
  if (paused) clearTimeout(playTimer);
  else queueAdvance(viewed()[viewing]);
}

function showViewer() {
  $("view").hidden = false;
  wake();
}

function openViewer(index: number) {
  playlist = null;
  showViewer();
  void showItem(index);
}

function closeViewer() {
  stopSlideshow();
  cancelDelete();
  $("viewHelp").hidden = true;
  playlist = null;
  clearTimeout(idleTimer);
  $("view").hidden = true;
  $("viewStage").replaceChildren();
  viewing = -1;
  if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
  if (gridStale) {
    gridStale = false;
    void apply();
  }
}

function step(delta: number) {
  if (viewing >= 0 && !confirming) void showItem(viewing + delta);
}

async function saveViewed() {
  const row = viewed()[viewing];
  await chrome.downloads.download({url: await savedCopy(row.saved) ?? row.open, filename: fileName(row), conflictAction: "uniquify", saveAs: false}).catch(() => undefined);
}

/** D: asks first, naming exactly what goes — the file and its Downloads copy, or the history entry. */
function askDelete() {
  if (viewing < 0 || confirming) return;
  confirming = true;
  if (playing && !paused) togglePause();
  const row = viewed()[viewing], what = view === "seen" && !playlist ? "Remove this from the history" : "Delete this file from this device and Downloads";
  const box = $("viewConfirm");
  box.innerHTML = `<span>${what}: <b>${escapeHtml(shortName(row.saved))}</b>?</span>`
    + `<button type="button" class="button danger" data-confirm="yes">Delete · Enter</button>`
    + `<button type="button" class="button ghost" data-confirm="no">Keep · Esc</button>`;
  box.hidden = false;
  wake();
}

function cancelDelete() {
  confirming = false;
  $("viewConfirm").hidden = true;
}

/** Enter: deletes what was asked about, then shows the next one (or closes when nothing is left). */
async function confirmDelete() {
  if (!confirming) return;
  cancelDelete();
  const row = viewed()[viewing], fromHistory = view === "seen" && !playlist;
  if (fromHistory) {
    await chrome.runtime.sendMessage({type: "LINKPEEK_HISTORY_REMOVE", entries: [{a: row.at, o: row.open}]}).catch(() => undefined);
    seenRows = seenRows.filter(other => other !== row);
  } else {
    await chrome.runtime.sendMessage({type: "LINKPEEK_LIBRARY_REMOVE", urls: [row.saved]}).catch(() => undefined);
    savedRows = savedRows.filter(other => other !== row);
  }
  for (const list of [shown, playlist]) {
    const at = list?.indexOf(row) ?? -1;
    if (at >= 0) list!.splice(at, 1);
  }
  gridStale = true;
  const list = viewed();
  if (!list.length) {
    closeViewer();
    $("summary").textContent = fromHistory ? "Removed from the history" : "Deleted, Downloads copy included";
    return;
  }
  await showItem(Math.min(viewing, list.length - 1));
}

/** B: stars or unstars the file on screen. Favourites are kept whatever happens: never trimmed for space, never removed by the size check. */
async function toggleFavorite() {
  if (viewing < 0) return;
  const row = viewed()[viewing];
  if (favorites.has(row.saved)) favorites.delete(row.saved);
  else favorites.add(row.saved);
  paintFavorite(row);
  gridStale = true;
  await chrome.storage.local.set({[FAVORITE_MEDIA]: [...favorites]}).catch(() => undefined);
}

/** F: the viewer alone on screen, or back. */
function toggleFullscreen() {
  if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
  else void $("view").requestFullscreen?.().catch(() => undefined);
}

function onKey(event: KeyboardEvent) {
  if (viewing < 0) {
    const menu = $("more") as HTMLDetailsElement;
    if (event.key === "Escape" && menu.open) {
      menu.open = false;
      event.preventDefault();
    } else if (event.key === "Escape" && tagsOpen) {
      tagsOpen = false;
      renderTags();
      event.preventDefault();
    } else if (event.key === "Escape" && selecting) {
      exitSelecting();
      event.preventDefault();
    }
    return;
  }
  // Ctrl, Cmd and Alt combinations stay the browser's own (Ctrl + and Ctrl - zoom the page).
  if (event.ctrlKey || event.metaKey || event.altKey) return;
  wake();
  if (confirming) {
    if (event.key === "Enter") void confirmDelete();
    else if (event.key === "Escape") cancelDelete();
    else return;
    event.preventDefault();
    return;
  }
  const help = $("viewHelp");
  if (!help.hidden) {
    help.hidden = true;
    event.preventDefault();
    return;
  }
  const moves: Record<string, number> = {ArrowRight: 1, ArrowDown: 1, " ": 1, ArrowLeft: -1, ArrowUp: -1};
  const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
  if (key === " " && playing) togglePause();
  else if (key === "Escape") closeViewer();
  else if (key === "+" || key === "=") zoomBy(ZOOM_STEP);
  else if (key === "-" || key === "_") zoomBy(1 / ZOOM_STEP);
  else if (key === "0") zoom.reset();
  else if (key === "d" || key === "Delete") askDelete();
  else if (key === "b") void toggleFavorite();
  else if (key === "f") toggleFullscreen();
  else if (key === "?") help.hidden = false;
  else if (key in moves) step(moves[key]);
  else return;
  event.preventDefault();
}

/** Scroll steps through; Ctrl+scroll (and a trackpad pinch, which arrives as one) zooms at the pointer. */
function onWheel(event: WheelEvent) {
  if (viewing < 0) return;
  event.preventDefault();
  wake();
  if (event.ctrlKey) {
    if (event.deltaY) zoomBy(Math.exp(-event.deltaY * 0.0025), event.clientX, event.clientY);
    return;
  }
  if (Date.now() - lastWheel < WHEEL_STEP_MS || !event.deltaY) return;
  lastWheel = Date.now();
  step(event.deltaY > 0 ? 1 : -1);
}

/**
 * Zoomed media is dragged to pan. A press that barely moves is a click: on a
 * zoomed video it plays or pauses it (its own controls are hidden while
 * zoomed); on the empty stage of fitted media it closes the viewer.
 */
function bindStage() {
  const stage = $("viewStage");
  let drag: {x: number; y: number; moved: number} | undefined;
  stage.addEventListener("pointerdown", event => {
    if (event.button !== 0 || !zoom.zoomed) return;
    drag = {x: event.clientX, y: event.clientY, moved: 0};
    stage.setPointerCapture?.(event.pointerId);
    event.preventDefault();
  });
  stage.addEventListener("pointermove", event => {
    if (!drag) return;
    const dx = event.clientX - drag.x, dy = event.clientY - drag.y;
    drag = {x: event.clientX, y: event.clientY, moved: drag.moved + Math.abs(dx) + Math.abs(dy)};
    zoom.panBy(dx, dy);
  });
  stage.addEventListener("pointerup", event => {
    const press = drag;
    drag = undefined;
    if (!press || press.moved > 4) return;
    const video = (event.target as Element).closest("video");
    if (video) void (video.paused ? video.play().catch(() => undefined) : video.pause());
  });
  stage.addEventListener("pointercancel", () => drag = undefined);
  stage.addEventListener("dblclick", event => {
    if (playing && !paused && !zoom.zoomed) togglePause();
    zoom.toggle(event.clientX, event.clientY);
  });
  stage.addEventListener("click", event => {
    if (event.target === stage && !zoom.zoomed) closeViewer();
  });
}

/** The view and filter in the address, so the popup and the inspector can open "what was preloaded" directly. */
function readAddress() {
  const params = new URLSearchParams(location.search);
  view = params.get("view") === "saved" ? "saved" : "seen";
  const wanted = params.get("filter");
  filter = wanted === "unseen" || wanted === "seen" ? wanted : "all";
  const media = params.get("media");
  kind = media === "gif" || media === "video" || media === "image" ? media : "all";
  favoritesOnly = params.get("fav") === "1";
  const order = params.get("sort");
  sort = order === "oldest" || order === "title" || order === "largest" ? order : "newest";
  activeTags = (params.get("tag") ?? "").split(",").map(part => part.trim()).filter(Boolean);
  tagMode = params.get("match") === "any" ? "any" : "all";
}

function writeAddress() {
  const params = new URLSearchParams();
  if (view === "saved") params.set("view", "saved");
  if (view === "saved" && filter !== "all") params.set("filter", filter);
  if (kind !== "all") params.set("media", kind);
  if (favoritesOnly) params.set("fav", "1");
  if (sort !== "newest") params.set("sort", sort);
  if (activeTags.length) params.set("tag", activeTags.join(","));
  if (activeTags.length > 1 && tagMode === "any") params.set("match", "any");
  history.replaceState(null, "", `${location.pathname}${params.size ? `?${params}` : ""}`);
}

/**
 * Wires every control. It runs before any data is read or drawn, so a click
 * the moment a tile appears opens the viewer instead of falling through to
 * the tile's link.
 */
function wire() {
  zoom = new ZoomPan($("viewStage"), () => $("viewStage").querySelector<HTMLElement>("img, video"), paintZoom);
  new IntersectionObserver(entries => {
    if (entries.some(entry => entry.isIntersecting) && rendered < shown.length) void renderMore();
  }, {rootMargin: "800px 0px"}).observe($("more"));
  $("search").addEventListener("input", () => void apply());
  $("clear").addEventListener("click", () => void clearView());
  $("audit").addEventListener("click", () => void auditSaved());
  $("play").addEventListener("click", startSlideshow);
  $("select").addEventListener("click", () => selecting ? exitSelecting() : enterSelecting());
  $("selAll").addEventListener("click", () => {
    for (const row of shown) chosen.add(row);
    paintSelection();
  });
  $("selCancel").addEventListener("click", exitSelecting);
  $("selSave").addEventListener("click", () => void saveChosen());
  $("selDelete").addEventListener("click", () => void deleteChosen());
  chrome.runtime.onMessage.addListener((msg: {type?: string}) => {
    if (msg?.type === "LINKPEEK_AUDIT_TICK") onAuditTick(msg as AuditTickMessage);
    return false;
  });
  $("sort").addEventListener("change", () => {
    sort = ($("sort") as HTMLSelectElement).value as Sort;
    writeAddress();
    void apply();
  });
  const onTagClick = (event: Event) => {
    if ((event.target as Element).closest("#tagsMore")) {
      tagsOpen = !tagsOpen;
      renderTags();
      return;
    }
    if ((event.target as Element).closest("#tagMode")) {
      tagMode = tagMode === "all" ? "any" : "all";
      writeAddress();
      void apply();
      return;
    }
    const button = (event.target as Element).closest<HTMLElement>("[data-tag]");
    if (!button) return;
    const key = button.dataset.tag!;
    activeTags = activeTags.includes(key) ? activeTags.filter(active => active !== key) : [...activeTags, key];
    writeAddress();
    void apply();
  };
  $("tags").addEventListener("click", onTagClick);
  $("tagsAll").addEventListener("click", onTagClick);
  $("tagsFind").addEventListener("input", renderAllTags);
  // The ⋯ menu closes on a click outside it, like any menu.
  document.addEventListener("click", event => {
    const menu = $("more") as HTMLDetailsElement;
    if (menu.open && !menu.contains(event.target as Node)) menu.open = false;
  });
  const onChip = (event: Event) => {
    const button = (event.target as Element).closest<HTMLElement>("[data-show],[data-filter],[data-kind],[data-fav]");
    if (!button) return;
    if (button.dataset.show) {
      view = button.dataset.show as View;
      // The seen view cannot order by size, and a selection made in one view means nothing in the other.
      if (view === "seen" && sort === "largest") sort = "newest";
      exitSelecting();
    } else if (button.dataset.kind) kind = button.dataset.kind as Kind;
    else if (button.hasAttribute("data-fav")) favoritesOnly = !favoritesOnly;
    else filter = button.dataset.filter as Filter;
    writeAddress();
    void apply();
  };
  document.querySelector(".history-head")!.addEventListener("click", onChip);
  document.querySelector(".h-toolbar")!.addEventListener("click", onChip);
  /**
   * Hover play: a GIF tile swaps its still for the animation (with "play GIFs
   * only on hover" on), and a video tile plays, muted and looping, over its
   * still (with "play videos on hover" on). Leaving puts the still back. The
   * pointer may leave while the file is still being read, so a tile only
   * starts playing if it is still hovered when the file is ready.
   */
  const hoverPlay = async (tile: HTMLElement, live: boolean) => {
    const row = shown[Number(tile.dataset.row)];
    const wanted = row && ((row.type === "gif" && settings.libraryGifHover) || (row.type === "video" && settings.libraryVideoHover));
    if (!wanted) return;
    const img = tile.querySelector("img"), media = tile.querySelector<HTMLElement>(".h-media")!;
    if (!live) {
      delete tile.dataset.hover;
      media.querySelector(".h-hoverplay")?.remove();
      if (img?.dataset.still) {
        img.src = img.dataset.still;
        delete img.dataset.still;
      }
      return;
    }
    if (tile.dataset.hover) return;
    tile.dataset.hover = "1";
    const source = await savedCopy(row.saved) ?? row.open;
    if (!tile.dataset.hover) return;
    if (row.type === "video") {
      // Muted as a property, not just an attribute: that is what lets the browser autoplay it.
      const video = Object.assign(document.createElement("video"), {className: "h-hoverplay", src: source, muted: true, loop: true, playsInline: true, autoplay: true});
      media.prepend(video);
    } else if (img) {
      img.dataset.still = img.src;
      img.src = source;
    }
  };
  for (const [name, live] of [["mouseover", true], ["mouseout", false]] as const) {
    $("days").addEventListener(name, event => {
      const tile = (event.target as Element).closest<HTMLElement>(".h-tile");
      if (tile && !tile.contains((event as MouseEvent).relatedTarget as Node)) void hoverPlay(tile, live);
    });
  }
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
    const target = event.target as Element, action = target.closest<HTMLElement>("[data-view]")?.dataset.view;
    const answer = target.closest<HTMLElement>("[data-confirm]")?.dataset.confirm;
    if (answer) void (answer === "yes" ? confirmDelete() : cancelDelete());
    else if (action === "close" || target === $("view")) closeViewer();
    else if (action) step(action === "next" ? 1 : -1);
  });
  $("view").addEventListener("pointermove", wake);
  $("viewPause").addEventListener("click", togglePause);
  $("viewZoom").addEventListener("click", () => zoom.reset());
  $("viewFav").addEventListener("click", () => void toggleFavorite());
  $("viewDelete").addEventListener("click", askDelete);
  $("viewFull").addEventListener("click", toggleFullscreen);
  $("viewKeys").addEventListener("click", () => $("viewHelp").hidden = !$("viewHelp").hidden);
  bindStage();
  // The mouse's back and forward buttons step through, like in the preview.
  $("view").addEventListener("mouseup", event => {
    if (event.button === 3 || event.button === 4) step(event.button === 4 ? 1 : -1);
  });
  $("viewSave").addEventListener("click", () => void saveViewed());
  document.addEventListener("keydown", onKey);
  $("view").addEventListener("wheel", onWheel, {passive: false});
}

async function start() {
  clearStep = new TwoStep($("clear"), () => view === "seen" ? "Clear history" : "Delete saved files", () => {
    $("summary").textContent = summary();
  });
  readAddress();
  // The preview size is a taste, remembered on this device.
  const tileSize = $("tileSize") as HTMLInputElement;
  tileSize.value = String(Number(localStorage.getItem("libraryTile")) || 220);
  $("days").style.setProperty("--tile", `${tileSize.value}px`);
  tileSize.addEventListener("input", () => {
    $("days").style.setProperty("--tile", `${tileSize.value}px`);
    localStorage.setItem("libraryTile", tileSize.value);
  });
  // Every control works from the first frame: wired before anything is awaited or drawn.
  wire();
  settings = await loadSettings().catch(() => DEFAULT_SETTINGS);
  const stored = (await chrome.storage.local.get(FAVORITE_MEDIA).catch(() => ({})) as Record<string, unknown>)[FAVORITE_MEDIA];
  favorites = new Set(Array.isArray(stored) ? stored.filter((url): url is string => typeof url === "string") : []);
  void seenMedia.load();
  [seenRows, savedRows] = await Promise.all([
    readHistory().then(entries => entries.map(rowFromHistory)).catch(() => []),
    readLibrary().then(entries => entries.map(rowFromLibrary)).catch(() => [])
  ]);
  await computeTags();
  await apply();
}

void start();
