import {beforeEach, describe, expect, it, vi} from "vitest";
import {importTumblrDownloads, localFileUrl, tumblrDownload} from "../../src/background/tumblr-import";
import {mediaKey, SEEN_PREFIX} from "../../src/shared/seen-media";

const record = (patch: Partial<chrome.downloads.DownloadItem> = {}) => ({
  id: 7, url: "https://64.media.tumblr.com/demo.mp4", filename: "C:\\Users\\rex\\Downloads\\LinkPeek\\Tumblr\\Demo-Blog\\2026-10-07 829824340399882240-1.mp4",
  danger: "safe", incognito: false, mime: "video/mp4", startTime: "2026-10-08T10:00:00Z", state: "complete", paused: false,
  canResume: false, bytesReceived: 123, totalBytes: 123, fileSize: 123, exists: true,
  ...patch
} as chrome.downloads.DownloadItem);

let search: ReturnType<typeof vi.fn>, get: ReturnType<typeof vi.fn>;

beforeEach(() => {
  search = vi.fn(async () => []);
  get = vi.fn(async () => ({}));
  vi.stubGlobal("chrome", {downloads: {search}, storage: {local: {get}}});
});

describe("existing Tumblr downloads", () => {
  it("recognises Windows and Unix file paths, dates, kinds and fallback metadata", () => {
    expect(localFileUrl("C:\\A folder\\clip #1.mp4")).toBe("file:///C:/A%20folder/clip%20%231.mp4");
    expect(localFileUrl("/home/rex/clip.mp4")).toBe("file:///home/rex/clip.mp4");
    expect(tumblrDownload(record())).toMatchObject({
      url: "https://64.media.tumblr.com/demo.mp4", local: "file:///C:/Users/rex/Downloads/LinkPeek/Tumblr/Demo-Blog/2026-10-07%20829824340399882240-1.mp4",
      blog: "demo-blog", postId: "829824340399882240", type: "video", bytes: 123, dl: 7
    });
    expect(tumblrDownload(record({filename: "/Downloads/LinkPeek/Tumblr/demo/undated 42-2.gif", mime: "image/gif", fileSize: undefined, totalBytes: 9, endTime: "2025-02-03T04:05:06Z"}))).toMatchObject({type: "gif", bytes: 9, at: Date.parse("2025-02-03T04:05:06Z")});
    expect(tumblrDownload(record({filename: "/Downloads/LinkPeek/Tumblr/demo/undated 42-2.jif", mime: "image/jpeg", fileSize: -1, totalBytes: undefined, startTime: "broken"}))).toMatchObject({type: "image", bytes: 0});
    expect(tumblrDownload(record({filename: "/Downloads/LinkPeek/Tumblr/demo/2026-01-02 42-1.m4a", mime: undefined, finalUrl: "https://va.media.tumblr.com/audio", fileSize: 4}))).toMatchObject({url: "https://va.media.tumblr.com/audio", type: "audio"});
    expect(tumblrDownload(record({filename: "/Downloads/LinkPeek/Tumblr/demo/2026-01-02 42-1.mov", mime: "application/octet-stream"}))).toMatchObject({type: "video"});
  });

  it("ignores unfinished, missing, unrelated, unsupported and non-web downloads", () => {
    expect(tumblrDownload(record({state: "in_progress"}))).toBeUndefined();
    expect(tumblrDownload(record({exists: false}))).toBeUndefined();
    expect(tumblrDownload(record({filename: "C:\\Downloads\\other.mp4"}))).toBeUndefined();
    expect(tumblrDownload(record({filename: "/Downloads/LinkPeek/Tumblr/demo/2026-01-02 42-1.exe"}))).toBeUndefined();
    expect(tumblrDownload(record({url: "file:///clip.mp4"}))).toBeUndefined();
  });

  it("imports the newest record per URL, carries seen state, and reports only new rows", async () => {
    const first = record(), duplicate = record({id: 8, filename: first.filename.replace("-1.mp4", "-2.mp4")});
    const audio = record({id: 9, url: "https://va.media.tumblr.com/sound.ogg", filename: "/Downloads/LinkPeek/Tumblr/music/undated 99-1.ogg", mime: "audio/ogg", fileSize: undefined, totalBytes: undefined});
    search.mockResolvedValue([first, duplicate, audio, record({id: 10, state: "interrupted"})]);
    const key = mediaKey({originalUrl: first.url});
    get.mockResolvedValue({[SEEN_PREFIX + key[0]]: [key]});
    const library = {importExternal: vi.fn().mockResolvedValueOnce("saved").mockResolvedValueOnce("existing"), saveIndex: vi.fn(async () => undefined)};
    expect(await importTumblrDownloads(library as never)).toEqual({found: 2, imported: 1});
    expect(library.importExternal).toHaveBeenCalledTimes(2);
    expect(library.importExternal.mock.calls[0][1]).toMatchObject({seen: true, type: "video", dl: 7, diskBytes: 123, external: true});
    expect(library.importExternal.mock.calls[1][1]).toMatchObject({seen: false, type: "audio", diskBytes: 0});
    expect(library.saveIndex).toHaveBeenCalledOnce();
  });

  it("fails soft when Downloads cannot be searched and has nothing to write", async () => {
    search.mockRejectedValue(new Error("downloads unavailable"));
    const library = {importExternal: vi.fn(), saveIndex: vi.fn()};
    expect(await importTumblrDownloads(library as never)).toEqual({found: 0, imported: 0});
    expect([get.mock.calls.length, library.saveIndex.mock.calls.length]).toEqual([0, 0]);
  });
});
