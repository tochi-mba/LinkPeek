/**
 * Media LinkPeek has shown, remembered on this device so the shuffle never
 * shows it again: in this tab or another, today or months ago.
 *
 * Two things are kept per item: a 64-bit hash of its canonical address, and,
 * when the picture could be read, its fingerprint (see picture.ts), which also
 * catches the same picture at another address or size. Both are spread over
 * small storage buckets: recording one more item rewrites one bucket of a few
 * kilobytes, not the whole history. Writes are batched, merged with what other
 * tabs stored meanwhile, and each bucket keeps only its newest entries.
 */
import {historyEntry} from "./history";
import {canonicalMediaUrl, type MediaItem} from "./media";
import type {FingerprintRequest, HistoryAddRequest} from "./messages";
import {isFingerprint, samePicture} from "./picture";
import type {LinkPeekSettings} from "./settings";

export const SEEN_PREFIX = "seenMedia:";
export const PRINT_PREFIX = "seenPrint:";
/** Roughly how many items are remembered in all; the oldest are forgotten first. */
export const SEEN_LIMIT = 36_000;
const ADDRESS_BUCKETS = "0123456789abcdefghijklmnopqrstuvwxyz";
const PRINT_BUCKETS = "0123456789abcdef";
const SAVE_DELAY_MS = 3000;

/** Every storage key of the address history. */
export const SEEN_KEYS = [...ADDRESS_BUCKETS].map(bucket => SEEN_PREFIX + bucket);
/** Every storage key of the picture history. */
export const PRINT_KEYS = [...PRINT_BUCKETS].map(bucket => PRINT_PREFIX + bucket);
const ALL_KEYS = [...SEEN_KEYS, ...PRINT_KEYS];
const PER_BUCKET: Record<string, number> = {[SEEN_PREFIX]: SEEN_LIMIT / ADDRESS_BUCKETS.length, [PRINT_PREFIX]: SEEN_LIMIT / PRINT_BUCKETS.length};

function fnv(text: string, seed: number) {
  let hash = seed >>> 0;
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619) >>> 0;
  return hash;
}

/** A short, stable key for a media item: the same picture at a different size or with tracking parameters matches. */
export function mediaKey(item: Pick<MediaItem, "originalUrl">) {
  const url = canonicalMediaUrl(item.originalUrl);
  return fnv(url, 2166136261).toString(36).padStart(7, "0") + fnv(url, 33554467).toString(36).padStart(7, "0");
}

export class SeenMedia {
  private buckets = new Map<string, Set<string>>();
  private pending = new Map<string, Set<string>>();
  /** Every remembered fingerprint, for the near-match search (copies differ in a few bits). */
  private prints: string[] = [];
  private saveTimer: number | undefined;
  private loading?: Promise<void>;
  private stopped = false;

  /** Follows changes other tabs and the settings page make. */
  private onChanged = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
    if (area !== "local") return;
    let printsChanged = false;
    for (const key of ALL_KEYS) {
      if (!(key in changes)) continue;
      printsChanged ||= key.startsWith(PRINT_PREFIX);
      // Cleared elsewhere (the settings page): forget it here too, keeping nothing unsaved.
      if (changes[key].newValue === undefined) {
        this.buckets.delete(key);
        this.pending.delete(key);
      } else {
        this.merge(key, changes[key].newValue);
      }
    }
    if (printsChanged) this.rebuildPrints();
  };

  /** Reads the stored history once and starts following changes. */
  load() {
    this.loading ??= chrome.storage.local.get(ALL_KEYS).then(stored => {
      for (const key of ALL_KEYS) this.merge(key, stored[key]);
      this.rebuildPrints();
      if (!this.stopped) chrome.storage.onChanged.addListener(this.onChanged);
    }).catch(() => undefined);
    return this.loading;
  }

  /** Stops following changes, for a page script whose extension went away. */
  stop() {
    this.stopped = true;
    clearTimeout(this.saveTimer);
    chrome.storage.onChanged.removeListener(this.onChanged);
  }

  private merge(key: string, value: unknown) {
    if (!Array.isArray(value)) return;
    const bucket = this.bucket(key), print = key.startsWith(PRINT_PREFIX);
    for (const entry of value) if (print ? isFingerprint(entry) : typeof entry === "string") bucket.add(entry);
  }

  private rebuildPrints() {
    this.prints = PRINT_KEYS.flatMap(key => [...(this.buckets.get(key) ?? [])]);
  }

  private bucket(key: string) {
    let bucket = this.buckets.get(key);
    if (!bucket) this.buckets.set(key, bucket = new Set());
    return bucket;
  }

  private remember(storageKey: string, key: string) {
    const bucket = this.bucket(storageKey);
    if (bucket.has(key)) return false;
    bucket.add(key);
    let pending = this.pending.get(storageKey);
    if (!pending) this.pending.set(storageKey, pending = new Set());
    pending.add(key);
    if (this.saveTimer === undefined) this.saveTimer = window.setTimeout(() => void this.flush(), SAVE_DELAY_MS);
    return true;
  }

  has(item: Pick<MediaItem, "originalUrl">) {
    const key = mediaKey(item);
    return Boolean(this.buckets.get(SEEN_PREFIX + key[0])?.has(key));
  }

  add(item: Pick<MediaItem, "originalUrl">) {
    const key = mediaKey(item);
    this.remember(SEEN_PREFIX + key[0], key);
  }

  /** Whether this picture, or a copy of it at another address or size, was seen. */
  hasPicture(print: string) {
    return this.prints.some(seen => samePicture(seen, print));
  }

  addPicture(print: string) {
    if (isFingerprint(print) && this.remember(PRINT_PREFIX + print[0], print)) this.prints.push(print);
  }

  /** Items remembered by address. */
  get size() {
    let size = 0;
    for (const key of SEEN_KEYS) size += this.buckets.get(key)?.size ?? 0;
    return size;
  }

  get pictures() {
    return this.prints.length;
  }

  /** Writes what was added since the last save, merged with what is stored now. */
  async flush() {
    this.saveTimer = undefined;
    const pending = this.pending;
    this.pending = new Map();
    if (!pending.size) return;
    try {
      const stored = await chrome.storage.local.get([...pending.keys()]);
      const update: Record<string, string[]> = {};
      for (const [key, added] of pending) {
        const previous = Array.isArray(stored[key]) ? (stored[key] as unknown[]).filter((entry): entry is string => typeof entry === "string") : [];
        update[key] = [...new Set([...previous, ...added])].slice(-PER_BUCKET[key.startsWith(PRINT_PREFIX) ? PRINT_PREFIX : SEEN_PREFIX]);
      }
      await chrome.storage.local.set(update);
    } catch {
      // Storage unavailable (the extension was reloaded): this session still remembers in memory.
    }
  }
}

/** The picture to fingerprint for an item: its preview, or a video's poster frame. */
export function pictureOf(item: MediaItem) {
  return item.type === "video" ? item.posterUrl ?? "" : item.previewUrl;
}

/**
 * Fingerprints from the service worker, one per item (undefined where a
 * picture could not be read). With `waitMs`, gives up waiting after that long
 * and answers undefined for all, so a caller that must be instant can move on.
 */
export async function fingerprintsFor(items: readonly MediaItem[], waitMs?: number): Promise<Array<string | undefined>> {
  if (!items.length) return [];
  const request = chrome.runtime.sendMessage({type: "LINKPEEK_FINGERPRINT", urls: items.map(pictureOf)} satisfies FingerprintRequest).catch(() => undefined) as Promise<{prints?: Array<string | null>} | undefined>;
  const timeout = waitMs === undefined ? undefined : new Promise<undefined>(resolve => setTimeout(() => resolve(undefined), waitMs));
  const answer = await (timeout ? Promise.race([request, timeout]) : request);
  return items.map((_, i) => answer?.prints?.[i] ?? undefined);
}

/**
 * Remembers an item that was shown (its address now, its picture as soon as
 * it is fingerprinted) and adds first sightings to the history, as the
 * settings allow. Pages and the mirror window both record through this.
 */
export function recordSeen(seen: SeenMedia, item: MediaItem, settings: Pick<LinkPeekSettings, "skipSeenMedia" | "keepHistory" | "saveMediaOffline">) {
  if (!settings.skipSeenMedia && !settings.keepHistory && !settings.saveMediaOffline) return;
  // First sightings go to the service worker, which logs them and saves the file, as each is on.
  if ((settings.keepHistory || settings.saveMediaOffline) && !seen.has(item)) {
    chrome.runtime.sendMessage({type: "LINKPEEK_HISTORY_ADD", entry: historyEntry(item)} satisfies HistoryAddRequest).catch(() => undefined);
  }
  seen.add(item);
  void fingerprintsFor([item]).then(([print]) => {
    if (print) seen.addPicture(print);
  });
}

/** Forgets everything seen, addresses and pictures, in every tab. */
export function forgetSeenMedia() {
  return chrome.storage.local.remove(ALL_KEYS);
}
