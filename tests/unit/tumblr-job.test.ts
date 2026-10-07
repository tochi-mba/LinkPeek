import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {MEDIA_ACCEPT, TUMBLR_JOB, TUMBLR_SAVED_PREFIX, TumblrDownloader, type TumblrJobState} from "../../src/background/tumblr-job";
import type {TumblrMedia} from "../../src/core/tumblr";

let local: Record<string, unknown>;
let session: Record<string, unknown>;
let changes: Array<(delta: chrome.downloads.DownloadDelta) => void>;

const state = (phase: TumblrJobState["phase"] = "collecting"): TumblrJobState => ({
  blog: "demo", phase, posts: 0, total: 0, found: 0, saved: 0, failed: 0, skipped: 0, collected: false
});
const media = (key = "a"): TumblrMedia => ({
  key, url: `https://64.media.tumblr.com/${key}.jpg`, ext: "jpg", kind: "image", postId: "10", at: 0, index: 1
});
const eventually = async (predicate: () => boolean) => {
  for (let i = 0; i < 100 && !predicate(); i++) await new Promise(resolve => setTimeout(resolve, 0));
  expect(predicate()).toBe(true);
};

beforeEach(() => {
  local = {};
  session = {};
  changes = [];
  vi.stubGlobal("chrome", {
    storage: {
      local: {
        get: vi.fn(async (key: string) => ({[key]: local[key]})),
        set: vi.fn(async (values: Record<string, unknown>) => Object.assign(local, values)),
        remove: vi.fn(async (key: string) => { delete local[key]; })
      },
      session: {
        get: vi.fn(async (key: string) => ({[key]: session[key]})),
        set: vi.fn(async (values: Record<string, unknown>) => Object.assign(session, values))
      }
    },
    action: {setBadgeText: vi.fn(async () => undefined)},
    downloads: {
      download: vi.fn(async () => 7),
      search: vi.fn(async () => []),
      onChanged: {addListener: vi.fn((listener: (delta: chrome.downloads.DownloadDelta) => void) => changes.push(listener))}
    }
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("Tumblr download state", () => {
  it("reports live, completed, suspended and absent jobs", async () => {
    const downloader = new TumblrDownloader();
    expect(await downloader.status()).toBeUndefined();
    session[TUMBLR_JOB] = state("done");
    expect((await downloader.status())?.phase).toBe("done");
    session[TUMBLR_JOB] = state();
    expect((await downloader.status())?.phase).toBe("stopped");

    let release!: () => void;
    (downloader as any).token = vi.fn(() => new Promise<string>(resolve => release = () => resolve("token")));
    const live = downloader.start("live");
    expect(downloader.start("other")).toBe(live);
    expect(await downloader.status()).toBe(live);
    await eventually(() => typeof release === "function");
    downloader.stop();
    release();
    await eventually(() => live.phase === "stopped");
    downloader.stop();
  });

  it("forgets a blog and publishes both halves of progress despite storage and badge failures", async () => {
    const downloader = new TumblrDownloader();
    local[TUMBLR_SAVED_PREFIX + "demo"] = ["x"];
    await downloader.forget("demo");
    expect(local).toEqual({});

    const collecting = {...state(), posts: 5, total: 10};
    await (downloader as any).publish(collecting);
    expect(chrome.action.setBadgeText).toHaveBeenLastCalledWith({text: "25%"});
    const done = {...state("done"), collected: true, found: 0};
    await (downloader as any).publish(done);
    expect(chrome.action.setBadgeText).toHaveBeenLastCalledWith({text: ""});

    vi.mocked(chrome.storage.session.set).mockRejectedValueOnce(new Error("closed"));
    vi.mocked(chrome.action.setBadgeText).mockRejectedValueOnce(new Error("closed"));
    await expect((downloader as any).publish({...state(), posts: 999, total: 1})).resolves.toBeUndefined();
    expect(chrome.action.setBadgeText).toHaveBeenLastCalledWith({text: "99%"});
    (chrome as any).action = undefined;
    await expect((downloader as any).publish(state())).resolves.toBeUndefined();
  });
});

describe("Tumblr HTTP handling", () => {
  it("reads a token and explains missing, private and nonexistent blogs", async () => {
    const downloader = new TumblrDownloader();
    vi.stubGlobal("fetch", vi.fn(async () => new Response('{"API_TOKEN":"Token12"}', {status: 200})));
    await expect((downloader as any).token("a/b")).resolves.toBe("Token12");
    expect(fetch).toHaveBeenCalledWith("https://www.tumblr.com/a%2Fb", {credentials: "include"});
    vi.mocked(fetch).mockResolvedValueOnce(new Response("", {status: 404}));
    await expect((downloader as any).token("gone")).rejects.toThrow("doesn't exist");
    vi.mocked(fetch).mockResolvedValueOnce(new Response("no token", {status: 200}));
    await expect((downloader as any).token("odd")).rejects.toThrow("(200)");
    vi.mocked(fetch).mockResolvedValueOnce(new Response("no", {status: 500}));
    await expect((downloader as any).token("private")).rejects.toThrow("(500)");
  });

  it("returns JSON, refreshes refused credentials and rejects persistent refusal", async () => {
    const downloader = new TumblrDownloader();
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(new Response('{"ok":1}', {status: 200}))
      .mockResolvedValueOnce(new Response("", {status: 401}))
      .mockResolvedValueOnce(new Response('{"fresh":1}', {status: 200}))
      .mockResolvedValueOnce(new Response("", {status: 403}))
      .mockResolvedValueOnce(new Response("", {status: 401})));
    await expect((downloader as any).page("/first", "old", vi.fn())).resolves.toEqual({ok: 1});
    const refresh = vi.fn(async () => "new");
    await expect((downloader as any).page("/again", "old", refresh)).resolves.toEqual({fresh: 1});
    expect(refresh).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenLastCalledWith("https://www.tumblr.com/api/again", {credentials: "include", headers: {Authorization: "Bearer new"}});
    await expect((downloader as any).page("/bad", "old", refresh)).rejects.toThrow("(401)");
  });

  it("waits out rate limits with explicit and fallback delays, then gives up", async () => {
    vi.useFakeTimers();
    const downloader = new TumblrDownloader();
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(new Response("", {status: 429, headers: {"retry-after": "0.001"}}))
      .mockResolvedValueOnce(new Response('{}', {status: 200})));
    const quick = (downloader as any).page("/limited", "t", vi.fn());
    await vi.advanceTimersByTimeAsync(1);
    await expect(quick).resolves.toEqual({});

    vi.mocked(fetch).mockReset();
    for (let i = 0; i < 6; i++) vi.mocked(fetch).mockResolvedValueOnce(new Response("", {status: 429, headers: {"retry-after": "bad"}}));
    const exhausted = (downloader as any).page("/limited", "t", vi.fn());
    const rejection = expect(exhausted).rejects.toThrow("(429)");
    await vi.advanceTimersByTimeAsync(15_000 + 30_000 + 45_000 + 60_000 + 75_000);
    await rejection;

    vi.mocked(fetch).mockResolvedValueOnce(new Response("", {status: 500}));
    await expect((downloader as any).page("/broken", "t", vi.fn())).rejects.toThrow("(500)");
  });
});

describe("saving and running jobs", () => {
  it("waits for successful and interrupted downloads and handles startup and search failures", async () => {
    const downloader = new TumblrDownloader();
    const search = chrome.downloads.search as unknown as ReturnType<typeof vi.fn>;
    search.mockResolvedValueOnce([{id: 7, state: "complete"}] as chrome.downloads.DownloadItem[]);
    const successful = (downloader as any).save("demo", media());
    downloader.onDownloadChanged({id: 7, state: {current: "in_progress"}} as chrome.downloads.DownloadDelta);
    await expect(successful).resolves.toBe(true);
    expect(chrome.downloads.download).toHaveBeenCalledWith(expect.objectContaining({
      url: media().url,
      filename: "LinkPeek/Tumblr/demo/undated 10-1.jpg",
      headers: [{name: "Accept", value: MEDIA_ACCEPT}]
    }));

    search.mockResolvedValueOnce([{id: 7, state: "interrupted"}] as chrome.downloads.DownloadItem[]);
    await expect((downloader as any).save("demo", media("b"))).resolves.toBe(false);
    vi.mocked(chrome.downloads.download).mockRejectedValueOnce(new Error("denied"));
    await expect((downloader as any).save("demo", media("c"))).resolves.toBe(false);

    search.mockRejectedValueOnce(new Error("gone"));
    const searched = (downloader as any).save("demo", media("d"));
    await eventually(() => search.mock.calls.length >= 3);
    downloader.onDownloadChanged({id: 7, state: {current: "interrupted"}} as chrome.downloads.DownloadDelta);
    await expect(searched).resolves.toBe(false);
  });

  it("times out a download", async () => {
    vi.useFakeTimers();
    const downloader = new TumblrDownloader();
    const saving = (downloader as any).save("demo", media());
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    await expect(saving).resolves.toBe(false);
  });

  it("collects pages, skips ads and duplicates, saves in parallel and remembers progress", async () => {
    local[TUMBLR_SAVED_PREFIX + "demo"] = ["old"];
    const downloader = new TumblrDownloader();
    (downloader as any).token = vi.fn(async () => "token");
    const blocks = [
      {type: "image", media: [{url: "https://64.media.tumblr.com/old.jpg", media_key: "old"}]},
      ...Array.from({length: 27}, (_, i) => ({type: "image", media: [{url: `https://64.media.tumblr.com/k${i}.jpg`, media_key: `k${i}`}]})),
      {type: "image", media: [{url: "https://64.media.tumblr.com/repeated.jpg", media_key: "k0"}]}
    ];
    (downloader as any).page = vi.fn()
      .mockResolvedValueOnce({response: {total_posts: 2, posts: [
        {object_type: "ad", id_string: "ad"},
        {object_type: "post", id_string: "10", content: blocks},
        {object_type: "post", id_string: "11", content: [{type: "image", media: [{url: "https://64.media.tumblr.com/repeated-again.jpg", media_key: "k0"}]}]}
      ], _links: {next: {href: "/next"}}}})
      .mockResolvedValueOnce({response: {total_posts: 0, posts: []}});
    (downloader as any).save = vi.fn(async (_blog: string, item: TumblrMedia) => item.key !== "k26");
    const running = downloader.start("demo");
    await eventually(() => running.phase === "done");
    expect(running).toMatchObject({posts: 2, total: 2, found: 27, saved: 26, failed: 1, skipped: 2, collected: true});
    expect((downloader as any).page).toHaveBeenCalledTimes(2);
    expect(new Set(local[TUMBLR_SAVED_PREFIX + "demo"] as string[])).toEqual(new Set(["old", ...Array.from({length: 26}, (_, i) => `k${i}`)]));
    expect(chrome.storage.local.set).toHaveBeenCalled();
  });

  it("finishes empty jobs and records failures even when storage writes fail", async () => {
    const empty = new TumblrDownloader();
    (empty as any).token = vi.fn(async () => "token");
    (empty as any).page = vi.fn(async () => ({response: {posts: [], total_posts: 0}}));
    const done = empty.start("empty");
    await eventually(() => done.phase === "done");

    local[TUMBLR_SAVED_PREFIX + "bad"] = "not an array";
    vi.mocked(chrome.storage.local.set).mockRejectedValue(new Error("full"));
    const failed = new TumblrDownloader();
    (failed as any).token = vi.fn(async () => { throw new Error("network down"); });
    const result = failed.start("bad");
    await eventually(() => result.phase === "failed");
    expect(result).toMatchObject({error: "network down", collected: true});
  });
});
