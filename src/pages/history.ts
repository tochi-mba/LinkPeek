/**
 * The history page: everything LinkPeek has shown, newest first, grouped by
 * day. Thumbnails load lazily and the list grows as you scroll, so tens of
 * thousands of entries stay quick. Search filters by title and address.
 */
import {escapeHtml} from "../shared/dom";
import {readHistory, type HistoryEntry} from "../shared/history";
import {linkLabel} from "../shared/media";

/** Entries rendered per step as the list scrolls. */
const PAGE = 240;
const CONFIRM_MS = 3000;

const $ = (id: string) => document.getElementById(id)!;
let all: HistoryEntry[] = [];
let shown: HistoryEntry[] = [];
let rendered = 0;
let clearArmedUntil = 0;

function dayLabel(at: number, now = new Date()) {
  const day = new Date(at), today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const start = new Date(day.getFullYear(), day.getMonth(), day.getDate()).getTime();
  if (start === today) return "Today";
  if (start === today - 86_400_000) return "Yesterday";
  return day.toLocaleDateString(undefined, {weekday: "long", day: "numeric", month: "long", year: day.getFullYear() === now.getFullYear() ? undefined : "numeric"});
}

function tile(entry: HistoryEntry) {
  const title = entry.n || linkLabel(entry.s), badge = entry.t === "image" ? "" : `<span class="h-badge">${entry.t === "gif" ? "GIF" : "▶"}</span>`;
  const picture = entry.p ? `<img src="${escapeHtml(entry.p)}" alt="" loading="lazy" decoding="async">` : `<span class="h-none">${entry.t === "video" ? "Video" : "No preview"}</span>`;
  return `<figure class="h-tile"><a class="h-media" href="${escapeHtml(entry.o)}" target="_blank" rel="noopener" title="Open the original">${picture}${badge}</a>`
    + `<figcaption><a href="${escapeHtml(entry.s)}" target="_blank" rel="noopener" title="${escapeHtml(entry.s)}">${escapeHtml(title)}</a>`
    + `<time datetime="${new Date(entry.a).toISOString()}">${new Date(entry.a).toLocaleTimeString(undefined, {hour: "2-digit", minute: "2-digit"})}</time></figcaption></figure>`;
}

/** Renders the next page of entries, starting a new day heading where the day changes. */
function renderMore() {
  const days = $("days"), next = shown.slice(rendered, rendered + PAGE);
  let grid = days.lastElementChild?.querySelector(".h-grid") ?? null, lastDay = days.lastElementChild?.getAttribute("data-day") ?? "";
  const pieces: string[] = [];
  for (const entry of next) {
    const label = dayLabel(entry.a);
    if (label !== lastDay) {
      // A heading always exists before any tile, so a pending run belongs to the grid being left.
      if (pieces.length) grid!.insertAdjacentHTML("beforeend", pieces.splice(0).join(""));
      days.insertAdjacentHTML("beforeend", `<section class="h-day" data-day="${escapeHtml(label)}"><h2>${escapeHtml(label)}</h2><div class="h-grid"></div></section>`);
      grid = days.lastElementChild!.querySelector(".h-grid");
      lastDay = label;
    }
    pieces.push(tile(entry));
  }
  if (pieces.length) grid!.insertAdjacentHTML("beforeend", pieces.join(""));
  rendered += next.length;
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
  renderMore();
}

async function clearHistory() {
  const button = $("clear") as HTMLButtonElement;
  if (Date.now() > clearArmedUntil) {
    clearArmedUntil = Date.now() + CONFIRM_MS;
    button.textContent = "Press again to clear";
    setTimeout(() => {
      if (Date.now() >= clearArmedUntil) button.textContent = "Clear history";
    }, CONFIRM_MS);
    return;
  }
  clearArmedUntil = 0;
  await chrome.runtime.sendMessage({type: "LINKPEEK_HISTORY_CLEAR"});
  button.textContent = "Clear history";
  all = [];
  apply();
}

async function start() {
  all = await readHistory().catch(() => []);
  apply();
  new IntersectionObserver(entries => {
    if (entries.some(entry => entry.isIntersecting) && rendered < shown.length) renderMore();
  }, {rootMargin: "800px 0px"}).observe($("more"));
  $("search").addEventListener("input", apply);
  $("clear").addEventListener("click", () => void clearHistory());
}

void start();
