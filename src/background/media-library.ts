/**
 * The offline media library: the files of every gallery LinkPeek prepares or
 * shows are saved on this device, so the History page can show them later
 * without a connection — and each file's copy goes into Downloads / LinkPeek
 * Library, where the files themselves can be browsed.
 *
 * Files live in the extension's Cache Storage, keyed by the address they are
 * shown from. A small index (in extension storage, written in batches) records
 * each file's size, measured pixel size, when it was saved, whether it has been
 * seen, where it came from and its Downloads copy. Pictures are measured as
 * they arrive, and ones below the configured minimum size are never kept.
 * Files being looked at jump the queue ahead of prepared ones; once the budget
 * is reached, files never seen go first, oldest first, and seen ones only
 * after them — their Downloads copies go with them. Saving runs two files at a
 * time and never retries.
 */
import {bytesToBase64, fetchWithRetry, readBytesCapped} from "../core/http";
import {FAVORITE_MEDIA, LIBRARY_CACHE, LIBRARY_INDEX, STILLS_CACHE, libraryFileName, type LibraryEntry} from "../shared/history";
import {underSized} from "../shared/media";

const CONCURRENCY = 2;
const INDEX_SAVE_DELAY_MS = 5000;
/** Above this, the Downloads copy is made from the file's address instead of its bytes (a data: address that long is fragile). */
const MIRROR_DATA_MAX = 32 * 1024 * 1024;
/** Addresses measured and found too small, kept so repeated scans do not fetch them again. */
const REJECTED_MEMORY = 5000;

/** What is known about a file before it is saved. */
export type LibraryMeta = Omit<LibraryEntry, "bytes" | "at" | "w" | "h" | "dl">;
/** The rules of the moment: how much space, the smallest picture worth keeping, and whether Downloads gets a copy. */
export type LibraryRules = {budget: number; minWidth: number; minHeight: number; mirror: boolean};
/** How far the saved-files check has come, and how long it is resting to spare the machine. */
export type AuditProgress = {checked: number; total: number; removed: number; mirrored: number; url: string; resting: number};
type Job = {url: string; rules: LibraryRules; meta: LibraryMeta};

function isEntry(value: unknown): value is [string, LibraryEntry] {
  const pair = value as [string, LibraryEntry];
  return Array.isArray(pair) && typeof pair[0] === "string" && typeof pair[1]?.bytes === "number" && typeof pair[1]?.at === "number";
}

/** An SVG's size from its own width and height, else its viewBox; undefined when it states neither in plain numbers. */
export function svgSize(text: string): {w: number; h: number} | undefined {
  const tag = /<svg\b[^>]*>/i.exec(text)?.[0];
  if (!tag) return undefined;
  const number = (name: string) => {
    const value = new RegExp(`\\s${name}\\s*=\\s*["']\\s*([\\d.]+)\\s*(?:px)?\\s*["']`, "i").exec(tag)?.[1];
    return value === undefined ? undefined : Number(value);
  };
  const w = number("width"), h = number("height");
  if (w && h) return {w, h};
  const box = /\sviewBox\s*=\s*["']\s*[-\d.]+[\s,]+[-\d.]+[\s,]+([\d.]+)[\s,]+([\d.]+)\s*["']/i.exec(tag);
  return box && Number(box[1]) && Number(box[2]) ? {w: Number(box[1]), h: Number(box[2])} : undefined;
}

/**
 * The pixel size of a picture; undefined for video or anything that cannot be
 * read. Files are tried whatever their declared type (servers often send
 * pictures as octet-stream), and SVGs are sized by their own numbers.
 */
export async function measure(bytes: ArrayBuffer, type: string): Promise<{w: number; h: number} | undefined> {
  if (type.startsWith("video/")) return undefined;
  const head = new TextDecoder().decode(bytes.slice(0, 2048));
  if (type.includes("svg") || /<svg\b/i.test(head)) return svgSize(new TextDecoder().decode(bytes));
  try {
    const bitmap = await createImageBitmap(new Blob([bytes], {type}));
    const size = {w: bitmap.width, h: bitmap.height};
    bitmap.close();
    return size;
  } catch {
    return undefined;
  }
}

/** The most bytes read from the web just to learn a picture's size. */
const MEASURE_MAX_BYTES = 12 * 1024 * 1024;

/** Deletes an entry's Downloads copy: the file on disk, then its row in the downloads list. */
async function removeMirror(entry: LibraryEntry) {
  if (entry.dl === undefined) return;
  await chrome.downloads.removeFile(entry.dl).catch(() => undefined);
  await chrome.downloads.erase({id: entry.dl}).catch(() => undefined);
}

/** The files starred as favourites in the Library, read fresh each time they matter. */
export async function favoriteFiles() {
  const stored = (await chrome.storage.local.get(FAVORITE_MEDIA))[FAVORITE_MEDIA];
  return new Set<string>(Array.isArray(stored) ? stored.filter((url): url is string => typeof url === "string") : []);
}

export class MediaLibrary {
  private index?: Promise<Map<string, LibraryEntry>>;
  private indexTimer: ReturnType<typeof setTimeout> | undefined;
  private queue: Job[] = [];
  private queued = new Map<string, Job>();
  private active = 0;
  /** Files measured too small to keep, with the size that ruled them out (the history check reuses it). */
  private rejected = new Map<string, {w: number; h: number}>();

  private loadIndex() {
    this.index ??= chrome.storage.local.get(LIBRARY_INDEX).then(stored => {
      const raw = stored[LIBRARY_INDEX];
      const entries = Array.isArray(raw) ? raw.filter(isEntry) : [];
      return new Map(entries.sort((a, b) => a[1].at - b[1].at));
    });
    return this.index;
  }

  private saveIndexSoon() {
    this.indexTimer ??= setTimeout(() => void this.saveIndex(), INDEX_SAVE_DELAY_MS);
  }

  async saveIndex() {
    clearTimeout(this.indexTimer);
    this.indexTimer = undefined;
    await chrome.storage.local.set({[LIBRARY_INDEX]: [...await this.loadIndex()]});
  }

  /**
   * Queues a file to keep under `rules`. A file being looked at goes ahead of
   * prepared ones; a file already kept is only marked seen; a file measured
   * too small before is not fetched again.
   */
  save(url: string, rules: LibraryRules, meta: LibraryMeta) {
    if (!/^https?:/.test(url) || this.rejected.has(url)) return;
    const waiting = this.queued.get(url);
    if (waiting) {
      if (meta.seen && !waiting.meta.seen) {
        waiting.meta.seen = true;
        this.queue.splice(this.queue.indexOf(waiting), 1);
        this.queue.unshift(waiting);
      }
      return;
    }
    const job: Job = {url, rules, meta: {...meta}};
    this.queued.set(url, job);
    if (meta.seen) this.queue.unshift(job);
    else this.queue.push(job);
    this.pump();
  }

  private pump() {
    while (this.active < CONCURRENCY && this.queue.length) {
      const job = this.queue.shift()!;
      this.active++;
      void this.store(job).catch(() => undefined).finally(() => {
        this.active--;
        this.queued.delete(job.url);
        this.pump();
      });
    }
  }

  private async store({url, rules, meta}: Job) {
    const index = await this.loadIndex(), kept = index.get(url);
    if (kept) {
      if (meta.seen && !kept.seen) {
        kept.seen = true;
        this.saveIndexSoon();
      }
      // Saved before mirroring existed, or the copy failed: Downloads gets it now.
      if (rules.mirror && kept.dl === undefined) {
        await this.mirror(url, kept);
        this.saveIndexSoon();
      }
      return;
    }
    // One file may use at most a quarter of the budget, so a long video cannot push out everything else.
    const {bytes, type} = await fetchWithRetry(url, {credentials: "include"}, {mode: "background", timeoutMs: 60_000, read: async response => {
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return {bytes: await readBytesCapped(response, Math.floor(rules.budget / 4), "Too large to keep"), type: response.headers.get("content-type") ?? "application/octet-stream"};
    }});
    const size = await measure(bytes, type);
    if (size && underSized(size.w, size.h, rules)) {
      this.reject(url, size);
      return;
    }
    const cache = await caches.open(LIBRARY_CACHE);
    await cache.put(url, new Response(bytes, {headers: {"content-type": type, "content-length": String(bytes.byteLength)}}));
    const entry: LibraryEntry = {...meta, bytes: bytes.byteLength, at: Date.now(), ...size};
    index.set(url, entry);
    await this.trim(rules.budget);
    // Unless it was trimmed straight back out, Downloads gets its copy.
    if (rules.mirror && index.has(url)) await this.mirror(url, entry);
    this.saveIndexSoon();
  }

  private reject(url: string, size: {w: number; h: number}) {
    this.rejected.set(url, size);
    while (this.rejected.size > REJECTED_MEMORY) this.rejected.delete(this.rejected.keys().next().value!);
  }

  /** Writes the file's copy into Downloads / LinkPeek Library, remembering the download so it leaves with the entry. */
  private async mirror(url: string, entry: LibraryEntry) {
    const copy = entry.bytes <= MIRROR_DATA_MAX ? await (await caches.open(LIBRARY_CACHE)).match(url) : undefined;
    const source = copy ? `data:${copy.headers.get("content-type")};base64,${bytesToBase64(await copy.arrayBuffer())}` : url;
    entry.dl = await chrome.downloads.download({url: source, filename: libraryFileName(url, entry.at), conflictAction: "uniquify", saveAs: false}).catch(() => undefined);
  }

  /**
   * A file's pixel size: as measured when it was saved, else from its saved
   * bytes, else fetched from the web once. Undefined for anything that cannot
   * be read as a picture.
   */
  async sizeFor(url: string): Promise<{w: number; h: number} | undefined> {
    // Removed for being too small: what ruled it out still stands.
    const ruledOut = this.rejected.get(url);
    if (ruledOut) return ruledOut;
    const entry = (await this.loadIndex()).get(url);
    if (entry?.w !== undefined) return {w: entry.w, h: entry.h ?? 0};
    const kept = await (await caches.open(LIBRARY_CACHE)).match(url);
    if (kept) return measure(await kept.arrayBuffer(), kept.headers.get("content-type") ?? "");
    if (!/^https?:/.test(url)) return undefined;
    const fetched = await fetchWithRetry(url, {credentials: "include"}, {mode: "background", timeoutMs: 15_000, read: async response => {
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return {bytes: await readBytesCapped(response, MEASURE_MAX_BYTES, "Too large to measure"), type: response.headers.get("content-type") ?? ""};
    }}).catch(() => undefined);
    return fetched && measure(fetched.bytes, fetched.type);
  }

  /** Forgets one file: its saved bytes, its index entry and its Downloads copy. */
  async remove(url: string) {
    const index = await this.loadIndex(), entry = index.get(url);
    if (!entry) return;
    index.delete(url);
    await (await caches.open(LIBRARY_CACHE)).delete(url);
    await (await caches.open(STILLS_CACHE)).delete(url);
    await removeMirror(entry);
    this.saveIndexSoon();
  }

  /**
   * Walks every saved file once: measures pictures never measured, removes any
   * below the minimums (Downloads copies included), and gives files saved
   * before mirroring their Downloads copy. Answers with what it did.
   */
  async audit(rules: LibraryRules, onProgress?: (progress: AuditProgress) => void) {
    const index = await this.loadIndex(), entries = [...index], favorites = await favoriteFiles();
    let removed = 0, mirrored = 0, checked = 0;
    const cache = await caches.open(LIBRARY_CACHE);
    for (const [url, entry] of entries) {
      const began = Date.now();
      if (entry.w === undefined && entry.type !== "video") {
        const hit = await cache.match(url);
        const size = hit && await measure(await hit.arrayBuffer(), hit.headers.get("content-type") ?? "");
        if (size) Object.assign(entry, size);
      }
      if (entry.w !== undefined && underSized(entry.w, entry.h ?? 0, rules) && !favorites.has(url)) {
        this.reject(url, {w: entry.w, h: entry.h ?? 0});
        await this.remove(url);
        removed++;
      } else if (rules.mirror && entry.dl === undefined) {
        await this.mirror(url, entry);
        if (entry.dl !== undefined) mirrored++;
      }
      checked++;
      // The check always finishes, but never at the browser's expense: a file that
      // took real work earns an equal rest, so the audit uses at most half the machine.
      const took = Date.now() - began;
      const resting = took > 25 ? Math.min(1000, took) : 0;
      onProgress?.({checked, total: entries.length, removed, mirrored, url, resting});
      if (resting) await new Promise(resolve => setTimeout(resolve, resting));
    }
    await this.saveIndex();
    return {checked: entries.length, removed, mirrored};
  }

  /** Removes files while the library is over `budget` bytes: never-seen ones first, oldest first, then seen ones. */
  async trim(budget: number) {
    const index = await this.loadIndex();
    let total = 0;
    for (const entry of index.values()) total += entry.bytes;
    if (total <= budget) return;
    const cache = await caches.open(LIBRARY_CACHE), favorites = await favoriteFiles();
    // Favourites never go to make room, whatever the budget says.
    const order = [...index].filter(([url]) => !favorites.has(url)).sort((a, b) => Number(a[1].seen !== false) - Number(b[1].seen !== false));
    for (const [url, entry] of order) {
      if (total <= budget) break;
      index.delete(url);
      total -= entry.bytes;
      await cache.delete(url);
      await (await caches.open(STILLS_CACHE)).delete(url);
      await removeMirror(entry);
    }
    this.saveIndexSoon();
  }

  async stats() {
    const index = await this.loadIndex();
    let bytes = 0;
    for (const entry of index.values()) bytes += entry.bytes;
    return {count: index.size, bytes};
  }

  /** Forgets every saved file, Downloads copies included. */
  async clear() {
    this.queue = [];
    this.queued.clear();
    const index = await this.loadIndex();
    for (const entry of index.values()) await removeMirror(entry);
    await caches.delete(LIBRARY_CACHE);
    await caches.delete(STILLS_CACHE);
    index.clear();
    await this.saveIndex();
  }
}
