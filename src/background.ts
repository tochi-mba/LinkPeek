/**
 * The service worker: every cross-origin request LinkPeek makes happens here.
 *
 * It scans destinations (Discourse topics, generic pages, direct media), shares
 * one scan between every tab that asks for the same URL, streams progress for
 * long threads, and keeps a byte-bounded cache of results and GIF bytes.
 */
import {ByteCache} from "./background/byte-cache";
import {prefetchDiscourse, scanDiscourse, type DiscourseSeed} from "./core/discourse";
import {scanGeneric} from "./core/generic";
import {fetchWithRetry} from "./core/http";
import type {LinkKind, ScanResult} from "./shared/media";
import type {BackgroundRequest, ScanRequest} from "./shared/messages";
import {SCAN_SETTING_KEYS, SETTINGS_VERSION, effectiveSettings, loadSettings, type LinkPeekSettings} from "./shared/settings";

type CachedScan = {at: number; scanKey: string; result: ScanResult; seed?: DiscourseSeed};
type BinaryEntry = {base64: string; mime: string; bytes: number};
type Consumer = {token: string; tabId?: number; frameId?: number};
type ScanTask = {controller: AbortController; consumers: Map<string, Consumer>; promise: Promise<ScanResult>};

const BINARY_BUDGET = 64 * 1024 * 1024;
const PROGRESS_FIRST_DELAY_MS = 60;

const scans = new ByteCache<CachedScan>();
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

function cacheScan(url: string, result: ScanResult, settings: LinkPeekSettings, seed?: DiscourseSeed) {
  const entry: CachedScan = {at: Date.now(), scanKey: scanKey(settings), result, seed};
  scans.set(url, entry, estimateBytes(entry), Math.max(1, settings.maxCacheMb) * 1024 * 1024);
}

function bytesToBase64(buffer: ArrayBuffer) {
  const bytes = new Uint8Array(buffer), chunk = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += chunk) binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return btoa(binary);
}

/** Fetches media bytes for the GIF frame player, which cannot read cross-origin pixels itself. */
function fetchBinary(url: string, maxMb: number): Promise<BinaryEntry> {
  const cached = binaries.get(url);
  if (cached) return Promise.resolve(cached);
  const pending = binaryTasks.get(url);
  if (pending) return pending;
  const task = (async () => {
    const parsed = new URL(url);
    if (!/^https?:$/.test(parsed.protocol)) throw new Error("Unsupported media URL");
    const maxBytes = Math.max(1, Math.min(100, maxMb)) * 1024 * 1024, tooLarge = "GIF is larger than the configured frame-control limit";
    const response = await fetchWithRetry(parsed.href, {credentials: "include", redirect: "follow"}, "interactive");
    if (!response.ok) throw new Error(`HTTP ${response.status} for media`);
    if (Number(response.headers.get("content-length") || 0) > maxBytes) throw new Error(tooLarge);
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > maxBytes) throw new Error(tooLarge);
    const entry: BinaryEntry = {base64: bytesToBase64(buffer), mime: response.headers.get("content-type") || "application/octet-stream", bytes: buffer.byteLength};
    binaries.set(url, entry, entry.bytes, BINARY_BUDGET);
    return entry;
  })().finally(() => binaryTasks.delete(url));
  binaryTasks.set(url, task);
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
  const settings = effectiveSettings(await currentSettings(), msg.url);
  // Reuse a prefetch that is already running instead of starting the same requests twice.
  let warming: Promise<unknown> | undefined;
  while ((warming = prefetchTasks.get(msg.url))) await warming.catch(() => null);
  const cached = cachedScan(msg.url, settings);
  if (cached?.result.complete) return cached.result;
  let task = scanTasks.get(msg.url);
  if (task?.controller.signal.aborted) {
    scanTasks.delete(msg.url);
    task = undefined;
  }
  if (!task) {
    const created: ScanTask = {controller: new AbortController(), consumers: new Map(), promise: Promise.resolve(undefined as unknown as ScanResult)};
    scanTasks.set(msg.url, created);
    created.promise = executeScan(msg.url, msg.kind, settings, created, cached?.seed).finally(() => {
      if (scanTasks.get(msg.url) === created) scanTasks.delete(msg.url);
    });
    task = created;
  }
  task.consumers.set(msg.token, {token: msg.token, tabId: sender.tab?.id, frameId: sender.frameId});
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
    await loadSettings();
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
    case "LINKPEEK_CLEAR_CACHE":
      scans.clear();
      binaries.clear();
      sendResponse({ok: true});
      return false;
    default:
      return false;
  }
});
