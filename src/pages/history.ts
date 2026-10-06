/**
 * The history page: everything LinkPeek has shown, newest first, grouped by
 * day, and the files kept on this device.
 *
 * Thumbnails come from the saved copies when there are any, so the page works
 * offline; the list grows as you scroll and search filters it. Clicking an
 * item opens it full size (arrows, scroll or the mouse's side buttons move
 * through, Escape closes). "Save all to Downloads" writes every saved file into
 * a LinkPeek Library folder, named by when it was seen.
 */
import {escapeHtml} from "../shared/dom";
import {LIBRARY_CACHE, readHistory, savedUrlOf, type HistoryEntry} from "../shared/history";
import {linkLabel, safeDownloadName} from "../shared/media";

/** Entries rendered per step as the list scrolls. */
const PAGE = 240;
const CONFIRM_MS = 3000;
const WHEEL_STEP_MS = 220;

const $ = (id: string) => document.getElementById(id)!;
let all: HistoryEntry[] = [];
let shown: HistoryEntry[] = [];
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

/** The saved copy of an entry as an object URL, or undefined when none is kept. */
async function savedCopy(entry: HistoryEntry) {
  const url = savedUrlOf(entry);
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

function tile(entry: HistoryEntry, index: number) {
  const title = entry.n || linkLabel(entry.s), badge = entry.t === "image" ? "" : `<span class="h-badge">${entry.t === "gif" ? "GIF" : "▶"}</span>`;
  const picture = entry.p ? `<img data-src="${escapeHtml(entry.p)}" alt="" decoding="async">` : `<span class="h-none">${entry.t === "video" ? "Video" : "No preview"}</span>`;
  return `<figure class="h-tile"><a class="h-media" href="${escapeHtml(entry.o)}" target="_blank" rel="noopener" data-index="${index}" title="Open">${picture}${badge}</a>`
    + `<figcaption><a href="${escapeHtml(entry.s)}" target="_blank" rel="noopener" title="${escapeHtml(entry.s)}">${escapeHtml(title)}</a>`
    + `<time datetime="${new Date(entry.a).toISOString()}">${new Date(entry.a).toLocaleTimeString(undefined, {hour: "2-digit", minute: "2-digit"})}</time></figcaption></figure>`;
}

/** Shows each new thumbnail (still holding data-src) from its saved copy when there is one, else from the web. */
async function fillThumbnails() {
  for (const image of document.querySelectorAll<HTMLImageElement>("img[data-src]")) {
    const entry = shown[Number(image.closest<HTMLElement>("[data-index]")!.dataset.index)], network = image.dataset.src!;
    image.removeAttribute("data-src");
    // A picture's saved copy is its thumbnail; a GIF's or video's is the original, too heavy for a tile.
    image.src = (entry.t === "image" ? await savedCopy(entry) : undefined) ?? network;
  }
}

/** Renders the next page of entries, starting a new day heading where the day changes. */
function renderMore() {
  const days = $("days"), start = rendered, next = shown.slice(rendered, rendered + PAGE);
  let grid = days.lastElementChild?.querySelector(".h-grid") ?? null, lastDay = days.lastElementChild?.getAttribute("data-day") ?? "";
  const pieces: string[] = [];
  next.forEach((entry, offset) => {
    const label = dayLabel(entry.a);
    if (label !== lastDay) {
      // A heading always exists before any tile, so a pending run belongs to the grid being left.
      if (pieces.length) grid!.insertAdjacentHTML("beforeend", pieces.splice(0).join(""));
      days.insertAdjacentHTML("beforeend", `<section class="h-day" data-day="${escapeHtml(label)}"><h2>${escapeHtml(label)}</h2><div class="h-grid"></div></section>`);
      grid = days.lastElementChild!.querySelector(".h-grid");
      lastDay = label;
    }
    pieces.push(tile(entry, start + offset));
  });
  if (pieces.length) grid!.insertAdjacentHTML("beforeend", pieces.join(""));
  rendered += next.length;
  return fillThumbnails();
}

function summary() {
  const total = all.length, query = ($("search") as HTMLInputElement).value.trim();
  if (!total) return "Nothing here yet. What you open in LinkPeek appears here, newest first.";
  if (query) return `${shown.length.toLocaleString()} of ${total.toLocaleString()} match “${query}”`;
  return `${total.toLocaleString()} item${total === 1 ? "" : "s"}, newest first`;
}

function apply() {
  const words = ($("search") as HTMLInputElement).value.trim().toLowerCase().split(/\s+/).filter(Boolean);
  shown = words.length ? all.filter(entry => {
    const text = `${entry.n ?? ""} ${entry.s} ${entry.o}`.toLowerCase();
    return words.every(word => text.includes(word));
  }) : all;
  rendered = 0;
  $("days").replaceChildren();
  $("summary").textContent = summary();
  return renderMore();
}

/** A button that asks for a second press within a few seconds; only the second one acts. */
class TwoStep {
  private until = 0;

  constructor(private button: HTMLElement, private idle: string) {}

  confirm(ask: string) {
    if (Date.now() <= this.until) {
      this.until = 0;
      this.button.textContent = this.idle;
      return true;
    }
    const until = this.until = Date.now() + CONFIRM_MS;
    this.button.textContent = ask;
    setTimeout(() => {
      if (this.until !== until) return;
      this.until = 0;
      this.button.textContent = this.idle;
    }, CONFIRM_MS);
    return false;
  }
}

let clearStep: TwoStep, saveStep: TwoStep;

async function clearHistory() {
  if (!clearStep.confirm("Press again to clear")) return;
  await chrome.runtime.sendMessage({type: "LINKPEEK_HISTORY_CLEAR"});
  all = [];
  await apply();
}

/** The file name a saved item gets in Downloads: when it was seen, then its own name, so the folder sorts in order. */
function fileName(entry: HistoryEntry) {
  const at = new Date(entry.a), pad = (value: number) => String(value).padStart(2, "0");
  const day = `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
  return `LinkPeek Library/${day}/${pad(at.getHours())}.${pad(at.getMinutes())}.${pad(at.getSeconds())} ${safeDownloadName({originalUrl: savedUrlOf(entry)})}`;
}

async function saveAll() {
  const saved = (await Promise.all(all.map(async entry => ({entry, url: await savedCopy(entry)})))).filter(item => item.url);
  if (!saved.length) {
    $("summary").textContent = "Nothing is saved on this device yet. Turn on Settings → Privacy → Save what you see.";
    return;
  }
  if (!saveStep.confirm(`Press again to save ${saved.length.toLocaleString()} files`)) return;
  let done = 0;
  for (const {entry, url} of saved) {
    await chrome.downloads.download({url: url!, filename: fileName(entry), conflictAction: "uniquify", saveAs: false}).catch(() => undefined);
    $("summary").textContent = `Saving to Downloads / LinkPeek Library… ${++done} of ${saved.length}`;
  }
  $("summary").textContent = `Saved ${saved.length.toLocaleString()} files to Downloads / LinkPeek Library`;
}

// ---- The full-size viewer ----

async function showItem(index: number) {
  viewing = (index + shown.length) % shown.length;
  const entry = shown[viewing], copy = await savedCopy(entry);
  if (shown[viewing] !== entry) return;
  // The saved copy works offline; without one, the original from the web.
  const source = copy ?? entry.o, stage = $("viewStage");
  stage.innerHTML = entry.t === "video"
    ? `<video src="${escapeHtml(source)}" controls autoplay loop playsinline></video>`
    : `<img src="${escapeHtml(source)}" alt="">`;
  const title = $("viewTitle") as HTMLAnchorElement;
  title.textContent = entry.n || linkLabel(entry.s);
  title.href = entry.s;
  ($("viewOriginal") as HTMLAnchorElement).href = entry.o;
  $("viewMeta").textContent = `${viewing + 1} of ${shown.length} · ${new Date(entry.a).toLocaleString()}${copy ? " · saved on this device" : ""}`;
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
  const entry = shown[viewing];
  await chrome.downloads.download({url: await savedCopy(entry) ?? entry.o, filename: fileName(entry), conflictAction: "uniquify", saveAs: false}).catch(() => undefined);
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

async function start() {
  clearStep = new TwoStep($("clear"), "Clear history");
  saveStep = new TwoStep($("saveAll"), "Save all to Downloads");
  all = await readHistory().catch(() => []);
  await apply();
  new IntersectionObserver(entries => {
    if (entries.some(entry => entry.isIntersecting) && rendered < shown.length) void renderMore();
  }, {rootMargin: "800px 0px"}).observe($("more"));
  $("search").addEventListener("input", () => void apply());
  $("clear").addEventListener("click", () => void clearHistory());
  $("saveAll").addEventListener("click", () => void saveAll());
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
  if (stats?.count) $("saveAll").title = `${stats.count.toLocaleString()} files kept on this device (${(stats.bytes! / 1024 / 1024).toFixed(0)} MB) · save them all into Downloads / LinkPeek Library`;
}

void start();
