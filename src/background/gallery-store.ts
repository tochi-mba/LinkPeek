/**
 * Galleries kept on this device, so a link opened or prepared before shows at
 * once, even after the browser restarts, without fetching anything again.
 *
 * Each gallery is one storage entry keyed by its link. A small index of when
 * each was saved and how big it is lets the oldest be dropped first; it is
 * written in batches, not on every save. Entries older than the configured
 * number of days are ignored and removed when next touched.
 */
import type {ScanResult} from "../shared/media";

export const GALLERY_PREFIX = "gallery:";
export const GALLERY_INDEX = "galleryIndex";
/** Most galleries kept; past this the least recently saved go first. */
export const GALLERY_LIMIT = 3000;
/** Most bytes kept, roughly; a long forum thread can be a few hundred kilobytes. */
export const GALLERY_BYTES = 256 * 1024 * 1024;
const INDEX_SAVE_DELAY_MS = 5000;

export interface StoredGallery {
  url: string;
  /** The scan settings it was made with; a gallery made differently is not reused. */
  scanKey: string;
  at: number;
  result: ScanResult;
}

type IndexEntry = {at: number; bytes: number};

export class GalleryStore {
  private index?: Promise<Map<string, IndexEntry>>;
  private indexTimer: ReturnType<typeof setTimeout> | undefined;

  private loadIndex() {
    this.index ??= chrome.storage.local.get(GALLERY_INDEX).then(stored => {
      const raw = stored[GALLERY_INDEX];
      const entries = Array.isArray(raw) ? raw.filter((entry): entry is [string, IndexEntry] => Array.isArray(entry) && typeof entry[0] === "string" && typeof entry[1]?.at === "number" && typeof entry[1]?.bytes === "number") : [];
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
    const index = await this.loadIndex();
    await chrome.storage.local.set({[GALLERY_INDEX]: [...index]});
  }

  /** A gallery saved within `maxAgeMs` with the same scan settings, or undefined. */
  async get(url: string, scanKey: string, maxAgeMs: number): Promise<StoredGallery | undefined> {
    const key = GALLERY_PREFIX + url, stored = (await chrome.storage.local.get(key))[key] as StoredGallery | undefined;
    if (!stored || stored.url !== url) return undefined;
    if (Date.now() - stored.at > maxAgeMs) {
      await this.delete(url);
      return undefined;
    }
    return stored.scanKey === scanKey ? stored : undefined;
  }

  /** Saves a gallery, dropping the oldest ones while over the count or size limit. */
  async put(url: string, scanKey: string, result: ScanResult) {
    const entry: StoredGallery = {url, scanKey, at: Date.now(), result};
    const bytes = JSON.stringify(entry).length, index = await this.loadIndex();
    if (bytes > GALLERY_BYTES / 16) return;
    await chrome.storage.local.set({[GALLERY_PREFIX + url]: entry});
    index.delete(url);
    index.set(url, {at: entry.at, bytes});
    let total = 0;
    for (const value of index.values()) total += value.bytes;
    const dropped: string[] = [];
    for (const [oldest, value] of index) {
      if (index.size <= GALLERY_LIMIT && total <= GALLERY_BYTES) break;
      index.delete(oldest);
      total -= value.bytes;
      dropped.push(GALLERY_PREFIX + oldest);
    }
    if (dropped.length) await chrome.storage.local.remove(dropped);
    this.saveIndexSoon();
  }

  async delete(url: string) {
    const index = await this.loadIndex();
    index.delete(url);
    await chrome.storage.local.remove(GALLERY_PREFIX + url);
    this.saveIndexSoon();
  }

  /** How many galleries are kept and roughly how many bytes they take. */
  async stats() {
    const index = await this.loadIndex();
    let bytes = 0;
    for (const value of index.values()) bytes += value.bytes;
    return {count: index.size, bytes};
  }

  /** Forgets every saved gallery. */
  async clear() {
    const index = await this.loadIndex();
    await chrome.storage.local.remove([...index.keys()].map(url => GALLERY_PREFIX + url));
    index.clear();
    await this.saveIndex();
  }
}
