export type LinkKind = "direct-image" | "direct-video" | "discourse" | "generic" | "anchor" | "download" | "unsafe" | "ignored";

export interface MediaItem {
  id: string;
  type: "image" | "gif" | "video";
  originalUrl: string;
  previewUrl: string;
  /** Still frame shown for a video before it plays. */
  posterUrl?: string;
  sourceUrl: string;
  filename?: string;
  width?: number;
  height?: number;
  postNumber?: number;
  postId?: number;
  author?: string;
  quoted?: boolean;
  score: number;
}

export interface LinkContext {
  /** Page whose document order these links came from. */
  sourceUrl: string;
  /** Safe previewable destinations in document order. */
  links: string[];
}

export interface ScanResult {
  url: string;
  kind: LinkKind;
  title?: string;
  items: MediaItem[];
  complete: boolean;
  /** Link order for fetched pages, so navigation can continue inside recursive results. */
  linkContexts?: LinkContext[];
  postsScanned?: number;
  totalPosts?: number;
  diagnostics?: {ignored: number; duplicates: number; adapter: string; warnings: string[]};
  /** A shuffle of media from many links: page actions apply to the link each item came from. */
  mixed?: boolean;
}

/** Link kinds LinkPeek can open a preview for. */
export const PREVIEWABLE_KINDS: ReadonlySet<LinkKind> = new Set(["direct-image", "direct-video", "discourse", "generic"]);

/** A short name for a link that is not on the page: its last path segment, or its host. */
export function linkLabel(url: string) {
  const parsed = new URL(url), segment = parsed.pathname.split("/").filter(Boolean).at(-1) ?? "";
  try {
    return decodeURIComponent(segment) || parsed.hostname;
  } catch {
    return segment;
  }
}

/**
 * The links worth stepping through on a fetched page: the ones under the page's
 * own path (an album's photos, a category's threads) when there are at least
 * two, so site navigation does not get in the way; otherwise all of them.
 */
export function contentLinks(context: LinkContext): string[] {
  const base = new URL(context.sourceUrl), prefix = `${base.pathname.replace(/\/$/, "")}/`;
  const children = context.links.filter(link => {
    const url = new URL(link);
    return url.origin === base.origin && url.pathname.startsWith(prefix) && url.pathname.length > prefix.length;
  });
  return children.length >= 2 ? children : context.links;
}

const GIF_FILE = /\.gif(?:$|[?#])/i;

/** Whether a gallery has a GIF, judged by type or by any of its file names (some sites label GIFs as images). */
export function hasGifMedia(items: readonly MediaItem[]) {
  return items.some(item => item.type === "gif" || GIF_FILE.test(item.originalUrl) || GIF_FILE.test(item.previewUrl) || GIF_FILE.test(item.filename ?? ""));
}

/** Whether a link points straight at a GIF file. */
export function isGifLink(url: string) {
  return GIF_FILE.test(url);
}

const IMAGE_FILE = /\.(?:jpe?g|png|webp|gif|avif)(?:$|[?#])/i;
const VIDEO_FILE = /\.(?:mp4|webm|mov|m4v)(?:$|[?#])/i;
const DOWNLOAD_FILE = /\.(?:zip|rar|7z|gz|tar|pdf|exe|msi|dmg|pkg|apk|iso|docx?|xlsx?|pptx?)(?:$|[?#])/i;

/**
 * URLs that change state on a plain GET (sign out, delete, unsubscribe,
 * add to cart). LinkPeek never requests these, neither speculatively nor on hover.
 */
const STATE_CHANGING_PATH = /(?:^|\/)(?:log[-_]?out|sign[-_]?out|signoff|delete|destroy|remove|unsubscribe|checkout|add[-_]to[-_]cart|upvote|downvote)(?:\.[a-z]+)?(?:\/|$)/i;
const STATE_CHANGING_QUERY = /(?:^|&)(?:action|do|act|op|cmd)=(?:log-?out|sign-?out|delete|remove|unsubscribe|vote|purchase)(?:&|$)/i;

export function isStateChangingUrl(url: URL) {
  let path = url.pathname;
  try { path = decodeURIComponent(path); } catch { /* Invalid escapes remain literal. */ }
  return STATE_CHANGING_PATH.test(path) || [...url.searchParams].some(([key, value]) => STATE_CHANGING_QUERY.test(`${key}=${value}`));
}

/** Decides how LinkPeek treats a link before anything is fetched. */
export function classifyLink(raw: string, base: string | undefined = globalThis.location?.href): LinkKind {
  let url: URL;
  try {
    url = new URL(raw, base || "https://example.invalid/");
  } catch {
    return "ignored";
  }
  if (!/^https?:$/.test(url.protocol)) return "ignored";
  if (base) {
    const here = new URL(base);
    if (url.hash && url.origin === here.origin && url.pathname === here.pathname && url.search === here.search) return "anchor";
  }
  if (isStateChangingUrl(url)) return "unsafe";
  if (IMAGE_FILE.test(url.pathname)) return "direct-image";
  if (VIDEO_FILE.test(url.pathname)) return "direct-video";
  if (/\/t\/[^/]+\/\d+(?:\/\d+)?\/?$/.test(url.pathname) || /\/t\/\d+(?:\/|$)/.test(url.pathname)) return "discourse";
  if (DOWNLOAD_FILE.test(url.pathname)) return "download";
  return "generic";
}

const TRACKING_PARAM = /^(?:utm_.+|fbclid|gclid|mc_cid|mc_eid)$/i;

/** Removes tracking parameters in place. */
export function stripTrackingParams(url: URL) {
  for (const key of [...url.searchParams.keys()]) if (TRACKING_PARAM.test(key)) url.searchParams.delete(key);
  return url;
}

/** A stable identity for a media file: no fragment, no tracking, Discourse originals instead of resized copies. */
export function canonicalMediaUrl(raw: string) {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return raw;
  }
  url.hash = "";
  stripTrackingParams(url);
  if (url.pathname.includes("/optimized/")) {
    url.pathname = url.pathname
      .replace("/optimized/", "/original/")
      .replace(/_\d+_\d+x\d+(\.[a-z0-9]+)$/i, "$1")
      .replace(/_\d+x\d+(\.[a-z0-9]+)$/i, "$1");
  }
  return url.href;
}

/**
 * Drops repeated media. Two items are the same when they share an id, an
 * original or a preview. The higher-scoring copy wins and keeps the first position.
 */
export function uniqueMediaItems(items: MediaItem[]): {items: MediaItem[]; duplicates: number} {
  const out: MediaItem[] = [];
  const byIdentity = new Map<string, number>();
  let duplicates = 0;
  for (const item of items) {
    const identity = [`id:${item.id}`, `original:${canonicalMediaUrl(item.originalUrl)}`, `preview:${canonicalMediaUrl(item.previewUrl)}`];
    const existing = identity.map(key => byIdentity.get(key)).find((at): at is number => at !== undefined);
    if (existing !== undefined) {
      duplicates++;
      if (item.score > out[existing].score) out[existing] = item;
      for (const key of identity) byIdentity.set(key, existing);
      continue;
    }
    for (const key of identity) byIdentity.set(key, out.length);
    out.push(item);
  }
  return {items: out, duplicates};
}

const UNSAFE_NAME_CHARS = /[\\/:*?"<>|\x00-\x1f]+/g;

/** A folder name every desktop OS accepts, for downloading a whole gallery. */
export function safeFolderName(title: string) {
  return title.replace(UNSAFE_NAME_CHARS, " ").replace(/\s+/g, " ").replace(/^[.\s]+|[.\s]+$/g, "").slice(0, 80) || "LinkPeek gallery";
}

/** A filename that every desktop OS accepts, keeping the media file's extension. */
export function safeDownloadName(item: Pick<MediaItem, "originalUrl" | "filename">) {
  let path = "";
  try {
    path = decodeURIComponent(new URL(item.originalUrl).pathname.split("/").pop()!);
  } catch {
    path = "";
  }
  const extension = /\.([a-z0-9]{2,5})$/i.exec(path)?.[0] ?? "";
  const base = (item.filename?.trim() || path || "media").replace(/\.[a-z0-9]{2,5}$/i, "");
  const clean = base.replace(UNSAFE_NAME_CHARS, " ").replace(/\s+/g, " ").replace(/^[.\s]+|[.\s]+$/g, "").slice(0, 120) || "media";
  return `${clean}${extension.toLowerCase()}`;
}
