import {describe, expect, it} from "vitest";
import {
  PREVIEWABLE_KINDS, canonicalMediaUrl, classifyLink, isStateChangingUrl, safeDownloadName, stripTrackingParams, uniqueMediaItems,
  type MediaItem
} from "../../src/shared/media";

const page = "https://forum.test/latest?x=1";

describe("link classification", () => {
  it("recognizes every kind of destination", () => {
    expect(classifyLink("https://cdn.test/a.JPG?w=2", page)).toBe("direct-image");
    expect(classifyLink("https://cdn.test/clip.mp4", page)).toBe("direct-video");
    expect(classifyLink("/t/some-topic/123", page)).toBe("discourse");
    expect(classifyLink("/t/some-topic/123/4/", page)).toBe("discourse");
    expect(classifyLink("/t/123", page)).toBe("discourse");
    expect(classifyLink("https://x.test/file.zip", page)).toBe("download");
    expect(classifyLink("https://x.test/article", page)).toBe("generic");
    expect(classifyLink("mailto:a@b.test", page)).toBe("ignored");
    expect(classifyLink("http://[bad", page)).toBe("ignored");
    expect(classifyLink("https://forum.test/latest?x=1#top", page)).toBe("anchor");
    expect(classifyLink("https://forum.test/other#top", page)).toBe("generic");
  });

  it("never treats sign-out, delete or cart links as previewable", () => {
    for (const url of ["/logout", "/session/sign_out", "/user/logout.php", "/posts/9/delete", "/cart/add-to-cart", "/index.php?action=logout", "/x?do=delete&id=2"]) {
      expect(classifyLink(url, page), url).toBe("unsafe");
    }
    expect(classifyLink("/r/pics/remove_this_thing", page)).toBe("generic");
    expect(classifyLink("/blog/how-to-delete-files", page)).toBe("generic");
    expect(isStateChangingUrl(new URL("https://x.test/a/unsubscribe/"))).toBe(true);
    expect(PREVIEWABLE_KINDS.has("unsafe")).toBe(false);
  });

  it("works without a page location (service worker)", () => {
    expect(classifyLink("https://x.test/a.png", "")).toBe("direct-image");
    expect(classifyLink("relative/path", "")).toBe("generic");
    expect(classifyLink("https://x.test/page")).toBe("generic");
  });
});

describe("media identity", () => {
  it("strips fragments and tracking, and maps Discourse resized images to originals", () => {
    expect(canonicalMediaUrl("https://x.test/a.jpg?utm_source=1&fbclid=2&keep=3#frag")).toBe("https://x.test/a.jpg?keep=3");
    expect(canonicalMediaUrl("https://x.test/uploads/optimized/2X/a/abc_2_690x388.jpeg")).toBe("https://x.test/uploads/original/2X/a/abc.jpeg");
    expect(canonicalMediaUrl("https://x.test/uploads/optimized/2X/a/abc_690x388.png")).toBe("https://x.test/uploads/original/2X/a/abc.png");
    expect(canonicalMediaUrl("not a url")).toBe("not a url");
    expect(stripTrackingParams(new URL("https://x.test/?mc_cid=1&q=2")).href).toBe("https://x.test/?q=2");
  });

  it("deduplicates by id, original or preview and keeps the higher-scoring copy in place", () => {
    const item = (id: string, original: string, preview: string, score: number): MediaItem => ({id, type: "image", originalUrl: original, previewUrl: preview, sourceUrl: "s", score});
    const result = uniqueMediaItems([
      item("a", "https://x.test/1.jpg", "https://x.test/p1.jpg", 0.5),
      item("b", "https://x.test/2.jpg", "https://x.test/p2.jpg", 0.5),
      item("a", "https://x.test/other.jpg", "https://x.test/p9.jpg", 0.9),
      item("c", "https://x.test/2.jpg#x", "https://x.test/p3.jpg", 0.1),
      item("d", "https://x.test/4.jpg", "https://x.test/p2.jpg", 0.2)
    ]);
    expect(result.items.map(entry => entry.id)).toEqual(["a", "b"]);
    expect(result.items[0].score).toBe(0.9);
    expect(result.duplicates).toBe(3);
  });
});

describe("download names", () => {
  it("keep the file's extension and remove characters no OS accepts", () => {
    expect(safeDownloadName({originalUrl: "https://x.test/a/photo.JPG", filename: "My: cat / dog?"})).toBe("My cat dog.jpg");
    expect(safeDownloadName({originalUrl: "https://x.test/a/img%20one.png"})).toBe("img one.png");
    expect(safeDownloadName({originalUrl: "https://x.test/", filename: "  ..  "})).toBe("media");
    expect(safeDownloadName({originalUrl: "not a url"})).toBe("media");
    expect(safeDownloadName({originalUrl: "https://x.test/%E0%A4%A", filename: "x"})).toBe("x");
    expect(safeDownloadName({originalUrl: "nope", filename: "y.gif"})).toBe("y");
    expect(safeDownloadName({originalUrl: "https://x.test/a.webp", filename: "a".repeat(200)})).toHaveLength(125);
  });
});
