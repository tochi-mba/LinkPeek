/**
 * The offline media library: every picture, GIF and video LinkPeek shows is
 * saved on this device the first time, so the History page can show it later
 * without a connection and "Save all" can put the files in a folder.
 *
 * Files live in the extension's Cache Storage, keyed by the address they were
 * shown from. A small index (in extension storage, written in batches) records
 * each file's size and when it was saved, so the oldest go first once the
 * budget is reached. Saving runs two files at a time and never retries.
 */
import {fetchWithRetry, readBytesCapped} from "../core/http";
import {LIBRARY_CACHE} from "../shared/history";

export const LIBRARY_INDEX = "mediaIndex";
const CONCURRENCY = 2;
const INDEX_SAVE_DELAY_MS = 5000;

type IndexEntry = {bytes: number; at: number};

export class MediaLibrary {
  private index?: Promise<Map<string, IndexEntry>>;
  private indexTimer: ReturnType<typeof setTimeout> | undefined;
  private queue: Array<{url: string; budget: number}> = [];
  private queued = new Set<string>();
  private active = 0;

  private loadIndex() {
    this.index ??= chrome.storage.local.get(LIBRARY_INDEX).then(stored => {
      const raw = stored[LIBRARY_INDEX];
      const entries = Array.isArray(raw) ? raw.filter((entry): entry is [string, IndexEntry] => Array.isArray(entry) && typeof entry[0] === "string" && typeof entry[1]?.bytes === "number" && typeof entry[1]?.at === "number") : [];
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

  /** Queues a file to keep, within `budget` bytes for the whole library; files already kept are skipped. */
  save(url: string, budget: number) {
    if (!/^https?:/.test(url) || this.queued.has(url)) return;
    this.queued.add(url);
    this.queue.push({url, budget});
    this.pump();
  }

  private pump() {
    while (this.active < CONCURRENCY && this.queue.length) {
      const job = this.queue.shift()!;
      this.active++;
      void this.store(job.url, job.budget).catch(() => undefined).finally(() => {
        this.active--;
        this.queued.delete(job.url);
        this.pump();
      });
    }
  }

  private async store(url: string, budget: number) {
    const index = await this.loadIndex();
    if (index.has(url)) return;
    // One file may use at most a quarter of the budget, so a long video cannot push out everything else.
    const limit = Math.floor(budget / 4);
    const {bytes, type} = await fetchWithRetry(url, {credentials: "include"}, {mode: "background", timeoutMs: 60_000, read: async response => {
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return {bytes: await readBytesCapped(response, limit, "Too large to keep"), type: response.headers.get("content-type") ?? "application/octet-stream"};
    }});
    const cache = await caches.open(LIBRARY_CACHE);
    await cache.put(url, new Response(bytes, {headers: {"content-type": type, "content-length": String(bytes.byteLength)}}));
    index.set(url, {bytes: bytes.byteLength, at: Date.now()});
    await this.trim(budget);
    this.saveIndexSoon();
  }

  /** Removes the oldest files while the library is over `budget` bytes. */
  async trim(budget: number) {
    const index = await this.loadIndex();
    let total = 0;
    for (const entry of index.values()) total += entry.bytes;
    if (total <= budget) return;
    const cache = await caches.open(LIBRARY_CACHE);
    for (const [url, entry] of index) {
      if (total <= budget) break;
      index.delete(url);
      total -= entry.bytes;
      await cache.delete(url);
    }
    this.saveIndexSoon();
  }

  async stats() {
    const index = await this.loadIndex();
    let bytes = 0;
    for (const entry of index.values()) bytes += entry.bytes;
    return {count: index.size, bytes};
  }

  /** Forgets every saved file. */
  async clear() {
    this.queue = [];
    await caches.delete(LIBRARY_CACHE);
    (await this.loadIndex()).clear();
    await this.saveIndex();
  }
}
