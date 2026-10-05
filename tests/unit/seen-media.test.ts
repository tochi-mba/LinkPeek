import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {SEEN_KEYS, SEEN_LIMIT, SEEN_PREFIX, SeenMedia, forgetSeenMedia, mediaKey} from "../../src/shared/seen-media";

type Listener = (changes: Record<string, {newValue?: unknown}>, area: string) => void;
let store: Record<string, unknown>, listeners: Listener[];
const media = (path: string) => ({originalUrl: `https://cdn.test/${path}`});
const bucketOf = (path: string) => SEEN_PREFIX + mediaKey(media(path))[0];

beforeEach(() => {
  vi.useFakeTimers();
  store = {};
  listeners = [];
  vi.stubGlobal("chrome", {storage: {
    local: {
      get: vi.fn(async (keys: string[]) => Object.fromEntries(keys.map(key => [key, store[key]]))),
      set: vi.fn(async (values: Record<string, unknown>) => Object.assign(store, values)),
      remove: vi.fn(async (keys: string[]) => keys.forEach(key => delete store[key]))
    },
    onChanged: {
      addListener: vi.fn((listener: Listener) => listeners.push(listener)),
      removeListener: vi.fn((listener: Listener) => listeners.splice(listeners.indexOf(listener) >>> 0, 1))
    }
  }});
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("media keys", () => {
  it("are short and stable, and match the same picture at another size or with tracking parameters", () => {
    expect(mediaKey(media("a.jpg"))).toMatch(/^[0-9a-z]{14}$/);
    expect(mediaKey(media("a.jpg"))).toBe(mediaKey({originalUrl: "https://cdn.test/a.jpg?utm_source=x#top"}));
    expect(mediaKey(media("a.jpg"))).not.toBe(mediaKey(media("b.jpg")));
    expect(SEEN_KEYS).toHaveLength(36);
  });
});

describe("what has been seen", () => {
  it("is remembered, saved in small batches and merged with what other tabs stored", async () => {
    const seen = new SeenMedia();
    await seen.load();
    seen.add(media("a.jpg"));
    seen.add(media("a.jpg"));
    seen.add(media("b.jpg"));
    expect([seen.has(media("a.jpg")), seen.has(media("c.jpg")), seen.size]).toEqual([true, false, 2]);
    // Another tab saved meanwhile.
    store[bucketOf("a.jpg")] = ["othertab000000", 42];
    await vi.advanceTimersByTimeAsync(3000);
    expect(store[bucketOf("a.jpg")]).toEqual(expect.arrayContaining(["othertab000000", mediaKey(media("a.jpg"))]));
    expect(store[bucketOf("b.jpg")]).toContain(mediaKey(media("b.jpg")));
    const reloaded = new SeenMedia();
    await reloaded.load();
    await reloaded.load();
    expect(reloaded.has(media("b.jpg"))).toBe(true);
    await reloaded.flush();
  });

  it("keeps only the newest entries of each bucket", async () => {
    const seen = new SeenMedia(), bucket = SEEN_PREFIX + "0";
    store[bucket] = Array.from({length: SEEN_LIMIT / 36}, (_, i) => `old${i}`);
    await seen.load();
    let added = 0;
    for (let i = 0; added < 3; i++) {
      const item = media(`p${i}.jpg`);
      if (mediaKey(item)[0] !== "0") continue;
      seen.add(item);
      added++;
    }
    await seen.flush();
    const saved = store[bucket] as string[];
    expect([saved.length, saved[0], saved.includes("old2")]).toEqual([SEEN_LIMIT / 36, "old3", false]);
  });

  it("follows changes and clearing from elsewhere, and stops following when asked", async () => {
    const seen = new SeenMedia();
    await seen.load();
    seen.add(media("a.jpg"));
    for (const listener of listeners) {
      listener({[bucketOf("z.jpg")]: {newValue: [mediaKey(media("z.jpg"))]}, other: {newValue: 1}}, "local");
      listener({[bucketOf("z.jpg")]: {newValue: ["x"]}}, "sync");
    }
    expect(seen.has(media("z.jpg"))).toBe(true);
    await forgetSeenMedia();
    for (const listener of listeners) listener(Object.fromEntries(SEEN_KEYS.map(key => [key, {}])), "local");
    expect([seen.has(media("a.jpg")), seen.size]).toEqual([false, 0]);
    await vi.advanceTimersByTimeAsync(3000);
    expect(Object.keys(store)).toEqual([]);
    seen.stop();
    expect(listeners).toEqual([]);
    const late = new SeenMedia();
    const loading = late.load();
    late.stop();
    await loading;
    expect(listeners).toEqual([]);
  });

  it("carries on in memory when storage is unavailable", async () => {
    (chrome.storage.local.get as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("gone"));
    const seen = new SeenMedia();
    await seen.load();
    seen.add(media("a.jpg"));
    await seen.flush();
    expect(seen.has(media("a.jpg"))).toBe(true);
  });
});
