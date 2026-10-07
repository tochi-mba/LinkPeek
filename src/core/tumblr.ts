/**
 * Tumblr: every picture, GIF, video and sound a blog has posted or reblogged.
 *
 * The feed on tumblr.com is virtualised — posts scrolled out of view are
 * unloaded — so the page itself never holds a whole blog. Instead this reads
 * the same API Tumblr's own web app reads, with the token that app carries in
 * its page, paging through every post. Media comes from each post's own
 * blocks and from those of the posts it reblogged; ads in the stream and
 * media hosted elsewhere (YouTube and the like) are left out.
 */

/** One file to keep. */
export interface TumblrMedia {
  /** Identifies the file across posts (a reblog shares its original's), so each is kept once. */
  key: string;
  url: string;
  ext: string;
  kind: "image" | "gif" | "video" | "audio";
  postId: string;
  /** When the post was made (ms since epoch). */
  at: number;
  /** Its place among the post's files, from 1. */
  index: number;
}

/** Paths on www.tumblr.com that are Tumblr's own pages, not blogs. */
const NOT_BLOGS = new Set(("dashboard explore tagged search likes following followers settings inbox messages new communities " +
  "login register logout help about policy privacy docs apps premium activity changes live reblog edit notifications mobile " +
  "blog_settings customize drafts queue reblogs post communities-hub tumblr-tv for-you").split(" "));
/** Subdomains of tumblr.com that are Tumblr's own services, not blogs. */
const NOT_BLOG_HOSTS = new Set("www assets static help api embed media va ve vt vtt di 64 secure staff-docs".split(" "));
const NAME = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/i;

/** The blog an address belongs to: www.tumblr.com/name/..., www.tumblr.com/blog/view/name, or name.tumblr.com. */
export function tumblrBlogFrom(url: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  const host = parsed.hostname.toLowerCase();
  if (host === "www.tumblr.com" || host === "tumblr.com") {
    const parts = parsed.pathname.split("/").filter(Boolean);
    const name = parts[0] === "blog" && parts[1] === "view" ? parts[2] : parts[0];
    return name && NAME.test(name) && !NOT_BLOGS.has(name.toLowerCase()) ? name.toLowerCase() : undefined;
  }
  const match = /^([a-z0-9-]+)\.tumblr\.com$/.exec(host);
  return match && !NOT_BLOG_HOSTS.has(match[1]) && NAME.test(match[1]) ? match[1] : undefined;
}

/** The web app's API token, from a tumblr.com page (it travels in the page's initial state). */
export function apiTokenFrom(html: string) {
  return /"API_TOKEN"\s*:\s*"([A-Za-z0-9]+)"/.exec(html)?.[1];
}

const EXTENSIONS = new Set("jpg jpeg png gif webp avif mp4 mov m4v webm mkv mp3 m4a ogg oga wav aac flac".split(" "));
const BY_TYPE: Record<string, string> = {
  "image/jpeg": "jpg", "image/png": "png", "image/gif": "gif", "image/webp": "webp", "image/avif": "avif",
  "video/mp4": "mp4", "video/quicktime": "mov", "video/webm": "webm", "video/x-m4v": "m4v", "video/x-matroska": "mkv",
  "audio/mpeg": "mp3", "audio/mp4": "m4a", "audio/ogg": "ogg", "audio/wav": "wav", "audio/aac": "aac", "audio/flac": "flac"
};

/** The file's extension: its own when it names a real format, else from its declared type (Tumblr's .pnj is really a PNG). */
export function extensionFor(url: string, type: string | undefined, kind: TumblrMedia["kind"]) {
  const own = /\.([a-z0-9]{2,5})(?:$|[?#])/i.exec(url)?.[1]?.toLowerCase();
  if (own && EXTENSIONS.has(own)) return own === "jpeg" ? "jpg" : own;
  const typed = type && BY_TYPE[type.toLowerCase().split(";")[0].trim()];
  if (typed) return typed;
  return kind === "video" ? "mp4" : kind === "audio" ? "mp3" : kind === "gif" ? "gif" : "jpg";
}

/** Files on Tumblr's own media hosts; anything elsewhere (YouTube and the like) cannot be downloaded as a file. */
function tumblrHosted(url: unknown): url is string {
  return typeof url === "string" && (/^https:\/\/(?:[a-z0-9-]+\.)*media\.tumblr\.com\//i.test(url) || /^https:\/\/[a-z0-9-]+\.tumblr\.com\/video_file\//i.test(url));
}

type Block = {type?: string; media?: unknown; url?: unknown; provider?: string};
type Media = {url?: unknown; type?: string; width?: number; has_original_dimensions?: boolean; media_key?: string};
type Post = {object_type?: string; id_string?: string; timestamp?: number; content?: Block[]; trail?: Array<{content?: Block[]}>};

/** The best rendition of an image block: its original if marked, else the widest. */
function bestImage(media: Media[]) {
  return media.find(item => item.has_original_dimensions) ?? [...media].sort((a, b) => (b.width ?? 0) - (a.width ?? 0))[0];
}

/** The files one post holds, its reblogged trail included, each once; nothing for an ad or anything that is not a post. */
export function mediaOf(post: Post): TumblrMedia[] {
  if (post.object_type !== "post" || !post.id_string) return [];
  const blocks = [...post.content ?? [], ...(post.trail ?? []).flatMap(item => item.content ?? [])];
  const out: TumblrMedia[] = [], seen = new Set<string>(), at = (post.timestamp ?? 0) * 1000;
  const add = (url: unknown, type: string | undefined, kind: TumblrMedia["kind"], key?: string) => {
    if (!tumblrHosted(url) || seen.has(key ?? url)) return;
    seen.add(key ?? url);
    out.push({key: key ?? url, url, ext: extensionFor(url, type, kind), kind, postId: post.id_string!, at, index: out.length + 1});
  };
  for (const block of blocks) {
    if (block.type === "image" && Array.isArray(block.media) && block.media.length) {
      const best = bestImage(block.media as Media[]);
      add(best.url, best.type, best.type === "image/gif" || /\.gif(?:$|[?#])/i.test(String(best.url)) ? "gif" : "image", best.media_key);
    } else if (block.type === "video" || block.type === "audio") {
      const media = (Array.isArray(block.media) ? block.media[0] : block.media) as Media | undefined;
      add(media?.url ?? block.url, media?.type, block.type);
    }
  }
  return out;
}

/** One page of a blog's posts, as the API answers it. */
export type PostsPage = {total: number; posts: Post[]; next?: string};

/** The API path of a blog's first page of posts; later pages follow each answer's `next`. */
export function firstPostsPath(blog: string) {
  return `/v2/blog/${encodeURIComponent(blog)}/posts?npf=true&limit=20&reblog_info=true`;
}

/** Reads the parts of an API answer the downloader needs; anything malformed reads as an empty last page. */
export function readPostsPage(answer: unknown): PostsPage {
  const response = (answer as {response?: {posts?: unknown; total_posts?: unknown; _links?: {next?: {href?: unknown}}}})?.response;
  const posts = Array.isArray(response?.posts) ? response.posts as Post[] : [];
  const next = response?._links?.next?.href;
  return {total: typeof response?.total_posts === "number" ? response.total_posts : 0, posts, next: typeof next === "string" && posts.length ? next : undefined};
}

/** A file's name in Downloads: the blog's folder, then the post's date and number, so the folder sorts in posting order. */
export function tumblrFileName(blog: string, media: TumblrMedia) {
  const date = new Date(media.at), pad = (value: number) => String(value).padStart(2, "0");
  const day = media.at ? `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` : "undated";
  return `LinkPeek/Tumblr/${blog}/${day} ${media.postId}-${media.index}.${media.ext}`;
}
