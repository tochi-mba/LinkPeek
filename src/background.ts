/**
 * The service worker: every cross-origin request LinkPeek makes happens here.
 *
 * It scans destinations (Discourse topics, generic pages, direct media), shares
 * one scan between every tab that asks for the same URL, streams progress for
 * long threads, and keeps a byte-bounded cache of results and GIF bytes.
 */
import {ByteCache} from "./background/byte-cache";
import {Fingerprinter} from "./background/fingerprint";
import {GalleryStore, type StoredGallery} from "./background/gallery-store";
import {MediaLibrary, type LibraryRules} from "./background/media-library";
import {HistoryWriter, LIBRARY_CACHE, savedUrlOf, savedUrlOfItem} from "./shared/history";
import {prefetchDiscourse, scanDiscourse, type DiscourseSeed} from "./core/discourse";
import {scanGeneric} from "./core/generic";
import {bytesToBase64, fetchWithRetry, readBytesCapped} from "./core/http";
import type {LinkKind, ScanResult} from "./shared/media";
import type {BackgroundRequest, DownloadAllRequest, ScanRequest} from "./shared/messages";
import {SCAN_SETTING_KEYS, SETTINGS_VERSION, effectiveSettings, loadSettings, type LinkPeekSettings} from "./shared/settings";

type CachedScan = {at: number; scanKey: string; result: ScanResult; seed?: DiscourseSeed};
type BinaryEntry = {base64: string; mime: string; bytes: number};
type Consumer = {token: string; tabId?: number; frameId?: number};
type ScanTask = {controller: AbortController; consumers: Map<string, Consumer>; promise: Promise<ScanResult>};

const BINARY_BUDGET = 64 * 1024 * 1024;
const PROGRESS_FIRST_DELAY_MS = 60;

const scans = new ByteCache<CachedScan>();
const galleries = new GalleryStore();
const fingerprints = new Fingerprinter();
const history = new HistoryWriter();
const library = new MediaLibrary();
const binaries = new ByteCache<BinaryEntry>();
const scanTasks = new Map<string, ScanTask>();
const prefetchTasks = new Map<string, Promise<ScanResult | null>>();
const binaryTasks = new Map<string, Promise<BinaryEntry>>();
let settingsPromise: Promise<LinkPeekSettings> | undefined;

/** Settings stay in memory until they change, instead of being read from storage on every message. */
function currentSettings() {
  settingsPromise ??= loadSettings().catch(error => {
    settingsPromise = undefined;
    throw error;
  });
  return settingsPromise;
}

/** Only the settings that change what a scan returns; others never invalidate the cache. */
export function scanKey(settings: LinkPeekSettings) {
  return JSON.stringify(SCAN_SETTING_KEYS.map(key => settings[key]));
}

function estimateBytes(value: unknown) {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function cachedScan(url: string, settings: LinkPeekSettings) {
  const entry = scans.get(url);
  if (!entry) return undefined;
  if (entry.scanKey !== scanKey(settings) || Date.now() - entry.at >= settings.cacheMinutes * 60_000) {
    scans.delete(url);
    return undefined;
  }
  return entry;
}

function cacheScan(url: string, result: ScanResult, settings: LinkPeekSettings, seed?: DiscourseSeed, at = Date.now(), persist = true) {
  const entry: CachedScan = {at, scanKey: scanKey(settings), result, seed};
  scans.set(url, entry, estimateBytes(entry), Math.max(1, settings.maxCacheMb) * 1024 * 1024);
  // Only finished galleries are kept on the device; a partial one would hide the rest next time.
  if (persist && result.complete && settings.rememberGalleries) void galleries.put(url, entry.scanKey, result).catch(() => undefined);
  if (persist) savePrepared(result, settings);
}

/** How the library must behave right now, from the settings. */
function libraryRules(settings: LinkPeekSettings): LibraryRules {
  return {budget: settings.savedMediaBudgetMb * 1024 * 1024, minWidth: settings.minWidth, minHeight: settings.minHeight, mirror: settings.saveToDownloads};
}

/** Downloads the files of a gallery that was prepared or scanned, into the library, as unseen media. */
function savePrepared(result: ScanResult, settings: LinkPeekSettings) {
  if (!settings.saveMediaOffline || !settings.savePreparedMedia) return;
  const rules = libraryRules(settings);
  for (const item of result.items) {
    library.save(savedUrlOfItem(item), rules, {
      seen: false, type: item.type, source: item.sourceUrl, title: item.sourceTitle, original: item.originalUrl,
      preview: item.type === "video" ? item.posterUrl : item.previewUrl
    });
  }
}

/** A gallery saved on the device earlier, when keeping them is on. */
function storedScan(url: string, settings: LinkPeekSettings): Promise<StoredGallery | undefined> {
  if (!settings.rememberGalleries) return Promise.resolve(undefined);
  return galleries.get(url, scanKey(settings), settings.rememberGalleriesDays * 86_400_000).catch(() => undefined);
}

/** Fetches media bytes for the GIF frame player, which cannot read cross-origin pixels itself. */
function fetchBinary(url: string, maxMb: number): Promise<BinaryEntry> {
  const maxBytes = Math.max(1, Math.min(100, maxMb)) * 1024 * 1024;
  const key = url;
  const withinLimit = (entry: BinaryEntry) => {
    if (entry.bytes > maxBytes) throw new Error("GIF is larger than the configured frame-control limit");
    return entry;
  };
  const cached = binaries.get(key);
  if (cached) return Promise.resolve(cached).then(withinLimit);
  const pending = binaryTasks.get(key);
  if (pending) return pending.then(withinLimit);
  const task = (async () => {
    const parsed = new URL(url);
    if (!/^https?:$/.test(parsed.protocol)) throw new Error("Unsupported media URL");
    const tooLarge = "GIF is larger than the configured frame-control limit";
    // Saved on this device already: served from the library, with no network at all.
    const kept = typeof caches === "undefined" ? undefined : await caches.open(LIBRARY_CACHE).then(cache => cache.match(url)).catch(() => undefined);
    if (kept) {
      const buffer = await kept.arrayBuffer();
      if (buffer.byteLength > maxBytes) throw new Error(tooLarge);
      const entry = {base64: bytesToBase64(buffer), mime: kept.headers.get("content-type") || "application/octet-stream", bytes: buffer.byteLength};
      binaries.set(key, entry, entry.bytes, BINARY_BUDGET);
      return entry;
    }
    const entry = await fetchWithRetry(parsed.href, {credentials: "include", redirect: "follow"}, {read: async response => {
    if (!response.ok) throw new Error(`HTTP ${response.status} for media`);
    const buffer = await readBytesCapped(response, maxBytes, tooLarge);
    return {base64: bytesToBase64(buffer), mime: response.headers.get("content-type") || "application/octet-stream", bytes: buffer.byteLength};
    }});
    binaries.set(key, entry, entry.bytes, BINARY_BUDGET);
    return entry;
  })().finally(() => binaryTasks.delete(key));
  binaryTasks.set(key, task);
  return task;
}

function directResult(url: string, kind: LinkKind, settings: LinkPeekSettings): ScanResult {
  const video = kind === "direct-video";
  const items = video && !settings.includeVideo ? [] : [{
    id: url, type: video ? "video" as const : /\.gif(?:$|[?#])/i.test(url) ? "gif" as const : "image" as const,
    originalUrl: url, previewUrl: url, sourceUrl: url, score: 1
  }];
  return {url, kind, items, complete: true, diagnostics: {adapter: "Direct media", ignored: 0, duplicates: 0, warnings: []}};
}

function broadcast(task: ScanTask, url: string, result: ScanResult) {
  for (const consumer of task.consumers.values()) {
    if (consumer.tabId == null) continue;
    chrome.tabs.sendMessage(consumer.tabId, {type: "LINKPEEK_SCAN_PROGRESS", token: consumer.token, url, result}, {frameId: consumer.frameId ?? 0}).catch(() => undefined);
  }
}

async function executeScan(url: string, kind: LinkKind, settings: LinkPeekSettings, task: ScanTask, seed?: DiscourseSeed) {
  let result: ScanResult;
  if (kind === "discourse") {
    // Hold the first progress update briefly so a fast scan answers once instead of twice.
    let timer: ReturnType<typeof setTimeout> | undefined, pending: ScanResult | undefined, streaming = false;
    const onProgress = settings.progressiveScan ? (progress: ScanResult) => {
      if (streaming) return broadcast(task, url, progress);
      pending = progress;
      timer ??= setTimeout(() => {
        streaming = true;
        broadcast(task, url, pending!);
      }, PROGRESS_FIRST_DELAY_MS);
    } : undefined;
    try {
      result = await scanDiscourse(url, settings.batchSize, settings.maxPosts, settings, seed, {signal: task.controller.signal, onProgress});
    } finally {
      clearTimeout(timer);
    }
  } else if (kind === "direct-image" || kind === "direct-video") {
    result = directResult(url, kind, settings);
  } else {
    result = await scanGeneric(url, settings, task.controller.signal);
  }
  cacheScan(url, result, settings, seed);
  return result;
}

/** Cheap work done before hover. `deep` also runs the linked-page search for empty generic pages. */
async function prefetch(url: string, kind: LinkKind, settings: LinkPeekSettings, deep: boolean): Promise<ScanResult | null> {
  const cached = cachedScan(url, settings);
  if (cached) return cached.result;
  // Saved on the device: nothing to fetch ahead of time, whatever its age within the keep period.
  const stored = await storedScan(url, settings);
  if (stored) {
    cacheScan(url, stored.result, settings, undefined, stored.at, false);
    return stored.result;
  }
  if (kind === "direct-image" || kind === "direct-video") {
    const result = directResult(url, kind, settings);
    cacheScan(url, result, settings);
    return result;
  }
  if (kind !== "discourse" && kind !== "generic") return null;
  const pending = prefetchTasks.get(url);
  if (pending) {
    const result = await pending;
    // A shallow check found nothing; the deeper search still has to run.
    if (deep && kind === "generic" && !result?.items.length && !cachedScan(url, settings)) return prefetch(url, kind, settings, true);
    return result;
  }
  const promise: Promise<ScanResult | null> = kind === "discourse"
    ? prefetchDiscourse(url, settings).then(({result, seed}) => {
      cacheScan(url, result, settings, seed);
      return result;
    })
    : scanGeneric(url, settings, undefined, deep, "background").then(result => {
      // An empty shallow result is not final while a linked-page search could still find media.
      const final = deep || settings.recursiveSearch === "off" || (result.items.length > 0 && settings.recursiveTrigger !== "always");
      if (final) cacheScan(url, result, settings);
      return result;
    });
  const tracked = promise.finally(() => {
    if (prefetchTasks.get(url) === tracked) prefetchTasks.delete(url);
  });
  prefetchTasks.set(url, tracked);
  return tracked;
}

async function scan(msg: ScanRequest, sender: chrome.runtime.MessageSender) {
  const base = effectiveSettings(await currentSettings(), msg.url);
  // Searching linked pages whatever the page itself holds; its own media were all too small to count.
  const settings: LinkPeekSettings = msg.linked ? {...base, recursiveTrigger: "always"} : base;
  const key = msg.linked ? `${msg.url}\u0000linked` : msg.url;
  // Reuse a prefetch that is already running instead of starting the same requests twice.
  let warming: Promise<unknown> | undefined;
  while ((warming = prefetchTasks.get(msg.url))) await warming.catch(() => null);
  const cached = cachedScan(msg.url, settings);
  if (cached?.result.complete) return cached.result;
  // Saved on the device: fresh enough is the answer; older shows at once while a fresh scan runs.
  const stored = cached || msg.linked ? undefined : await storedScan(msg.url, settings);
  if (stored && Date.now() - stored.at < settings.cacheMinutes * 60_000) {
    cacheScan(msg.url, stored.result, settings, undefined, stored.at, false);
    return stored.result;
  }
  let task = scanTasks.get(key);
  if (task?.controller.signal.aborted) {
    scanTasks.delete(key);
    task = undefined;
  }
  if (!task) {
    const created: ScanTask = {controller: new AbortController(), consumers: new Map(), promise: Promise.resolve(undefined as unknown as ScanResult)};
    scanTasks.set(key, created);
    created.promise = executeScan(msg.url, msg.kind, settings, created, cached?.seed).finally(() => {
      if (scanTasks.get(key) === created) scanTasks.delete(key);
    });
    task = created;
  }
  task.consumers.set(msg.token, {token: msg.token, tabId: sender.tab?.id, frameId: sender.frameId});
  if (stored && sender.tab?.id != null) {
    chrome.tabs.sendMessage(sender.tab.id, {type: "LINKPEEK_SCAN_PROGRESS", token: msg.token, url: msg.url, result: stored.result}, {frameId: sender.frameId ?? 0}).catch(() => undefined);
  }
  return task.promise;
}

function cancelScan(url: string, token: string) {
  const task = scanTasks.get(url);
  if (!task) return;
  task.consumers.delete(token);
  if (task.consumers.size === 0) task.controller.abort();
}

async function download(url: string, filename?: string) {
  try {
    return await chrome.downloads.download({url, filename, conflictAction: "uniquify", saveAs: false});
  } catch (error) {
    // The browser rejects some names; the original file name always works.
    if (!filename) throw error;
    return chrome.downloads.download({url, conflictAction: "uniquify", saveAs: false});
  }
}

/** Two at a time, numbered in gallery order, into one folder; reports how many were refused. */
async function downloadAll(msg: DownloadAllRequest) {
  const width = String(msg.items.length).length;
  let next = 0, failed = 0;
  const worker = async () => {
    while (next < msg.items.length) {
      const index = next++, item = msg.items[index], number = String(index + 1).padStart(width, "0");
      try {
        await download(item.url, `${msg.folder}/${number} ${item.filename}`);
      } catch {
        failed++;
      }
    }
  };
  await Promise.all([worker(), worker()]);
  return {started: msg.items.length - failed, failed};
}

const MIRROR_URL = chrome.runtime.getURL("mirror.html");
const MIRROR_WINDOW_KEY = "mirrorWindowId";

async function rememberMirror(id?: number) {
  if (id === undefined) await chrome.storage.session.remove(MIRROR_WINDOW_KEY);
  else await chrome.storage.session.set({[MIRROR_WINDOW_KEY]: id});
}

/**
 * Finds the mirror from browser state instead of trusting service-worker memory.
 * Chromium may suspend this worker while the mirror remains open.
 */
async function locateMirror() {
  const stored = await chrome.storage.session.get(MIRROR_WINDOW_KEY);
  const id = stored[MIRROR_WINDOW_KEY];
  if (typeof id !== "number") return undefined;
  try {
    await chrome.windows.get(id);
    return id;
  } catch {
    await rememberMirror();
    return undefined;
  }
}

/** Tells every tab whether a mirror window is listening, so pages only send previews while one is. */
async function broadcastMirror(open: boolean) {
  const tabs = await chrome.tabs.query({});
  await Promise.allSettled(tabs.map(tab => tab.id === undefined ? Promise.resolve() : chrome.tabs.sendMessage(tab.id, {type: "LINKPEEK_MIRROR_OPEN", open})));
  return {open};
}

/** Opens the mirror window — a second screen for previews — or closes the one that is open. */
async function toggleMirror() {
  const existing = await locateMirror();
  if (existing !== undefined) {
    await rememberMirror();
    await chrome.windows.remove(existing).catch(() => undefined);
    return broadcastMirror(false);
  }
  // Reopen where it was last: same monitor, size and full-screen state.
  const {mirrorBounds} = await chrome.storage.local.get(MIRROR_BOUNDS_KEY) as {mirrorBounds?: MirrorBounds};
  const bounds = mirrorBounds ?? {width: 1100, height: 760};
  const created = await chrome.windows.create({url: MIRROR_URL, type: "popup", left: bounds.left, top: bounds.top, width: bounds.width, height: bounds.height});
  await rememberMirror(created?.id);
  if (created?.id !== undefined && bounds.state && bounds.state !== "normal") await chrome.windows.update(created.id, {state: bounds.state}).catch(() => undefined);
  return {open: true};
}

const MIRROR_BOUNDS_KEY = "mirrorBounds";
type MirrorBounds = {left?: number; top?: number; width: number; height: number; state?: "normal" | "maximized" | "fullscreen"};

/** Remembers where the mirror window is, so the next one opens on the same monitor at the same size. */
chrome.windows.onBoundsChanged.addListener(window => {
  void chrome.storage.session.get(MIRROR_WINDOW_KEY).then(async stored => {
    if (stored[MIRROR_WINDOW_KEY] !== window.id) return;
    const state = window.state === "maximized" || window.state === "fullscreen" ? window.state : "normal";
    // A full-screen or maximised window reports the monitor's bounds; keep the last normal size for coming back.
    const previous = (await chrome.storage.local.get(MIRROR_BOUNDS_KEY))[MIRROR_BOUNDS_KEY] as MirrorBounds | undefined;
    const bounds: MirrorBounds = state === "normal"
      ? {left: window.left, top: window.top, width: window.width!, height: window.height!, state}
      : {...(previous ?? {width: 1100, height: 760}), left: window.left, top: window.top, state};
    await chrome.storage.local.set({[MIRROR_BOUNDS_KEY]: bounds});
  });
});

chrome.windows.onRemoved.addListener(id => {
  // Session storage survives service-worker suspension, so a close event can
  // still identify the mirror after this module has been restarted.
  void chrome.storage.session.get(MIRROR_WINDOW_KEY).then(async stored => {
    if (stored[MIRROR_WINDOW_KEY] !== id) return;
    await rememberMirror();
    await broadcastMirror(false);
  });
});

function respond(work: Promise<unknown>, sendResponse: (response: unknown) => void, onError: (error: Error) => unknown = error => ({error: error.message})) {
  work.then(sendResponse, (error: Error) => sendResponse(onError(error)));
  return true;
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && (changes.settings || changes.settingsVersion)) settingsPromise = undefined;
});

chrome.runtime.onInstalled.addListener(async details => {
  if (details.reason === "install") {
    await chrome.storage.local.set({settings: {}, settingsVersion: SETTINGS_VERSION});
    await chrome.tabs.create({url: chrome.runtime.getURL("onboarding.html")});
  } else if (details.reason === "update") {
    const settings = await loadSettings();
    // Files saved by an older version migrate into Downloads, and too-small ones are cleaned out.
    if (settings.saveMediaOffline) await library.audit(libraryRules(settings)).catch(() => undefined);
  }
});

chrome.runtime.onMessage.addListener((msg: BackgroundRequest, sender, sendResponse) => {
  switch (msg?.type) {
    case "LINKPEEK_PREFETCH":
      return respond(currentSettings().then(settings => prefetch(msg.url, msg.kind, effectiveSettings(settings, msg.url), Boolean(msg.deep))), sendResponse);
    case "LINKPEEK_SCAN":
      return respond(scan(msg, sender), sendResponse, error => error.name === "AbortError" ? {cancelled: true} : {error: error.message});
    case "LINKPEEK_CANCEL_SCAN":
      cancelScan(msg.url, String(msg.token));
      sendResponse({ok: true});
      return false;
    case "LINKPEEK_FETCH_BINARY":
      return respond(fetchBinary(msg.url, Number(msg.maxMb) || 32), sendResponse);
    case "LINKPEEK_DOWNLOAD":
      return respond(download(msg.url, msg.filename).then(id => ({id})), sendResponse);
    case "LINKPEEK_DOWNLOAD_ALL":
      return respond(downloadAll(msg), sendResponse);
    case "LINKPEEK_OPEN_TAB":
      return respond(chrome.tabs.create({url: msg.url, active: Boolean(msg.active), index: sender.tab ? sender.tab.index + 1 : undefined, openerTabId: sender.tab?.id}).then(() => ({ok: true})), sendResponse);
    case "LINKPEEK_TOGGLE_MIRROR":
      return respond(toggleMirror(), sendResponse);
    case "LINKPEEK_MIRROR_READY":
      return respond((async () => {
        if (sender.tab?.windowId !== undefined) await rememberMirror(sender.tab.windowId);
        return broadcastMirror(true);
      })(), sendResponse);
    case "LINKPEEK_MIRROR_QUERY":
      return respond(locateMirror().then(id => ({open: id !== undefined})), sendResponse);
    case "LINKPEEK_CLEAR_CACHE":
      scans.clear();
      binaries.clear();
      return respond(galleries.clear().then(() => ({ok: true})), sendResponse);
    case "LINKPEEK_HISTORY_ADD":
      return respond(currentSettings().then(settings => {
        if (settings.keepHistory) history.add(msg.entry);
        const entry = msg.entry;
        if (settings.saveMediaOffline) {
          library.save(savedUrlOf(entry), libraryRules(settings), {seen: true, type: entry.t, source: entry.s, title: entry.n, preview: entry.p || undefined, original: entry.o});
        }
        return {ok: true};
      }), sendResponse);
    case "LINKPEEK_OPEN_LIBRARY": {
      const params = new URLSearchParams();
      if (msg.view) params.set("view", msg.view);
      if (msg.filter) params.set("filter", msg.filter);
      const query = params.toString();
      return respond(chrome.tabs.create({url: chrome.runtime.getURL(`history.html${query ? `?${query}` : ""}`)}).then(() => ({ok: true})), sendResponse);
    }
    case "LINKPEEK_LIBRARY_STATS":
      return respond(library.stats(), sendResponse);
    case "LINKPEEK_LIBRARY_CLEAR":
      return respond(library.clear().then(() => ({ok: true})), sendResponse);
    case "LINKPEEK_LIBRARY_AUDIT":
      return respond(currentSettings().then(settings => library.audit(libraryRules(settings))), sendResponse);
    case "LINKPEEK_HISTORY_CLEAR":
      return respond(history.clear().then(() => ({ok: true})), sendResponse);
    case "LINKPEEK_FINGERPRINT":
      return respond(Promise.all(msg.urls.slice(0, 64).map(url => fingerprints.print(url))).then(prints => ({prints: prints.map(print => print ?? null)})), sendResponse);
    case "LINKPEEK_GALLERY_STATS":
      return respond(galleries.stats(), sendResponse);
    case "LINKPEEK_FORGET_GALLERIES":
      scans.clear();
      return respond(galleries.clear().then(() => ({ok: true})), sendResponse);
    default:
      return false;
  }
});
