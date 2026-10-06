/**
 * The history of what LinkPeek has shown, newest last, kept on this device.
 *
 * Entries are stored in chunks of a few hundred (one storage key each), so
 * adding an entry rewrites one small chunk; past the limit the oldest chunk is
 * dropped. The service worker is the only writer; the history page reads.
 */
import type {MediaItem} from "./media";

export const HISTORY_META = "historyMeta";
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
