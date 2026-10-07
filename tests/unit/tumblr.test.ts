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
      {key: "original", url: "https://64.media.tumblr.com/original.pnj", ext: "png", kind: "image", postId: "99", at: 100000, index: 1},
      {key: "https://64.media.tumblr.com/a.gif", url: "https://64.media.tumblr.com/a.gif", ext: "gif", kind: "gif", postId: "99", at: 100000, index: 2},
      {key: "https://64.media.tumblr.com/mime", url: "https://64.media.tumblr.com/mime", ext: "gif", kind: "gif", postId: "99", at: 100000, index: 3},
      {key: "https://v.tumblr.com/video_file/a/1", url: "https://v.tumblr.com/video_file/a/1", ext: "mp4", kind: "video", postId: "99", at: 100000, index: 4},
      {key: "https://a.media.tumblr.com/sound", url: "https://a.media.tumblr.com/sound", ext: "mp3", kind: "audio", postId: "99", at: 100000, index: 5},
      {key: "https://v.tumblr.com/video_file/fallback/2", url: "https://v.tumblr.com/video_file/fallback/2", ext: "mp4", kind: "video", postId: "99", at: 100000, index: 6}
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

  it("builds dated and undated download names", () => {
    const media: TumblrMedia = {key: "k", url: "https://64.media.tumblr.com/a.jpg", ext: "jpg", kind: "image", postId: "42", at: new Date(2024, 0, 2).getTime(), index: 3};
    expect(tumblrFileName("my-blog", media)).toBe("LinkPeek/Tumblr/my-blog/2024-01-02 42-3.jpg");
    expect(tumblrFileName("my-blog", {...media, at: 0})).toBe("LinkPeek/Tumblr/my-blog/undated 42-3.jpg");
  });
});
