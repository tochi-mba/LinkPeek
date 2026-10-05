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

export interface ScanResult {
  url: string;
  kind: LinkKind;
  title?: string;
  items: MediaItem[];
  complete: boolean;
  postsScanned?: number;
  totalPosts?: number;
  diagnostics?: {ignored: number; duplicates: number; adapter: string; warnings: string[]};
}

/** Link kinds LinkPeek can open a preview for. */
export const PREVIEWABLE_KINDS: ReadonlySet<LinkKind> = new Set(["direct-image", "direct-video", "discourse", "generic"]);

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
  return STATE_CHANGING_PATH.test(url.pathname) || STATE_CHANGING_QUERY.test(url.search.slice(1));
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
  const clean = base.replace(/[\\/:*?"<>|\x00-\x1f]+/g, " ").replace(/\s+/g, " ").replace(/^[.\s]+|[.\s]+$/g, "").slice(0, 120) || "media";
  return `${clean}${extension.toLowerCase()}`;
}
