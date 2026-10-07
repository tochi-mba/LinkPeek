import {describe, expect, it} from "vitest";
import {
  apiTokenFrom,
  extensionFor,
  firstPostsPath,
  mediaOf,
  readPostsPage,
  tumblrBlogFrom,
  tumblrFileName,
  type TumblrMedia
} from "../../src/core/tumblr";

describe("Tumblr addresses and API answers", () => {
  it("recognises public blog addresses but not Tumblr's own pages and hosts", () => {
    expect(tumblrBlogFrom("not a url")).toBeUndefined();
    expect(tumblrBlogFrom("https://www.tumblr.com/Some-Blog/123")).toBe("some-blog");
    expect(tumblrBlogFrom("https://tumblr.com/blog/view/AnotherBlog/42")).toBe("anotherblog");
    expect(tumblrBlogFrom("https://www.tumblr.com/blog/view")).toBeUndefined();
    expect(tumblrBlogFrom("https://www.tumblr.com/dashboard")).toBeUndefined();
    expect(tumblrBlogFrom("https://www.tumblr.com/-bad")).toBeUndefined();
    expect(tumblrBlogFrom("https://third-blog.tumblr.com/post/1")).toBe("third-blog");
    expect(tumblrBlogFrom("https://media.tumblr.com/file.jpg")).toBeUndefined();
    expect(tumblrBlogFrom("https://not_tumblr.tumblr.com/")).toBeUndefined();
    expect(tumblrBlogFrom("https://example.com/blog")).toBeUndefined();
  });

  it("reads tokens, page links and encoded first-page paths", () => {
    expect(apiTokenFrom('<script>{"API_TOKEN" : "AbC123"}</script>')).toBe("AbC123");
    expect(apiTokenFrom("nothing here")).toBeUndefined();
    expect(firstPostsPath("name with/slash")).toBe("/v2/blog/name%20with%2Fslash/posts?npf=true&limit=20&reblog_info=true");

    const post = {object_type: "post", id_string: "1"};
    expect(readPostsPage({response: {posts: [post], total_posts: 12, _links: {next: {href: "/next"}}}}))
      .toEqual({posts: [post], total: 12, next: "/next"});
    expect(readPostsPage({response: {posts: [], total_posts: "12", _links: {next: {href: "/ignored"}}}}))
      .toEqual({posts: [], total: 0, next: undefined});
    expect(readPostsPage({response: {posts: "bad", _links: {next: {href: 4}}}}))
      .toEqual({posts: [], total: 0, next: undefined});
    expect(readPostsPage(undefined)).toEqual({posts: [], total: 0, next: undefined});
  });
});

describe("Tumblr media", () => {
  it("chooses real extensions, content types and sensible fallbacks", () => {
    expect(extensionFor("https://x.test/photo.JPEG?x=1", undefined, "image")).toBe("jpg");
    expect(extensionFor("https://x.test/movie.webm", "video/mp4", "video")).toBe("webm");
    expect(extensionFor("https://x.test/photo.pnj", " image/png; charset=binary", "image")).toBe("png");
    expect(extensionFor("https://x.test/no-extension", "application/octet-stream", "video")).toBe("mp4");
    expect(extensionFor("https://x.test/no-extension", undefined, "audio")).toBe("mp3");
    expect(extensionFor("https://x.test/no-extension", undefined, "gif")).toBe("gif");
    expect(extensionFor("https://x.test/no-extension", undefined, "image")).toBe("jpg");
  });

  it("collects originals, widest renditions and trail media once", () => {
    expect(mediaOf({object_type: "ad", id_string: "x"})).toEqual([]);
    expect(mediaOf({object_type: "post"})).toEqual([]);
    expect(mediaOf({
      object_type: "post",
      id_string: "99",
      timestamp: 100,
      post_url: "https://demo.tumblr.com/post/99/example",
      summary: "Example post",
      tags: ["photography", "blonde hair"],
      content: [
        {type: "image", media: [
          {url: "https://64.media.tumblr.com/small.jpg", width: 100},
          {url: "https://64.media.tumblr.com/wide.jpg", width: 800, media_key: "wide"},
          {url: "https://64.media.tumblr.com/original.pnj", type: "image/png", width: 400, has_original_dimensions: true, media_key: "original"}
        ]},
        {type: "image", media: [{url: "https://64.media.tumblr.com/a.gif", type: "image/jpeg"}]},
        {type: "image", media: [{url: "https://64.media.tumblr.com/mime", type: "image/gif"}]},
        {type: "image", media: []},
        {type: "image", media: "bad"},
        {type: "video", media: [{url: "https://v.tumblr.com/video_file/a/1", type: "video/mp4"}]},
        {type: "audio", media: {url: "https://a.media.tumblr.com/sound", type: "audio/mpeg"}},
        {type: "video", url: "https://v.tumblr.com/video_file/fallback/2"},
        {type: "audio"},
        {type: "video", url: "https://youtube.com/watch?v=no"},
        {type: "text"}
      ],
      trail: [
        {content: [{type: "image", media: [{url: "https://64.media.tumblr.com/duplicate.jpg", media_key: "original"}]}]},
        {}
      ]
    })).toEqual([
      {key: "original", url: "https://64.media.tumblr.com/original.pnj", ext: "png", kind: "image", postId: "99", at: 100000, index: 1, sourceUrl: "https://demo.tumblr.com/post/99/example", title: "Example post · #photography #blonde hair"},
      {key: "https://64.media.tumblr.com/a.gif", url: "https://64.media.tumblr.com/a.gif", ext: "gif", kind: "gif", postId: "99", at: 100000, index: 2, sourceUrl: "https://demo.tumblr.com/post/99/example", title: "Example post · #photography #blonde hair"},
      {key: "https://64.media.tumblr.com/mime", url: "https://64.media.tumblr.com/mime", ext: "gif", kind: "gif", postId: "99", at: 100000, index: 3, sourceUrl: "https://demo.tumblr.com/post/99/example", title: "Example post · #photography #blonde hair"},
      {key: "https://v.tumblr.com/video_file/a/1", url: "https://v.tumblr.com/video_file/a/1", ext: "mp4", kind: "video", postId: "99", at: 100000, index: 4, sourceUrl: "https://demo.tumblr.com/post/99/example", title: "Example post · #photography #blonde hair"},
      {key: "https://a.media.tumblr.com/sound", url: "https://a.media.tumblr.com/sound", ext: "mp3", kind: "audio", postId: "99", at: 100000, index: 5, sourceUrl: "https://demo.tumblr.com/post/99/example", title: "Example post · #photography #blonde hair"},
      {key: "https://v.tumblr.com/video_file/fallback/2", url: "https://v.tumblr.com/video_file/fallback/2", ext: "mp4", kind: "video", postId: "99", at: 100000, index: 6, sourceUrl: "https://demo.tumblr.com/post/99/example", title: "Example post · #photography #blonde hair"}
    ]);
  });

  it("uses the widest image when no original is marked and tolerates sparse posts", () => {
    expect(mediaOf({
      object_type: "post",
      id_string: "2",
      content: [{type: "image", media: [
        {url: "https://64.media.tumblr.com/unknown-a", width: undefined},
        {url: "https://64.media.tumblr.com/unknown-b"}
      ]}]
    })[0].url).toBe("https://64.media.tumblr.com/unknown-a");
    expect(mediaOf({object_type: "post", id_string: "3"})).toEqual([]);
  });

  it("falls back to cleaned caption blocks and ignores malformed tags", () => {
    const item = mediaOf({
      object_type: "post", id_string: "4", tags: ["#summer", 5, " ", "friends &amp; fun"],
      content: [
        {type: "text", text: "<p>Two&nbsp;blonde <b>tight</b> asses &#x1F60E; &#128526; &quot;yes&quot;</p>"},
        {type: "image", media: [{url: "https://64.media.tumblr.com/caption.jpg"}]}
      ],
      trail: [{content: [{type: "text", text: "Reblogged &#39;caption&#39;"}]}]
    })[0];
    expect(item.title).toBe("Two blonde tight asses 😎 😎 \"yes\" Reblogged 'caption' · #summer #friends & fun");
    const long = mediaOf({object_type: "post", id_string: "5", summary: "x".repeat(320), tags: ["kept", ...Array.from({length: 35}, (_, i) => `tag${i}`)], content: [
      {type: "image", media: [{url: "https://64.media.tumblr.com/long.jpg"}]}
    ]})[0].title!;
    expect(long).toMatch(/^x{299}… · #kept #tag0/);
    expect(long).toContain("#tag28");
    expect(long).not.toContain("#tag29");
  });

  it("builds dated and undated download names", () => {
    const media: TumblrMedia = {key: "k", url: "https://64.media.tumblr.com/a.jpg", ext: "jpg", kind: "image", postId: "42", at: new Date(2024, 0, 2).getTime(), index: 3, sourceUrl: ""};
    expect(tumblrFileName("my-blog", media)).toBe("LinkPeek/Tumblr/my-blog/2024-01-02 42-3.jpg");
    expect(tumblrFileName("my-blog", {...media, at: 0})).toBe("LinkPeek/Tumblr/my-blog/undated 42-3.jpg");
  });
});
