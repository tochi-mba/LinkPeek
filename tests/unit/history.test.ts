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
