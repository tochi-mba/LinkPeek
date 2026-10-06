import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {PRINT_PREFIX, SEEN_KEYS, SEEN_LIMIT, SEEN_PREFIX, SeenMedia, fingerprintsFor, forgetSeenMedia, mediaKey, recordSeen} from "../../src/shared/seen-media";

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

  it("starts a bucket afresh when nothing was stored in it", async () => {
    const seen = new SeenMedia();
    await seen.load();
    seen.add(media("fresh.jpg"));
    await seen.flush();
    expect(store[bucketOf("fresh.jpg")]).toEqual([mediaKey(media("fresh.jpg"))]);
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

describe("pictures seen", () => {
  it("are recognised again at a few bits' difference, saved, and followed across tabs", async () => {
    const seen = new SeenMedia();
    await seen.load();
    seen.addPicture("00000000000000ff");
    seen.addPicture("00000000000000ff");
    seen.addPicture("not a fingerprint");
    expect([seen.hasPicture("000000000000003f"), seen.hasPicture("ffffffff00000000"), seen.pictures]).toEqual([true, false, 1]);
    await seen.flush();
    expect(store[PRINT_PREFIX + "0"]).toEqual(["00000000000000ff"]);
    for (const listener of listeners) listener({[PRINT_PREFIX + "f"]: {newValue: ["ffffffffffffffff", "bad"]}}, "local");
    expect([seen.hasPicture("fffffffffffffff0"), seen.pictures]).toEqual([true, 2]);
    const fresh = new SeenMedia();
    await fresh.load();
    expect(fresh.hasPicture("00000000000000ff")).toBe(true);
  });
});

describe("recording what was shown", () => {
  const item = (n: number) => ({id: `i${n}`, type: "image" as const, originalUrl: `https://cdn.test/${n}.jpg`, previewUrl: `https://cdn.test/${n}-s.jpg`, sourceUrl: "https://a.test", score: 1});

  it("remembers the address and the picture, and logs first sightings to the history", async () => {
    const sendMessage = vi.fn(async (msg: {type: string}) => msg.type === "LINKPEEK_FINGERPRINT" ? {prints: ["00000000000000ff"]} : {ok: true});
    (chrome as unknown as {runtime: unknown}).runtime = {sendMessage};
    const seen = new SeenMedia();
    recordSeen(seen, item(1), {skipSeenMedia: true, keepHistory: true});
    recordSeen(seen, item(1), {skipSeenMedia: true, keepHistory: true});
    await vi.advanceTimersByTimeAsync(0);
    expect(sendMessage.mock.calls.filter(([msg]) => msg.type === "LINKPEEK_HISTORY_ADD")).toHaveLength(1);
    expect([seen.has(item(1)), seen.hasPicture("00000000000000ff")]).toEqual([true, true]);
    recordSeen(seen, item(2), {skipSeenMedia: false, keepHistory: false});
    expect(seen.has(item(2))).toBe(false);
    recordSeen(seen, item(3), {skipSeenMedia: true, keepHistory: false});
    expect(sendMessage.mock.calls.filter(([msg]) => msg.type === "LINKPEEK_HISTORY_ADD")).toHaveLength(1);
  });

  it("gets fingerprints for items, posters for videos, and gives up waiting when asked to be quick", async () => {
    let answer!: (value: unknown) => void;
    const sendMessage = vi.fn(() => new Promise(resolve => answer = resolve));
    (chrome as unknown as {runtime: unknown}).runtime = {sendMessage};
    expect(await fingerprintsFor([])).toEqual([]);
    const video = {...item(4), type: "video" as const, posterUrl: "https://cdn.test/poster.jpg"};
    const quick = fingerprintsFor([item(1), video, {...video, posterUrl: undefined}], 50);
    await vi.advanceTimersByTimeAsync(50);
    expect(await quick).toEqual([undefined, undefined, undefined]);
    expect(sendMessage).toHaveBeenCalledWith({type: "LINKPEEK_FINGERPRINT", urls: ["https://cdn.test/1-s.jpg", "https://cdn.test/poster.jpg", ""]});
    const patient = fingerprintsFor([item(1), item(2)]);
    answer({prints: ["0000000000000000", null]});
    expect(await patient).toEqual(["0000000000000000", undefined]);
    sendMessage.mockRejectedValueOnce(new Error("gone"));
    expect(await fingerprintsFor([item(1)])).toEqual([undefined]);
  });
});
