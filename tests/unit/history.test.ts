import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {HISTORY_CHUNK, HISTORY_LIMIT, HISTORY_META, HISTORY_PREFIX, HistoryWriter, historyEntry, readHistory, type HistoryEntry} from "../../src/shared/history";
import type {MediaItem} from "../../src/shared/media";

let store: Record<string, unknown>;
const item = (n: number, patch: Partial<MediaItem> = {}): MediaItem => ({
  id: `i${n}`, type: "image", originalUrl: `https://cdn.test/${n}.jpg`, previewUrl: `https://cdn.test/${n}-s.jpg`, sourceUrl: `https://a.test/post/${n}`, score: 1, ...patch
});

beforeEach(() => {
  vi.useFakeTimers();
  store = {};
  vi.stubGlobal("chrome", {storage: {local: {
    get: vi.fn(async (keys: string | string[]) => Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map(key => [key, store[key]]))),
    set: vi.fn(async (values: Record<string, unknown>) => Object.assign(store, structuredClone(values))),
    remove: vi.fn(async (keys: string | string[]) => (Array.isArray(keys) ? keys : [keys]).forEach(key => delete store[key]))
  }}});
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("history entries", () => {
  it("keep what is needed to show and reopen an item, compactly", () => {
    expect(historyEntry(item(1, {sourceTitle: "Trip"}), 5)).toEqual({a: 5, o: "https://cdn.test/1.jpg", p: "https://cdn.test/1-s.jpg", t: "image", s: "https://a.test/post/1", n: "Trip"});
    expect(historyEntry(item(2, {type: "video", posterUrl: "https://cdn.test/poster.jpg"}), 5).p).toBe("https://cdn.test/poster.jpg");
    expect(historyEntry(item(3, {type: "video"}), 5)).not.toHaveProperty("n");
    expect(historyEntry(item(3, {type: "video"}), 5).p).toBe("");
  });
});

describe("the history", () => {
  it("is written in batches and read back newest first", async () => {
    const writer = new HistoryWriter();
    writer.add(historyEntry(item(1), 1));
    writer.add(historyEntry(item(2), 2));
    expect(await readHistory()).toEqual([]);
    await vi.advanceTimersByTimeAsync(2000);
    expect((await readHistory()).map(entry => entry.a)).toEqual([2, 1]);
    await writer.flush();
  });

  it("starts a new chunk when one is full and drops the oldest past the limit", async () => {
    const writer = new HistoryWriter(0);
    for (let i = 0; i < HISTORY_LIMIT + HISTORY_CHUNK; i++) writer.add(historyEntry(item(i), i));
    await writer.flush();
    const meta = store[HISTORY_META] as {first: number; last: number};
    expect((meta.last - meta.first + 1) * HISTORY_CHUNK).toBeLessThanOrEqual(HISTORY_LIMIT);
    expect(store[HISTORY_PREFIX + "0"]).toBeUndefined();
    const all = await readHistory();
    expect(all[0].a).toBe(HISTORY_LIMIT + HISTORY_CHUNK - 1);
    expect(all.length).toBeLessThanOrEqual(HISTORY_LIMIT);
  }, 60_000);

  it("strikes picked entries from their chunks, leaving the rest untouched", async () => {
    const writer = new HistoryWriter(0);
    for (let i = 0; i < 3; i++) writer.add({a: i, o: `https://cdn.test/${i}.jpg`, p: "", t: "image", s: "https://x.test"});
    await writer.flush();
    const sets = (chrome.storage.local.set as ReturnType<typeof vi.fn>).mock.calls.length;
    // A fresh writer reads the meta anew; a chunk the meta promises but storage lost is simply skipped.
    (store[HISTORY_META] as {last: number}).last = 1;
    const remover = new HistoryWriter(0);
    await remover.remove([{a: 1, o: "https://cdn.test/1.jpg"}, {a: 9, o: "https://cdn.test/none.jpg"}]);
    expect((await readHistory()).map(entry => entry.o)).toEqual(["https://cdn.test/2.jpg", "https://cdn.test/0.jpg"]);
    // Nothing matched: nothing is written.
    await remover.remove([{a: 9, o: "https://cdn.test/none.jpg"}]);
    expect((chrome.storage.local.set as ReturnType<typeof vi.fn>).mock.calls.length).toBe(sets + 1);
  });

  it("carries on from what an earlier session stored, ignores broken data, and clears", async () => {
    store[HISTORY_META] = {first: 3, last: 3};
    store[HISTORY_PREFIX + "3"] = [historyEntry(item(1), 1), {broken: true}];
    const writer = new HistoryWriter(0);
    writer.add(historyEntry(item(2), 2));
    await writer.flush();
    expect((await readHistory()).map(entry => entry.a)).toEqual([2, 1]);
    await writer.clear();
    expect(store).toEqual({});
    expect(await readHistory()).toEqual([]);
    writer.add(historyEntry(item(4), 4));
    await writer.clear();
    store[HISTORY_META] = {first: 5, last: 2};
    expect(await readHistory()).toEqual([]);
    store[HISTORY_META] = {first: 0, last: 0};
    store[HISTORY_PREFIX + "0"] = "corrupt";
    expect(await readHistory()).toEqual([]);
  });
});

export type {HistoryEntry};

describe("pruning the history", () => {
  const seenEntry = (n: number, patch: Partial<HistoryEntry> = {}): HistoryEntry => ({a: n, o: `https://cdn.test/${n}.jpg`, p: `https://cdn.test/${n}-s.jpg`, t: "image", s: "https://x.test", ...patch});
  const small = (w: number, h: number) => w < 50 || h < 50;

  it("strikes every sighting of one address", async () => {
    const writer = new HistoryWriter(0);
    for (const entry of [seenEntry(1), seenEntry(2), seenEntry(3, {o: "https://cdn.test/1.jpg"})]) writer.add(entry);
    await writer.flush();
    await writer.removeAddress("https://cdn.test/1.jpg");
    expect((await readHistory()).map(entry => entry.a)).toEqual([2]);
  });

  it("sizes the unsized once, drops the too small, keeps the sizes it learned, and leaves videos alone", async () => {
    const writer = new HistoryWriter(0);
    for (const entry of [seenEntry(1), seenEntry(2), seenEntry(3, {t: "video", p: ""}), seenEntry(4, {w: 10, h: 10}), seenEntry(5), seenEntry(6, {w: 900})]) writer.add(entry);
    await writer.flush();
    const sizes: Record<string, {w: number; h: number} | undefined> = {"https://cdn.test/1-s.jpg": {w: 20, h: 20}, "https://cdn.test/2-s.jpg": {w: 800, h: 600}};
    const size = vi.fn(async (entry: HistoryEntry) => sizes[entry.p]);
    const ticks: unknown[] = [];
    expect(await writer.audit(size, small, tick => ticks.push(tick))).toEqual({checked: 6, removed: 3});
    // Entry 4 already had a size; the video is never measured.
    expect(size.mock.calls.map(([entry]) => entry.a)).toEqual([1, 2, 5]);
    // Entry 6 had only a width on record: a missing height counts as unknown, and it is judged on its width.
    const left = await readHistory();
    expect(left.map(entry => entry.a)).toEqual([5, 3, 2]);
    expect(left.find(entry => entry.a === 2)).toMatchObject({w: 800, h: 600});
    // Entry 5 could not be sized, so it stays as it was, to be tried again next time.
    expect(left.find(entry => entry.a === 5)!.w).toBeUndefined();
    expect(ticks).toHaveLength(6);
    expect(ticks.at(-1)).toMatchObject({checked: 6, total: 6, removed: 3, url: "https://cdn.test/6-s.jpg", resting: 0});
    // A second check measures only what is still unsized.
    size.mockClear();
    expect(await writer.audit(size, small)).toEqual({checked: 3, removed: 0});
    expect(size.mock.calls.map(([entry]) => entry.a)).toEqual([5]);
  });

  it("keeps what was added during a check, rests after slow steps, and skips a lost chunk", async () => {
    const writer = new HistoryWriter(0);
    writer.add(seenEntry(1));
    await writer.flush();
    let release!: () => void;
    const size = vi.fn(async () => {
      // While this entry is being measured, the page records another sighting, and measuring takes a while.
      writer.add(seenEntry(9));
      await writer.flush();
      vi.setSystemTime(Date.now() + 400);
      await new Promise<void>(resolve => release = resolve);
      return {w: 10, h: 10};
    });
    const ticks: Array<{resting: number}> = [];
    const done = writer.audit(size, small, tick => ticks.push(tick));
    await vi.advanceTimersByTimeAsync(0);
    release();
    await vi.advanceTimersByTimeAsync(400);
    expect(await done).toEqual({checked: 1, removed: 1});
    expect(ticks[0].resting).toBe(400);
    expect((await readHistory()).map(entry => entry.a)).toEqual([9]);
    // The meta promises a chunk storage no longer holds: the check passes over it.
    (store[HISTORY_META] as {last: number}).last = 1;
    const fresh = new HistoryWriter(0);
    expect(await fresh.audit(async () => ({w: 5, h: 5}), small)).toEqual({checked: 1, removed: 1});
    expect(await readHistory()).toEqual([]);
  });

  it("drops a rewrite whose chunk vanished mid-check", async () => {
    const writer = new HistoryWriter(0);
    writer.add(seenEntry(1));
    await writer.flush();
    const done = writer.audit(async () => {
      delete store[`${HISTORY_PREFIX}0`];
      return {w: 5, h: 5};
    }, small);
    await vi.advanceTimersByTimeAsync(0);
    expect(await done).toEqual({checked: 1, removed: 1});
    expect(store[`${HISTORY_PREFIX}0`]).toBeUndefined();
  });

  it("queues every write, so a failed one does not stop the next", async () => {
    const writer = new HistoryWriter(0);
    (chrome.storage.local.set as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("quota"));
    writer.add(seenEntry(1));
    await expect(writer.flush()).rejects.toThrow("quota");
    writer.add(seenEntry(2));
    await writer.flush();
    expect((await readHistory()).map(entry => entry.a)).toEqual([2]);
  });
});
