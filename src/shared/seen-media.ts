/**
 * Media LinkPeek has shown, remembered on this device so the shuffle never
 * shows it again.
 *
 * Each item is kept as a 64-bit hash of its canonical address, spread over 36
 * small storage buckets: recording one more item rewrites one bucket of a few
 * kilobytes, not the whole history. Writes are batched, merged with what other
 * tabs stored meanwhile, and each bucket keeps only its newest entries.
 */
import {canonicalMediaUrl, type MediaItem} from "./media";

export const SEEN_PREFIX = "seenMedia:";
/** Roughly how many items are remembered in all; the oldest are forgotten first. */
export const SEEN_LIMIT = 36_000;
const BUCKETS = "0123456789abcdefghijklmnopqrstuvwxyz";
const PER_BUCKET = SEEN_LIMIT / BUCKETS.length;
const SAVE_DELAY_MS = 3000;

/** Every storage key the history uses. */
export const SEEN_KEYS = [...BUCKETS].map(bucket => SEEN_PREFIX + bucket);

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
  private saveTimer: number | undefined;
  private loading?: Promise<void>;
  private stopped = false;

  /** Follows changes other tabs and the settings page make. */
  private onChanged = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
    if (area !== "local") return;
    for (const key of SEEN_KEYS) {
      if (!(key in changes)) continue;
      // Cleared elsewhere (the settings page): forget it here too, keeping nothing unsaved.
      if (changes[key].newValue === undefined) {
        this.buckets.delete(key);
        this.pending.delete(key);
      } else {
        this.merge(key, changes[key].newValue);
      }
    }
  };

  /** Reads the stored history once and starts following changes. */
  load() {
    this.loading ??= chrome.storage.local.get(SEEN_KEYS).then(stored => {
      for (const key of SEEN_KEYS) this.merge(key, stored[key]);
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
    const bucket = this.bucket(key);
    for (const entry of value) if (typeof entry === "string") bucket.add(entry);
  }

  private bucket(key: string) {
    let bucket = this.buckets.get(key);
    if (!bucket) this.buckets.set(key, bucket = new Set());
    return bucket;
  }

  has(item: Pick<MediaItem, "originalUrl">) {
    const key = mediaKey(item);
    return Boolean(this.buckets.get(SEEN_PREFIX + key[0])?.has(key));
  }

  add(item: Pick<MediaItem, "originalUrl">) {
    const key = mediaKey(item), storageKey = SEEN_PREFIX + key[0], bucket = this.bucket(storageKey);
    if (bucket.has(key)) return;
    bucket.add(key);
    let pending = this.pending.get(storageKey);
    if (!pending) this.pending.set(storageKey, pending = new Set());
    pending.add(key);
    if (this.saveTimer === undefined) this.saveTimer = window.setTimeout(() => void this.flush(), SAVE_DELAY_MS);
  }

  get size() {
    let size = 0;
    for (const bucket of this.buckets.values()) size += bucket.size;
    return size;
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
        update[key] = [...new Set([...previous, ...added])].slice(-PER_BUCKET);
      }
      await chrome.storage.local.set(update);
    } catch {
      // Storage unavailable (the extension was reloaded): this session still remembers in memory.
    }
  }
}

/** Forgets everything seen, in every tab. */
export function forgetSeenMedia() {
  return chrome.storage.local.remove(SEEN_KEYS);
}
