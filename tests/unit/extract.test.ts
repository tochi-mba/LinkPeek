import {describe, expect, it} from "vitest";
import {attribute, dedupeMedia, extractMediaFromHtml, extractPageMetaMedia} from "../../src/core/extract";

const base = "https://forum.test/t/topic/1";

describe("reading attributes", () => {
  it("handles double, single and unquoted values and decodes entities", () => {
    expect(attribute(`<img src="a.jpg?x=1&amp;y=2">`, "src")).toBe("a.jpg?x=1&y=2");
    expect(attribute(`<img alt='it&#39;s "ok"'>`, "alt")).toBe(`it's "ok"`);
    expect(attribute(`<img alt="it's fine">`, "alt")).toBe("it's fine");
    expect(attribute(`<img width=640 src=x.png>`, "width")).toBe("640");
    expect(attribute(`<img alt="&#x41;&lt;&gt;&quot;&apos;&#99999999;">`, "alt")).toBe(`A<>"'`);
    expect(attribute(`<img data-src="real.jpg" src="p.gif">`, "src")).toBe("p.gif");
    expect(attribute(`<img src="x">`, "alt")).toBeUndefined();
  });
});

describe("posted media", () => {
  it("prefers Discourse lightbox originals and skips avatars, emoji, icons and logos", () => {
    const html = `<div class="cooked">
      <a class="lightbox" href="/uploads/original/1X/a.jpeg" title="Original A"><img src="/uploads/optimized/1X/a_2_690x388.jpeg" data-base62-sha1="shaA" width="690" height="388"></a>
      <img class="avatar" src="/avatar.png" width="48" height="48">
      <img class="emoji" src="/emoji.png" width="20" height="20" alt=":smile:">
      <img src="/brand.png" alt="site logo" width="400" height="400">
      <img src="/uploads/b.png" width="800" height="600" alt="Bee">
    </div>`;
    const items = extractMediaFromHtml(html, base);
    expect(items.map(item => item.filename)).toEqual(["Original A", "Bee"]);
    expect(items[0]).toMatchObject({id: "upload:shaA", originalUrl: "https://forum.test/uploads/original/1X/a.jpeg", previewUrl: "https://forum.test/uploads/optimized/1X/a_2_690x388.jpeg", width: 690, score: 1});
    expect(items[1]).toMatchObject({type: "image", score: 0.65});
  });

  it("keeps document order across lightboxes, images and videos", () => {
    const html = `<img src="/1.png"><a class="lightbox" href="/2.jpg"><img src="/2s.jpg"></a><video src="/3.mp4"></video><img src="/4.png">`;
    expect(extractMediaFromHtml(html, base).map(item => new URL(item.originalUrl).pathname)).toEqual(["/1.png", "/2.jpg", "/3.mp4", "/4.png"]);
  });

  it("finds lazy-loaded images and srcset-only images", () => {
    const items = extractMediaFromHtml(`
      <img src="data:image/gif;base64,R0lGOD" data-src="/lazy.jpg">
      <img data-lazy-src="/lazy2.jpg">
      <img data-original="/lazy3.jpg" src="/placeholder-real.jpg">
      <img srcset="/set-a.jpg 1x, /set-b.jpg 2x">
      <img data-srcset="/dset.jpg 1x">
      <img src="blob:abc">`, base);
    expect(items.map(item => new URL(item.originalUrl).pathname)).toEqual(["/lazy.jpg", "/lazy2.jpg", "/lazy3.jpg", "/set-a.jpg", "/dset.jpg"]);
  });

  it("uses a Discourse optimized srcset entry as the preview", () => {
    const [item] = extractMediaFromHtml(`<img src="/uploads/original/x.png" srcset="/uploads/optimized/x_2_100x100.png 1x, /big.png 2x">`, base);
    expect(item.previewUrl).toBe("https://forum.test/uploads/optimized/x_2_100x100.png");
    expect(item.originalUrl).toBe("https://forum.test/uploads/original/x.png");
  });

  it("recognizes GIFs by extension or the animated class", () => {
    const items = extractMediaFromHtml(`<img src="/a.gif"><img class="animated" src="/b.webp"><a class="lightbox" href="/c.gif?x=1"><img src="/c-small.gif"></a>`, base);
    expect(items.map(item => item.type)).toEqual(["gif", "gif", "gif"]);
    expect(items[0].score).toBe(0.9);
  });

  it("filters by type and by declared size", () => {
    const html = `<img src="/a.gif"><img src="/b.webp"><img src="/c.avif"><img src="/d.svg"><img src="/e.jpg"><img src="/small.jpg" width="40" height="400"><img src="/short.jpg" height="10"><a class="lightbox" href="/tiny.jpg"><img src="/t.jpg" width="20"></a>`;
    const paths = (options = {}) => extractMediaFromHtml(html, base, {}, options).map(item => new URL(item.originalUrl).pathname);
    expect(paths()).toEqual(["/a.gif", "/b.webp", "/c.avif", "/e.jpg"]);
    expect(paths({includeGif: false, includeWebp: false, includeAvif: false, includeSvg: true, includeImages: false})).toEqual(["/d.svg"]);
    expect(paths({minWidth: 0, minHeight: 0})).toContain("/small.jpg");
  });

  it("can include avatars and emoji when asked", () => {
    const html = `<img class="avatar" src="/av.png"><img alt="emoji" src="/em.png"><img class="reaction" src="/re.png">`;
    expect(extractMediaFromHtml(html, base, {}, {includeAvatars: true, includeEmoji: true})).toHaveLength(3);
  });

  it("hides quoted media by default, can show it, or mark it as quoted", () => {
    const html = `<aside class="quote"><img src="/quoted.png"></aside><img src="/own.png">`;
    expect(extractMediaFromHtml(html, base).map(item => item.quoted)).toEqual([undefined]);
    expect(extractMediaFromHtml(html, base, {}, {quotedDuplicates: "show"})).toHaveLength(2);
    const marked = extractMediaFromHtml(html, base, {}, {quotedDuplicates: "mark"});
    expect(marked.map(item => [new URL(item.originalUrl).pathname, item.quoted])).toEqual([["/own.png", undefined], ["/quoted.png", true]]);
  });

  it("deduplicates by upload id and canonical URL and merges metadata", () => {
    const html = `<a class="lightbox" href="/uploads/original/a.png"><img data-base62-sha1="s" src="/x.png"></a><img data-base62-sha1="s" src="/other.png"><img src="/uploads/optimized/a_2_10x10.png"><a class="lightbox" href="/uploads/original/a.png"></a><a class="lightbox"><img src="/no-href.png"></a>`;
    const items = extractMediaFromHtml(html, base, {postNumber: 4, author: "rex"});
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({postNumber: 4, author: "rex"});
    expect(dedupeMedia([...items, ...items]).duplicates).toBe(2);
  });

  it("keeps a lightbox original even when it has no usable child image", () => {
    const items = extractMediaFromHtml(`<a class="lightbox" href="/solo.jpg"></a><a class="lightbox" href="/fallback.png"><img></a>`, base);
    expect(items.map(entry => [entry.originalUrl, entry.previewUrl])).toEqual([
      ["https://forum.test/solo.jpg", "https://forum.test/solo.jpg"],
      ["https://forum.test/fallback.png", "https://forum.test/fallback.png"]
    ]);
    expect(extractMediaFromHtml(`<img src="/own.png">`, base, {}, {quotedDuplicates: "mark"})).toHaveLength(1);
  });

  it("falls back to the file name, or 'media' for a bare origin", () => {
    const items = extractMediaFromHtml(`<a class="lightbox" href="https://cdn.test/"><img src="/s.png"></a><img src="https://cdn.test/f%20name.png"><img src="https://cdn.test/%E0%A4%A.png">`, base, {}, {includeImages: true});
    expect(items.map(item => item.filename)).toEqual(["media", "f name.png", "media"]);
  });

  it("skips sources that are not valid URLs", () => {
    expect(extractMediaFromHtml(`<img src="http://[broken">`, base)).toEqual([]);
  });
});

describe("posted video", () => {
  it("finds video tags, nested sources and Discourse video placeholders", () => {
    const items = extractMediaFromHtml(`
      <video src="/a.mp4" poster="/a.jpg"></video>
      <video><source src="/b.webm"></video>
      <div class="video-placeholder-container" data-video-src="/c.mp4" data-thumbnail-src="/c.jpg"></div>
      <video src="/a.mp4"></video>
      <video><source src="data:video/mp4;base64,AA"></video>
      <video></video>`, base);
    expect(items.map(item => [item.type, new URL(item.originalUrl).pathname, item.posterUrl && new URL(item.posterUrl).pathname])).toEqual([
      ["video", "/a.mp4", "/a.jpg"], ["video", "/b.webm", undefined], ["video", "/c.mp4", "/c.jpg"]
    ]);
  });

  it("are left out when video is turned off", () => {
    expect(extractMediaFromHtml(`<video src="/a.mp4"></video>`, base, {}, {includeVideo: false})).toEqual([]);
  });
});

describe("page preview pictures", () => {
  it("read Open Graph and Twitter card images in priority order", () => {
    expect(extractPageMetaMedia(`<meta name="twitter:image" content="/tw.png"><meta property="og:image" content="/og.gif">`, base)[0])
      .toMatchObject({originalUrl: "https://forum.test/og.gif", type: "gif", score: 0.3});
    expect(extractPageMetaMedia(`<meta name="twitter:image" content="/tw.png">`, base)[0].type).toBe("image");
    expect(extractPageMetaMedia(`<meta property="og:image" content="data:image/png;base64,AA"><meta property="og:image:url" content="http://[x"><meta name="description" content="x">`, base)).toEqual([]);
    expect(extractPageMetaMedia(`<p>no meta</p>`, base)).toEqual([]);
  });
});
