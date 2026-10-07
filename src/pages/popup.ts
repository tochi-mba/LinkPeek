/** The toolbar popup: on/off, this site, performance and opening style at a glance, and saved links. */
import {escapeHtml} from "../shared/dom";
import {loadFavorites, removeFavorite} from "../shared/favorites";
import {tumblrBlogFrom} from "../core/tumblr";
import type {TabStatus, TumblrJobState} from "../shared/messages";
import {loadSettings, saveSettings, siteProfileFor, type LinkPeekSettings} from "../shared/settings";

let settings: LinkPeekSettings;
let host = "";
let status: TabStatus | undefined;
let tabId: number | undefined;
let tumblrBlog: string | undefined;
let tumblrJob: TumblrJobState | undefined;
let tumblrStopping = false;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

function pausedHere() {
  return Boolean(host) && siteProfileFor(settings.siteProfiles, host)?.enabled === false;
}

/** One line describing what LinkPeek is doing on this tab right now. */
function statusLine(): string {
  if (!host) return "Previews work on web pages.";
  if (!settings.enabled) return "LinkPeek is off.";
  if (pausedHere()) return "Paused on this site.";
  if (!status) return "Reload this page to start previews here.";
  const ready = `${status.prepared} link${status.prepared === 1 ? "" : "s"} ready`;
  if (status.reason) return `${ready} · easing off: ${status.reason}`;
  return `${ready} · running at full speed on this ${status.tier} device`;
}

function renderSegments(name: "mode" | "open", value: string) {
  document.querySelectorAll<HTMLButtonElement>(`[data-${name}]`).forEach(button => {
    const active = button.dataset[name] === value;
    button.classList.toggle("active", active);
    button.setAttribute("aria-checked", String(active));
  });
}

function tumblrProgress(job: TumblrJobState) {
  const share = job.collected
    ? 0.5 + 0.5 * (job.saved + job.failed) / Math.max(1, job.found)
    : 0.5 * job.posts / Math.max(1, job.total);
  return Math.min(100, Math.floor(share * 100));
}

function tumblrStatus(job: TumblrJobState | undefined) {
  if (!job) return "Save every original image, GIF, video and audio from this blog to Downloads.";
  const files = job.found ? `${job.saved} of ${job.found} files saved` : "no media found yet";
  const skipped = job.skipped ? ` · ${job.skipped} already downloaded` : "";
  const failed = job.failed ? ` · ${job.failed} failed` : "";
  if (job.phase === "failed") return `Couldn't finish: ${job.error ?? "Tumblr stopped responding"}. ${files}${failed}`;
  if (job.phase === "done") return `Done · ${files}${skipped}${failed}`;
  if (job.phase === "stopped") return `Stopped · ${files}${skipped}${failed}`;
  if (tumblrStopping) return `Stopping… ${files}`;
  if (job.collected) return `All posts checked · finishing downloads · ${files}${failed}`;
  const posts = job.total ? `${job.posts} of ${job.total}` : String(job.posts);
  return `Checking post ${posts} · ${files}${skipped}${failed}`;
}

function renderTumblr() {
  const card = $<HTMLElement>("tumblrCard");
  card.hidden = !tumblrBlog;
  if (!tumblrBlog) return;
  const job = tumblrJob?.blog === tumblrBlog || tumblrJob?.phase === "collecting" ? tumblrJob : undefined;
  $("tumblrBlog").textContent = job && job.blog !== tumblrBlog ? `@${job.blog}` : `@${tumblrBlog}`;
  $("tumblrStatus").textContent = tumblrStatus(job);
  const progress = $<HTMLProgressElement>("tumblrProgress");
  progress.hidden = !job || job.phase !== "collecting";
  progress.value = job ? tumblrProgress(job) : 0;
  const action = $<HTMLButtonElement>("tumblrAction");
  action.disabled = tumblrStopping;
  action.textContent = job?.phase === "collecting" ? (tumblrStopping ? "Stopping…" : "Stop")
    : job?.phase === "done" ? "Check for new media"
      : job ? "Continue download" : "Download all media";
}

function render() {
  ($("enabled") as HTMLInputElement).checked = settings.enabled;
  $("site").textContent = host || "Not a web page";
  $("status").textContent = statusLine();
  const pause = $("pauseSite") as HTMLButtonElement, inspector = $("inspector") as HTMLButtonElement;
  pause.hidden = !host;
  pause.textContent = pausedHere() ? "Resume here" : "Pause here";
  // The inspector lives in the page, so it needs a page whose script answered.
  inspector.hidden = !status;
  ($("shuffle") as HTMLButtonElement).hidden = !status?.enabled || !settings.shuffleSlideshow;
  inspector.textContent = status?.inspectorOpen ? "Hide inspector" : "Inspector";
  inspector.setAttribute("aria-pressed", String(Boolean(status?.inspectorOpen)));
  renderTumblr();
  renderSegments("mode", settings.performanceMode);
  renderSegments("open", settings.activationMode);
}

async function renderFavorites() {
  const favorites = await loadFavorites();
  $("favoriteCount").textContent = String(favorites.length);
  $("favorites").innerHTML = favorites.length
    ? favorites.map((favorite, i) => `<div class="favorite-row"><button type="button" class="favorite-open" data-open-favorite="${i}" title="${escapeHtml(favorite.url)}"><strong>${escapeHtml(favorite.title)}</strong><small>${escapeHtml(new URL(favorite.url).hostname)}${favorite.mediaCount != null ? ` · ${favorite.mediaCount} media` : ""}</small></button><button type="button" class="favorite-remove" data-remove-favorite="${i}" aria-label="Remove ${escapeHtml(favorite.title)}">×</button></div>`).join("")
    : `<div class="favorite-empty">No saved links yet. Press B while previewing to save one.</div>`;
  document.querySelectorAll<HTMLElement>("[data-open-favorite]").forEach(el => el.addEventListener("click", () => {
    void chrome.tabs.create({url: favorites[Number(el.dataset.openFavorite)].url});
  }));
  document.querySelectorAll<HTMLElement>("[data-remove-favorite]").forEach(el => el.addEventListener("click", async () => {
    await removeFavorite(favorites[Number(el.dataset.removeFavorite)].url);
    await renderFavorites();
  }));
}

async function save() {
  await saveSettings(settings);
  render();
}

async function togglePause() {
  const sites = {...settings.siteProfiles}, rule = {...sites[host]};
  if (pausedHere()) {
    delete rule.enabled;
    if (Object.keys(rule).length) sites[host] = rule;
    else delete sites[host];
    // A wildcard rule may also pause this host; an explicit rule resumes it.
    if (siteProfileFor(sites, host)?.enabled === false) sites[host] = {...rule, enabled: true};
  } else {
    sites[host] = {...rule, enabled: false};
  }
  settings = {...settings, siteProfiles: sites};
  await save();
}

async function toggleInspector() {
  const answer = await chrome.tabs.sendMessage(tabId!, {type: "LINKPEEK_TOGGLE_INSPECTOR"}).catch(() => undefined) as {open: boolean} | undefined;
  if (!answer || !status) return;
  status = {...status, inspectorOpen: answer.open};
  render();
  if (answer.open) window.close();
}

/** Opens (or closes) the mirror window, previews' second screen, and gets out of the way. */
async function openMirror() {
  await chrome.runtime.sendMessage({type: "LINKPEEK_TOGGLE_MIRROR"}).catch(() => undefined);
  window.close();
}

/** Starts the shuffle on the page and gets out of the way. */
async function startShuffle() {
  const answer = await chrome.tabs.sendMessage(tabId!, {type: "LINKPEEK_START_SHUFFLE"}).catch(() => undefined) as {started: boolean} | undefined;
  if (answer) window.close();
}

async function toggleTumblrDownload() {
  if (!tumblrBlog) return;
  if (tumblrJob?.phase === "collecting") {
    tumblrStopping = true;
    renderTumblr();
    await chrome.runtime.sendMessage({type: "LINKPEEK_TUMBLR_STOP"}).catch(() => undefined);
    return;
  }
  tumblrStopping = false;
  tumblrJob = await chrome.runtime.sendMessage({type: "LINKPEEK_TUMBLR_START", blog: tumblrBlog}).catch(() => undefined) as TumblrJobState | undefined;
  renderTumblr();
}

async function start() {
  settings = await loadSettings();
  const [tab] = await chrome.tabs.query({active: true, currentWindow: true});
  if (tab?.url?.startsWith("http")) {
    host = new URL(tab.url).hostname;
    tumblrBlog = tumblrBlogFrom(tab.url);
    tabId = tab.id;
    status = await chrome.tabs.sendMessage(tab.id!, {type: "LINKPEEK_STATUS"}).catch(() => undefined) as TabStatus | undefined;
  }
  if (tumblrBlog) tumblrJob = await chrome.runtime.sendMessage({type: "LINKPEEK_TUMBLR_STATUS"}).catch(() => undefined) as TumblrJobState | undefined;
  render();
  const mirror = await chrome.runtime.sendMessage({type: "LINKPEEK_MIRROR_QUERY"}).catch(() => undefined) as {open?: boolean} | undefined;
  if (mirror?.open) $("mirror").textContent = "Close mirror";
  await renderFavorites();
}

$("enabled").addEventListener("change", event => {
  settings = {...settings, enabled: (event.target as HTMLInputElement).checked};
  void save();
});
$("pauseSite").addEventListener("click", () => void togglePause());
$("inspector").addEventListener("click", () => void toggleInspector());
$("mirror").addEventListener("click", () => void openMirror());
$("shuffle").addEventListener("click", () => void startShuffle());
$("tumblrAction").addEventListener("click", () => void toggleTumblrDownload());
document.querySelectorAll<HTMLButtonElement>("[data-mode]").forEach(button => button.addEventListener("click", () => {
  settings = {...settings, performanceMode: button.dataset.mode as LinkPeekSettings["performanceMode"]};
  void save();
}));
document.querySelectorAll<HTMLButtonElement>("[data-open]").forEach(button => button.addEventListener("click", () => {
  settings = {...settings, activationMode: button.dataset.open as LinkPeekSettings["activationMode"]};
  void save();
}));
$("options").addEventListener("click", () => void chrome.runtime.openOptionsPage());
$("practice").addEventListener("click", event => {
  event.preventDefault();
  void chrome.tabs.create({url: chrome.runtime.getURL("onboarding.html")});
});
$("history").addEventListener("click", () => void chrome.tabs.create({url: chrome.runtime.getURL("history.html")}));
$("preloaded").addEventListener("click", () => void chrome.tabs.create({url: chrome.runtime.getURL("history.html?view=saved&filter=unseen")}));
$("clear").addEventListener("click", async () => {
  await chrome.runtime.sendMessage({type: "LINKPEEK_CLEAR_CACHE"});
  $("clear").textContent = "Cache cleared";
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.favorites) void renderFavorites();
  if (area === "session" && changes.tumblrJob) {
    tumblrJob = changes.tumblrJob.newValue as TumblrJobState | undefined;
    tumblrStopping = false;
    renderTumblr();
  }
});

void start();
