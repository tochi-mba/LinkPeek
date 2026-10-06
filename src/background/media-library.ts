/**
 * The offline media library: the files of every gallery LinkPeek prepares or
 * shows are saved on this device, so the History page can show them later
 * without a connection and "Save all" can put them in a folder.
 *
 * Files live in the extension's Cache Storage, keyed by the address they are
 * shown from. A small index (in extension storage, written in batches) records
 * each file's size, when it was saved, whether it has been seen, and where it
 * came from. Files being looked at jump the queue ahead of prepared ones; once
 * the budget is reached, files never seen go first, oldest first, and seen
 * ones only after them. Saving runs two files at a time and never retries.
 */
import {fetchWithRetry, readBytesCapped} from "../core/http";
import {LIBRARY_CACHE, LIBRARY_INDEX, type LibraryEntry} from "../shared/history";

const CONCURRENCY = 2;
const INDEX_SAVE_DELAY_MS = 5000;

/** What is known about a file before it is saved. */
export type LibraryMeta = Omit<LibraryEntry, "bytes" | "at">;
type Job = {url: string; budget: number; meta: LibraryMeta};

function isEntry(value: unknown): value is [string, LibraryEntry] {
  const pair = value as [string, LibraryEntry];
  return Array.isArray(pair) && typeof pair[0] === "string" && typeof pair[1]?.bytes === "number" && typeof pair[1]?.at === "number";
}

export class MediaLibrary {
  private index?: Promise<Map<string, LibraryEntry>>;
  private indexTimer: ReturnType<typeof setTimeout> | undefined;
  private queue: Job[] = [];
  private queued = new Map<string, Job>();
  private active = 0;

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
   * Queues a file to keep, within `budget` bytes for the whole library. A file
   * being looked at goes ahead of prepared ones; a file already kept is only
   * marked seen.
   */
  save(url: string, budget: number, meta: LibraryMeta) {
    if (!/^https?:/.test(url)) return;
    const waiting = this.queued.get(url);
    if (waiting) {
      if (meta.seen && !waiting.meta.seen) {
        waiting.meta.seen = true;
        this.queue.splice(this.queue.indexOf(waiting), 1);
        this.queue.unshift(waiting);
      }
      return;
    }
    const job: Job = {url, budget, meta: {...meta}};
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

  private async store({url, budget, meta}: Job) {
    const index = await this.loadIndex(), kept = index.get(url);
    if (kept) {
      if (meta.seen && !kept.seen) {
        kept.seen = true;
        this.saveIndexSoon();
      }
      return;
    }
    // One file may use at most a quarter of the budget, so a long video cannot push out everything else.
    const {bytes, type} = await fetchWithRetry(url, {credentials: "include"}, {mode: "background", timeoutMs: 60_000, read: async response => {
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return {bytes: await readBytesCapped(response, Math.floor(budget / 4), "Too large to keep"), type: response.headers.get("content-type") ?? "application/octet-stream"};
    }});
    const cache = await caches.open(LIBRARY_CACHE);
    await cache.put(url, new Response(bytes, {headers: {"content-type": type, "content-length": String(bytes.byteLength)}}));
    index.set(url, {...meta, bytes: bytes.byteLength, at: Date.now()});
    await this.trim(budget);
    this.saveIndexSoon();
  }

  /** Removes files while the library is over `budget` bytes: never-seen ones first, oldest first, then seen ones. */
  async trim(budget: number) {
    const index = await this.loadIndex();
    let total = 0;
    for (const entry of index.values()) total += entry.bytes;
    if (total <= budget) return;
    const cache = await caches.open(LIBRARY_CACHE);
    const order = [...index].sort((a, b) => Number(a[1].seen !== false) - Number(b[1].seen !== false));
    for (const [url, entry] of order) {
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
    this.queued.clear();
    await caches.delete(LIBRARY_CACHE);
    (await this.loadIndex()).clear();
    await this.saveIndex();
  }
}
