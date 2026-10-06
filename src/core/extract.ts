/**
 * Finds posted media in an HTML fragment without a DOM: Discourse cooked post
 * bodies in the service worker, and whole pages for the generic adapter.
 *
 * It looks for content, not chrome: lightbox links and images that pass the
 * size and type filters, skipping avatars, emoji, icons, badges and logos.
 */
import type {MediaItem} from "../shared/media";
import {canonicalMediaUrl, uniqueMediaItems} from "../shared/media";
import type {LinkPeekSettings} from "../shared/settings";

export type ExtractOptions = Pick<LinkPeekSettings,
  "includeImages" | "includeGif" | "includeWebp" | "includeAvif" | "includeSvg" | "includeVideo" |
  "includeAvatars" | "includeEmoji" | "minWidth" | "minHeight" | "quotedDuplicates">;

const DEFAULT_OPTIONS: ExtractOptions = {
  includeImages: true, includeGif: true, includeWebp: true, includeAvif: true, includeSvg: false, includeVideo: true,
  includeAvatars: false, includeEmoji: false, minWidth: 50, minHeight: 120, quotedDuplicates: "hide"
};

const QUOTE_BLOCK = /<aside\b[^>]*class=["'][^"']*\bquote\b[^"']*["'][^>]*>[\s\S]*?<\/aside>/gi;
const UNUSABLE_SOURCE = /^(?:data|blob|about|javascript):/i;
const ENTITY = /&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi;
const NAMED_ENTITIES: Record<string, string> = {amp: "&", lt: "<", gt: ">", quot: '"', apos: "'"};
const attributePatterns = new Map<string, RegExp>();

export function decodeEntities(value: string) {
  return value.replace(ENTITY, (_, entity: string) => {
    const lower = entity.toLowerCase();
    if (!lower.startsWith("#")) return NAMED_ENTITIES[lower];
    const code = lower.startsWith("#x") ? parseInt(lower.slice(2), 16) : Number(lower.slice(1));
    return code <= 0x10ffff ? String.fromCodePoint(code) : "";
  });
}

/** Reads one attribute from an opening tag, decoding HTML entities. */
export function attribute(tag: string, name: string): string | undefined {
  let pattern = attributePatterns.get(name);
  if (!pattern) {
    pattern = new RegExp(`[\\s<]${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, "i");
    attributePatterns.set(name, pattern);
  }
  const match = pattern.exec(tag);
  if (!match) return undefined;
  return decodeEntities(match[1] ?? match[2] ?? match[3]);
}

function absolute(raw: string, base: string) {
  try {
    const url = new URL(raw, base);
    return /^https?:$/.test(url.protocol) ? url.href : undefined;
  } catch {
    return undefined;
  }
}

function fileName(url: string) {
  try {
    return decodeURIComponent(new URL(url).pathname.split("/").pop() || "media");
  } catch {
    return "media";
  }
}

function extensionAllowed(url: string, options: ExtractOptions) {
  const extension = new URL(url).pathname.split(".").pop()!.toLowerCase();
  if (extension === "gif") return options.includeGif;
  if (extension === "webp") return options.includeWebp;
  if (extension === "avif") return options.includeAvif;
  if (extension === "svg") return options.includeSvg;
  return options.includeImages;
}

function tooSmall(tag: string, options: ExtractOptions) {
  const width = Number(attribute(tag, "width")) || 0, height = Number(attribute(tag, "height")) || 0;
  return (width > 0 && width < options.minWidth) || (height > 0 && height < options.minHeight);
}

function dimensions(tag: string) {
  return {width: Number(attribute(tag, "width")) || undefined, height: Number(attribute(tag, "height")) || undefined};
}

function srcsetUrls(value: string | undefined) {
  return (value ?? "").split(",").map(entry => entry.trim().split(/\s+/)[0]).filter(Boolean);
}

/** The real image URL of an <img>, preferring lazy-load attributes over placeholders. */
function imageSource(tag: string) {
  const lazy = attribute(tag, "data-src") ?? attribute(tag, "data-lazy-src") ?? attribute(tag, "data-original");
  if (lazy && !UNUSABLE_SOURCE.test(lazy)) return lazy;
  const src = attribute(tag, "src");
  if (src && !UNUSABLE_SOURCE.test(src)) return src;
  return srcsetUrls(attribute(tag, "srcset") ?? attribute(tag, "data-srcset"))[0];
}

/** The lighter image to show first: a Discourse optimized size when the srcset has one. */
function previewSource(tag: string, original: string, base: string) {
  const candidates = srcsetUrls(attribute(tag, "srcset") ?? attribute(tag, "data-srcset"));
  const optimized = candidates.find(url => url.includes("/optimized/"));
  return (optimized && absolute(optimized, base)) || original;
}

function mediaId(tag: string, canonical: string) {
  const sha = attribute(tag, "data-base62-sha1");
  return sha ? `upload:${sha}` : canonical;
}

type Found = {at: number; item: MediaItem};

function lightboxMedia(source: string, base: string, options: ExtractOptions, seen: Set<string>, meta: Partial<MediaItem>): Found[] {
  const found: Found[] = [];
  const lightbox = /<a\b[^>]*class=["'][^"']*\blightbox\b[^"']*["'][^>]*>[\s\S]*?<\/a>/gi;
  let match: RegExpExecArray | null;
  while ((match = lightbox.exec(source))) {
    const block = match[0], open = /^<a\b[^>]*>/i.exec(block)![0], href = attribute(open, "href");
    const original = href ? absolute(href, base) : undefined;
    if (!original || !extensionAllowed(original, options)) continue;
    const image = /<img\b[^>]*>/i.exec(block)?.[0] ?? "";
    const canonical = canonicalMediaUrl(original), id = mediaId(image, canonical);
    if (seen.has(id) || seen.has(canonical)) continue;
    const raw = image ? imageSource(image) : undefined, shown = raw ? absolute(raw, base) : undefined;
    seen.add(id);
    seen.add(canonical);
    // The thumbnail inside the lightbox is the same media, not a second item.
    if (shown) seen.add(canonicalMediaUrl(shown));
    found.push({at: match.index, item: {
      id, type: /\.gif(?:$|[?#])/i.test(original) ? "gif" : "image", originalUrl: original,
      previewUrl: shown || original, sourceUrl: base,
      filename: attribute(open, "title") || attribute(image, "alt") || fileName(original), ...dimensions(image), score: 1, ...meta
    }});
  }
  return found;
}

function imageMedia(source: string, base: string, options: ExtractOptions, seen: Set<string>, meta: Partial<MediaItem>): Found[] {
  const found: Found[] = [];
  const images = /<img\b[^>]*>/gi;
  let match: RegExpExecArray | null;
  while ((match = images.exec(source))) {
    const tag = match[0], className = (attribute(tag, "class") ?? "").toLowerCase(), alt = (attribute(tag, "alt") ?? "").toLowerCase();
    const signals = `${className} ${alt}`;
    if (!options.includeAvatars && signals.includes("avatar")) continue;
    if (!options.includeEmoji && /emoji|reaction/.test(signals)) continue;
    if (/icon|badge|logo/.test(signals)) continue;
    const raw = imageSource(tag), original = raw ? absolute(raw, base) : undefined;
    if (!original || !extensionAllowed(original, options) || tooSmall(tag, options)) continue;
    const canonical = canonicalMediaUrl(original), id = mediaId(tag, canonical);
    if (seen.has(id) || seen.has(canonical)) continue;
    seen.add(id);
    seen.add(canonical);
    const animated = /\banimated\b/.test(className) || /\.gif(?:$|[?#])/i.test(original);
    found.push({at: match.index, item: {
      id, type: animated ? "gif" : "image", originalUrl: canonical, previewUrl: previewSource(tag, original, base), sourceUrl: base,
      filename: attribute(tag, "alt") || fileName(original), ...dimensions(tag), score: animated ? 0.9 : 0.65, ...meta
    }});
  }
  return found;
}

function videoMedia(source: string, base: string, options: ExtractOptions, seen: Set<string>, meta: Partial<MediaItem>): Found[] {
  const found: Found[] = [];
  const add = (at: number, tag: string, raw: string | undefined, poster: string | undefined) => {
    const url = raw && !UNUSABLE_SOURCE.test(raw) ? absolute(raw, base) : undefined;
    if (!url || seen.has(url) || tooSmall(tag, options)) return;
    seen.add(url);
    found.push({at, item: {
      id: url, type: "video", originalUrl: url, previewUrl: url, posterUrl: poster ? absolute(poster, base) : undefined,
      sourceUrl: base, filename: fileName(url), ...dimensions(tag), score: 0.8, ...meta
    }});
  };
  const videos = /<video\b[^>]*>[\s\S]*?<\/video>/gi;
  let match: RegExpExecArray | null;
  while ((match = videos.exec(source))) {
    const open = /^<video\b[^>]*>/i.exec(match[0])![0], inner = /<source\b[^>]*>/i.exec(match[0])?.[0] ?? "";
    add(match.index, open, attribute(open, "src") ?? attribute(inner, "src"), attribute(open, "poster"));
  }
  const placeholders = /<[a-z]+\b[^>]*\sdata-video-src\s*=[^>]*>/gi;
  while ((match = placeholders.exec(source))) add(match.index, match[0], attribute(match[0], "data-video-src"), attribute(match[0], "data-thumbnail-src"));
  return found;
}

/** Extracts posted media in document order. `meta` is merged into every item (post number, author...). */
export function extractMediaFromHtml(html: string, baseUrl: string, meta: Partial<MediaItem> = {}, settings: Partial<ExtractOptions> = {}): MediaItem[] {
  const options: ExtractOptions = {...DEFAULT_OPTIONS, ...settings};
  const source = options.quotedDuplicates === "show" ? html : html.replace(QUOTE_BLOCK, "");
  const seen = new Set<string>();
  const found = [
    ...lightboxMedia(source, baseUrl, options, seen, meta),
    ...imageMedia(source, baseUrl, options, seen, meta),
    ...(options.includeVideo ? videoMedia(source, baseUrl, options, seen, meta) : [])
  ].sort((a, b) => a.at - b.at).map(entry => entry.item);
  if (options.quotedDuplicates === "mark") {
    for (const quote of html.match(QUOTE_BLOCK) ?? []) {
      found.push(...extractMediaFromHtml(quote, baseUrl, {...meta, quoted: true}, {...options, quotedDuplicates: "show"}));
    }
  }
  return found;
}

/**
 * The page's own preview picture (Open Graph or Twitter card). Used only as a
 * last resort, when a page has no posted media at all.
 */
export function extractPageMetaMedia(html: string, baseUrl: string): MediaItem[] {
  const tags = html.match(/<meta\b[^>]*>/gi) ?? [];
  for (const name of ["og:image:secure_url", "og:image", "og:image:url", "twitter:image", "twitter:image:src"]) {
    const tag = tags.find(candidate => (attribute(candidate, "property") ?? attribute(candidate, "name"))?.toLowerCase() === name);
    const content = tag ? attribute(tag, "content") : undefined, url = content ? absolute(content, baseUrl) : undefined;
    if (!url || UNUSABLE_SOURCE.test(url)) continue;
    return [{id: canonicalMediaUrl(url), type: /\.gif(?:$|[?#])/i.test(url) ? "gif" : "image", originalUrl: url, previewUrl: url, sourceUrl: baseUrl, filename: fileName(url), score: 0.3}];
  }
  return [];
}

export function dedupeMedia(items: MediaItem[]) {
  return uniqueMediaItems(items);
}
