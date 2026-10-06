import {describe, expect, it} from "vitest";
import type {MediaItem, ScanResult} from "../../src/shared/media";
import {DEFAULT_SHORTCUTS, resolveSettings} from "../../src/shared/settings";
import * as markup from "../../src/ui/viewer-markup";

const settings = resolveSettings({});
const item = (patch: Partial<MediaItem> = {}): MediaItem => ({id: "1", type: "image", originalUrl: "https://x.test/o.jpg", previewUrl: "https://x.test/p.jpg", sourceUrl: "https://x.test/t/1/2", score: 1, ...patch});
const result = (patch: Partial<ScanResult> = {}): ScanResult => ({url: "https://x.test/t/1", kind: "discourse", items: [item(), item({id: "2"})], complete: true, ...patch});
const html = (markupString: string) => {
  const el = document.createElement("div");
  el.innerHTML = markupString;
  return el;
};
const header = (patch: Partial<markup.HeaderState> = {}) => html(markup.headerMarkup({title: "Thread", count: 2, view: "focus", expanded: false, pinned: false, favorite: false, slideshow: false, slideshowPaused: false, popped: false, help: false, settings, ...patch}));

describe("key hints", () => {
  it("show up to two bindings", () => {
    expect(markup.keyHint(DEFAULT_SHORTCUTS, "grid")).toBe("G");
    expect(markup.keyHint(DEFAULT_SHORTCUTS, "next")).toBe("↓ / →");
    expect(markup.keyHint({...DEFAULT_SHORTCUTS, grid: []}, "grid")).toBe("");
  });
});

describe("the header", () => {
  it("names the title, count and each control with its shortcut", () => {
    const el = header({title: "<Thread>"});
    expect(el.querySelector(".lp-title")!.textContent).toBe("<Thread>");
    expect(el.querySelector(".lp-meta")!.textContent).toBe("2");
    expect(el.querySelector("[data-action=grid]")!.getAttribute("title")).toBe("Grid (G)");
    expect(el.querySelector("[data-action=help]")!.getAttribute("aria-expanded")).toBe("false");
    expect(el.querySelector("[data-action=pin]")!.getAttribute("aria-pressed")).toBe("false");
    expect(el.querySelector("[data-action=grid-bigger]")).toBeNull();
    expect(header({count: undefined}).querySelector(".lp-meta")!.textContent).toBe("");
  });

  it("reflects grid view, expansion, pinning, saving, slideshow and help", () => {
    const el = header({view: "grid", expanded: true, pinned: true, favorite: true, slideshow: true, help: true});
    expect(el.querySelector("[data-action=grid]")!.getAttribute("aria-label")).toBe("Back to single media");
    expect(el.querySelector("[data-action=grid-smaller]")).not.toBeNull();
    expect(el.querySelector("[data-action=expand]")!.textContent).toBe("↙");
    expect(el.querySelector("[data-action=pin]")!.getAttribute("aria-label")).toBe("Unpin preview");
    expect(el.querySelector("[data-action=favorite]")!.textContent).toBe("★");
    expect(el.querySelector("[data-action=pause]")!.getAttribute("aria-label")).toBe("Pause slideshow");
    expect(el.querySelector("[data-action=pause]")!.getAttribute("aria-pressed")).toBe("true");
    const paused = header({slideshow: true, slideshowPaused: true}).querySelector("[data-action=pause]")!;
    expect([paused.textContent, paused.getAttribute("aria-label")]).toEqual(["▶", "Resume slideshow"]);
    expect(header().querySelector("[data-action=slideshow]")!.getAttribute("aria-label")).toBe("Start slideshow");
    expect(el.querySelector("[data-action=help]")!.getAttribute("aria-expanded")).toBe("true");
  });

  it("offers full screen instead of expand, float and pin when the panel is the whole window", () => {
    const el = header({fills: true});
    expect(el.querySelector("[data-action=expand]")!.getAttribute("aria-label")).toBe("Full screen");
    expect([el.querySelector("[data-action=popOut]"), el.querySelector("[data-action=pin]")]).toEqual([null, null]);
  });

  it("leaves out quick view controls when they are turned off, and keys that are unbound", () => {
    const el = header({view: "grid", settings: resolveSettings({quickViewControls: false, shortcuts: {...DEFAULT_SHORTCUTS, close: []}})});
    expect(el.querySelector("[data-action=expand]")).toBeNull();
    expect(el.querySelector("[data-action=grid-smaller]")).toBeNull();
    expect(el.querySelector("[data-action=close]")!.getAttribute("title")).toBe("Close");
  });
});

describe("the footer", () => {
  const footer = (patch: Partial<markup.FooterState> = {}) => html(markup.footerMarkup({result: result(), index: 0, view: "focus", gridThumbSize: 120, slideshow: false, slideshowPaused: false, settings, ...patch}));

  it("shows navigation, actions and status for the current item", () => {
    const el = footer();
    expect(el.querySelector(".lp-count")!.textContent).toBe("1 / 2");
    expect(el.querySelectorAll(".lp-action")).toHaveLength(3);
    expect(el.querySelector(".lp-signal")!.textContent).toBe("2 media · Complete");
    expect(el.querySelector(".lp-post")).toBeNull();
  });

  it("links to the post and author when known, and shows tile size in grid view", () => {
    const withPost = result({items: [item({postNumber: 7, author: "<rex>"})]});
    expect(footer({result: withPost}).querySelector(".lp-post")!.textContent).toBe("Post #7 · <rex> ↗");
    expect(footer({result: result({items: [item({postNumber: 3})]})}).querySelector(".lp-post")!.textContent).toBe("Post #3 ↗");
    expect(footer({view: "grid", gridThumbSize: 96.4}).querySelector(".lp-tiles")!.textContent).toBe("96px tiles");
    expect(footer({slideshow: true}).querySelector(".lp-signal")!.textContent).toBe("Slideshow · 3s");
    expect(footer({slideshow: true, slideshowPaused: true}).querySelector(".lp-signal")!.textContent).toBe("Paused · Space to resume");
  });

  it("shows an empty count while loading", () => {
    const el = footer({result: undefined});
    expect(el.querySelector(".lp-count")!.textContent).toBe("0 / 0");
    expect(el.querySelector(".lp-signal")!.textContent).toBe("Loading");
    expect(el.querySelector(".lp-nav")).toBeNull();
  });
});

describe("progress", () => {
  it("describes complete, partial and unknown-size scans", () => {
    expect(markup.progressText(undefined)).toBe("Loading");
    expect(markup.progressText(result({complete: false, postsScanned: 20, totalPosts: 80}))).toBe("2 media · 20/80 posts");
    expect(markup.progressText(result({complete: false, totalPosts: 80}))).toBe("2 media · 0/80 posts");
    expect(markup.progressText(result({complete: false}))).toBe("2 media · Scanning");
    expect(markup.countText(4, 9)).toBe("5 / 9");
  });
});

describe("media", () => {
  it("renders images, decoded slots, GIF mounts, videos and load failures", () => {
    expect(html(markup.mediaMarkup(item({previewUrl: `https://x.test/"p".jpg`, filename: "Cat"}), settings, false)).querySelector("img")!.getAttribute("src")).toBe(`https://x.test/"p".jpg`);
    expect(html(markup.mediaMarkup(item(), settings, false)).querySelector("img")!.getAttribute("alt")).toBe("Preview image");
    expect(html(markup.mediaMarkup(item(), settings, true)).querySelector(".lp-image-slot")).not.toBeNull();
    expect(html(markup.mediaMarkup(item({type: "gif"}), settings, false)).querySelector(".lp-gif-mount")).not.toBeNull();
    const video = html(markup.mediaMarkup(item({type: "video", posterUrl: "poster.jpg"}), settings, false)).querySelector("video")!;
    expect([video.hasAttribute("autoplay"), video.hasAttribute("muted"), video.getAttribute("poster")]).toEqual([true, true, "poster.jpg"]);
    const quiet = html(markup.mediaMarkup(item({type: "video"}), resolveSettings({videoAutoplay: false, videoMuted: false}), false)).querySelector("video")!;
    expect([quiet.hasAttribute("autoplay"), quiet.hasAttribute("muted"), quiet.hasAttribute("poster")]).toEqual([false, false, false]);
    expect(html(markup.mediaMarkup(item(), settings, false, true)).querySelector("[data-action=open]")).not.toBeNull();
  });

  it("gives a tip that fits the media, when tips are on", () => {
    expect(markup.tipText(item({type: "gif"}))).toContain("Space");
    expect(markup.tipText(item({type: "video"}))).toContain("video");
    expect(markup.tipText(undefined)).toContain("Pinch");
    expect(html(markup.stageMarkup(item(), settings, false)).querySelector(".lp-tip")).not.toBeNull();
    expect(html(markup.stageMarkup(item(), resolveSettings({showLearningTips: false}), false)).querySelector(".lp-tip")).toBeNull();
  });
});

describe("other states", () => {
  it("render the grid, loading, empty and error states and resize handles", () => {
    expect(html(markup.gridMarkup(result())).querySelector(".lp-grid-progress")).toBeNull();
    expect(html(markup.gridMarkup(result({complete: false}))).querySelector(".lp-grid-progress")!.textContent).toContain("Still scanning");
    expect(html(markup.loadingMarkup).textContent).toContain("Preparing");
    expect(html(markup.emptyMarkup).textContent).toContain("No posted media");
    expect(html(markup.errorMarkup("<bad>")).textContent).toContain("<bad>");
    expect(html(markup.resizeHandles()).querySelectorAll("[data-resize]")).toHaveLength(8);
  });

  it("say where an item came from only when that adds something", () => {
    const base = result({title: "Thread"}), own = item({sourceUrl: base.url});
    expect(markup.captionText(undefined, base)).toBe("");
    expect(markup.captionText(own, undefined)).toBe("");
    expect(markup.captionText({...own, sourceTitle: "Thread"}, base)).toBe("");
    expect(markup.captionText(item({sourceUrl: "https://x.test/t/1/5", sourceTitle: "Thread", postNumber: 5, author: "rex"}), base)).toBe("Post #5 · by rex");
    expect(markup.captionText(item({sourceUrl: "https://other.test/album/one", sourceTitle: "Album one"}), base)).toBe("Album one");
    expect(markup.captionText(item({sourceUrl: "https://other.test/album/two"}), base)).toBe("two");
    expect(markup.captionText(item({sourceTitle: "Trip"}), result({mixed: true}))).toBe("Trip");
  });

  it("build the help sheet from the actual bindings", () => {
    const el = html(markup.helpMarkup({...DEFAULT_SHORTCUTS, nextLink: [], previousLink: [], openPage: [], preloadInspector: [], slideshow: ["Shift+s"]}, true));
    expect(el.textContent).toContain("Play / pause");
    expect([...el.querySelectorAll("h4")].map(h => h.textContent)).not.toContain("Links");
    expect(el.textContent).not.toContain("Preload inspector");
    expect(el.textContent).toContain("Shift+S");
    const defaults = html(markup.helpMarkup(DEFAULT_SHORTCUTS, false));
    expect(defaults.textContent).not.toContain("GIF");
    expect(defaults.textContent).toContain("Ctrl+X, then X");
    expect(defaults.textContent).toContain("Original in a background tab");
  });
});
