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

/** Appends entries in batches; the service worker keeps one of these. */
export class HistoryWriter {
  private meta?: Promise<HistoryMeta>;
  private pending: HistoryEntry[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(private delayMs = 2000) {}

  private loadMeta() {
    this.meta ??= chrome.storage.local.get(HISTORY_META).then(stored => isMeta(stored[HISTORY_META]) ? stored[HISTORY_META] : {first: 0, last: 0});
    return this.meta;
  }

  add(entry: HistoryEntry) {
    this.pending.push(entry);
    this.timer ??= setTimeout(() => void this.flush(), this.delayMs);
  }

  async flush() {
    clearTimeout(this.timer);
    this.timer = undefined;
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
  async remove(gone: ReadonlyArray<{a: number; o: string}>) {
    await this.flush();
    const meta = await this.loadMeta();
    const wanted = new Set(gone.map(entry => `${entry.a}\u0000${entry.o}`));
    const keys = Array.from({length: meta.last - meta.first + 1}, (_, i) => HISTORY_PREFIX + (meta.first + i));
    const stored = await chrome.storage.local.get(keys);
    const update: Record<string, unknown> = {};
    for (const key of keys) {
      const chunk = stored[key];
      if (!Array.isArray(chunk)) continue;
      const kept = (chunk as HistoryEntry[]).filter(entry => !wanted.has(`${entry.a}\u0000${entry.o}`));
      if (kept.length !== chunk.length) update[key] = kept;
    }
    if (Object.keys(update).length) await chrome.storage.local.set(update);
  }

  /** Forgets the whole history. */
  async clear() {
    clearTimeout(this.timer);
    this.timer = undefined;
    this.pending = [];
    const meta = await this.loadMeta();
    await chrome.storage.local.remove([HISTORY_META, ...Array.from({length: meta.last - meta.first + 1}, (_, i) => HISTORY_PREFIX + (meta.first + i))]);
    this.meta = Promise.resolve({first: 0, last: 0});
  }
}
