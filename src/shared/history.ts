/**
 * The history of what LinkPeek has shown, newest last, kept on this device.
 *
 * Entries are stored in chunks of a few hundred (one storage key each), so
 * adding an entry rewrites one small chunk; past the limit the oldest chunk is
 * dropped. The service worker is the only writer; the history page reads.
 */
import {safeDownloadName, type MediaItem} from "./media";

export const HISTORY_META = "historyMeta";
/** The Cache Storage holding saved media files (written by the service worker, read by the history page). */
export const LIBRARY_CACHE = "linkpeek-media";
/** The index of saved media files, oldest first. */
export const LIBRARY_INDEX = "mediaIndex";
/** Files starred as favourites in the Library, by saved address: kept whatever happens. */
export const FAVORITE_MEDIA = "favoriteMedia";
/** Still frames the library page made for GIF and video tiles, keyed like the saved files. */
export const STILLS_CACHE = "linkpeek-stills";

/** One saved file. Older entries carry only bytes and at, and count as seen (only seen media was saved then). */
export interface LibraryEntry {
  bytes: number;
  /** Saved at (ms since epoch). */
  at: number;
  /** Shown in LinkPeek; false for media saved because its link was prepared. */
  seen?: boolean;
  type?: MediaItem["type"];
  /** Page or post it came from, and its title. */
  source?: string;
  title?: string;
  /** A still to show in a grid (a GIF's or video's own file is too heavy for a tile). */
  preview?: string;
  /** The original, for opening on the web. */
  original?: string;
  /** Measured pixel size, when the saved file could be decoded. */
  w?: number;
  h?: number;
  /** Its copy in Downloads / LinkPeek Library (a chrome.downloads id), once one was made. */
  dl?: number;
}

/** The name a saved file gets under Downloads: the LinkPeek Library folder, the day, then the time, so folders sort in order. */
export function libraryFileName(url: string, at: number) {
  const date = new Date(at), pad = (value: number) => String(value).padStart(2, "0");
  const day = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  return `LinkPeek Library/${day}/${pad(date.getHours())}.${pad(date.getMinutes())}.${pad(date.getSeconds())} ${safeDownloadName({originalUrl: url})}`;
}

/** The file the viewer shows for an item, which is what the library saves: a picture's preview, or the original GIF or video. */
export function savedUrlOfItem(item: Pick<MediaItem, "type" | "originalUrl" | "previewUrl">) {
  return item.type === "image" ? item.previewUrl : item.originalUrl;
}

/** Every saved file, newest first. */
export async function readLibrary(): Promise<Array<[string, LibraryEntry]>> {
  const raw = (await chrome.storage.local.get(LIBRARY_INDEX))[LIBRARY_INDEX];
  if (!Array.isArray(raw)) return [];
  return raw.filter((pair): pair is [string, LibraryEntry] => Array.isArray(pair) && typeof pair[0] === "string" && typeof pair[1]?.bytes === "number" && typeof pair[1]?.at === "number")
    .sort((a, b) => b[1].at - a[1].at);
}
export const HISTORY_PREFIX = "history:";
export const HISTORY_CHUNK = 500;
/** Most entries kept; the oldest chunk goes first. */
export const HISTORY_LIMIT = 50_000;

/** One item seen: compact field names, since there can be tens of thousands. */
export interface HistoryEntry {
  /** Seen at (ms since epoch). */
  a: number;
  /** Measured pixel size of what was shown, once a check has learned it. */
  w?: number;
  h?: number;
  /** Original address. */
  o: string;
  /** Preview (or video poster) address. */
  p: string;
  t: MediaItem["type"];
  /** Page or post it came from, and its title. */
  s: string;
  n?: string;
}

export type HistoryMeta = {first: number; last: number};

/** The file the viewer showed for an entry, which is what the media library saves: a picture's preview, or the original GIF or video. */
export function savedUrlOf(entry: Pick<HistoryEntry, "o" | "p" | "t">) {
  return entry.t === "image" && entry.p ? entry.p : entry.o;
}

export function historyEntry(item: MediaItem, at = Date.now()): HistoryEntry {
  const entry: HistoryEntry = {a: at, o: item.originalUrl, p: item.type === "video" ? item.posterUrl ?? "" : item.previewUrl, t: item.type, s: item.sourceUrl};
  if (item.sourceTitle) entry.n = item.sourceTitle;
  return entry;
}

function isEntry(value: unknown): value is HistoryEntry {
  const entry = value as HistoryEntry;
  return typeof entry === "object" && entry !== null && typeof entry.a === "number" && typeof entry.o === "string" && typeof entry.s === "string";
}

function isMeta(value: unknown): value is HistoryMeta {
  const meta = value as HistoryMeta;
  return typeof meta === "object" && meta !== null && Number.isInteger(meta.first) && Number.isInteger(meta.last) && meta.first <= meta.last;
}

/** Every entry, newest first. */
export async function readHistory(): Promise<HistoryEntry[]> {
  const meta = (await chrome.storage.local.get(HISTORY_META))[HISTORY_META];
  if (!isMeta(meta)) return [];
  const keys = Array.from({length: meta.last - meta.first + 1}, (_, i) => HISTORY_PREFIX + (meta.first + i));
  const stored = await chrome.storage.local.get(keys);
  return keys.flatMap(key => Array.isArray(stored[key]) ? (stored[key] as unknown[]).filter(isEntry) : []).reverse();
}

/** How far the history check has come, and how long it is resting to spare the machine. */
export type HistoryAuditProgress = {checked: number; total: number; removed: number; url: string; resting: number};

/**
 * Appends entries in batches; the service worker keeps one of these. Every
 * write goes through one queue, so a check rewriting old chunks can never
 * clobber entries added meanwhile.
 */
export class HistoryWriter {
  private meta?: Promise<HistoryMeta>;
  private pending: HistoryEntry[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private writes: Promise<unknown> = Promise.resolve();

  constructor(private delayMs = 2000) {}

  /** Runs `work` after every write before it, and before any write after it. */
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const run = this.writes.then(work, work);
    this.writes = run.catch(() => undefined);
    return run;
  }

  private chunkKeys(meta: HistoryMeta) {
    return Array.from({length: meta.last - meta.first + 1}, (_, i) => HISTORY_PREFIX + (meta.first + i));
  }

  private loadMeta() {
    this.meta ??= chrome.storage.local.get(HISTORY_META).then(stored => isMeta(stored[HISTORY_META]) ? stored[HISTORY_META] : {first: 0, last: 0});
    return this.meta;
  }

  add(entry: HistoryEntry) {
    this.pending.push(entry);
    this.timer ??= setTimeout(() => void this.flush(), this.delayMs);
  }

  flush() {
    clearTimeout(this.timer);
    this.timer = undefined;
    return this.serial(() => this.flushNow());
  }

  private async flushNow() {
    const added = this.pending;
    this.pending = [];
    if (!added.length) return;
    const meta = {...await this.loadMeta()}, key = () => HISTORY_PREFIX + meta.last;
    let chunk = ((await chrome.storage.local.get(key()))[key()] as HistoryEntry[] | undefined) ?? [];
    const update: Record<string, unknown> = {};
    for (const entry of added) {
      if (chunk.length >= HISTORY_CHUNK) {
        update[key()] = chunk;
        meta.last++;
        chunk = [];
      }
      chunk.push(entry);
    }
    update[key()] = chunk;
    const dropped: string[] = [];
    while ((meta.last - meta.first + 1) * HISTORY_CHUNK > HISTORY_LIMIT) dropped.push(HISTORY_PREFIX + meta.first++);
    update[HISTORY_META] = meta;
    this.meta = Promise.resolve(meta);
    await chrome.storage.local.set(update);
    if (dropped.length) await chrome.storage.local.remove(dropped);
  }

  /** Strikes entries (matched by time and address) from the chunks that hold them. */
  remove(gone: ReadonlyArray<{a: number; o: string}>) {
    const wanted = new Set(gone.map(entry => `${entry.a}\u0000${entry.o}`));
    return this.removeWhere(entry => wanted.has(`${entry.a}\u0000${entry.o}`));
  }

  /** Strikes every entry for this address, whenever it was seen. */
  removeAddress(original: string) {
    return this.removeWhere(entry => entry.o === original);
  }

  private removeWhere(gone: (entry: HistoryEntry) => boolean) {
    clearTimeout(this.timer);
    this.timer = undefined;
    return this.serial(async () => {
      await this.flushNow();
      const keys = this.chunkKeys(await this.loadMeta());
      const stored = await chrome.storage.local.get(keys);
      const update: Record<string, unknown> = {};
      for (const key of keys) {
        const chunk = stored[key];
        if (!Array.isArray(chunk)) continue;
        const kept = (chunk as HistoryEntry[]).filter(entry => !gone(entry));
        if (kept.length !== chunk.length) update[key] = kept;
      }
      if (Object.keys(update).length) await chrome.storage.local.set(update);
    });
  }

  /**
   * Walks every entry once: learns the size of those not yet sized (videos
   * aside) through `size`, drops those `small` calls too small, and keeps the
   * sizes learned so the next check skips them. Each chunk is rewritten from
   * a fresh read inside the write queue, so entries added during the check
   * survive. A step that took real work earns an equal rest, so the check
   * never takes more than half the machine, but it always finishes.
   */
  async audit(size: (entry: HistoryEntry) => Promise<{w: number; h: number} | undefined>, small: (w: number, h: number, entry: HistoryEntry) => boolean,
    onProgress?: (progress: HistoryAuditProgress) => void) {
    await this.flush();
    const keys = this.chunkKeys(await this.loadMeta()), stored = await chrome.storage.local.get(keys);
    const chunks = keys.map(key => Array.isArray(stored[key]) ? (stored[key] as unknown[]).filter(isEntry) : []);
    const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0), id = (entry: HistoryEntry) => `${entry.a}\u0000${entry.o}`;
    let checked = 0, removed = 0;
    for (const [at, chunk] of chunks.entries()) {
      const sized = new Map<string, {w: number; h: number}>(), dropped = new Set<string>();
      for (const entry of chunk) {
        const began = Date.now();
        let known = entry.w === undefined ? undefined : {w: entry.w, h: entry.h ?? 0};
        if (!known && entry.t !== "video") {
          known = await size(entry);
          if (known) sized.set(id(entry), known);
        }
        if (known && small(known.w, known.h, entry)) {
          dropped.add(id(entry));
          removed++;
        }
        checked++;
        const took = Date.now() - began, resting = took > 25 ? Math.min(1000, took) : 0;
        onProgress?.({checked, total, removed, url: savedUrlOf(entry), resting});
        if (resting) await new Promise(resolve => setTimeout(resolve, resting));
      }
      if (!sized.size && !dropped.size) continue;
      await this.serial(async () => {
        const key = keys[at], fresh = (await chrome.storage.local.get(key))[key];
        if (!Array.isArray(fresh)) return;
        await chrome.storage.local.set({[key]: (fresh as HistoryEntry[]).filter(entry => !dropped.has(id(entry))).map(entry => ({...entry, ...sized.get(id(entry))}))});
      });
    }
    return {checked: total, removed};
  }

  /** Forgets the whole history. */
  clear() {
    clearTimeout(this.timer);
    this.timer = undefined;
    this.pending = [];
    return this.serial(async () => {
      const meta = await this.loadMeta();
      await chrome.storage.local.remove([HISTORY_META, ...this.chunkKeys(meta)]);
      this.meta = Promise.resolve({first: 0, last: 0});
    });
  }
}
