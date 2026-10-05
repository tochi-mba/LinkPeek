/**
 * Media for any page that is not a Discourse topic.
 *
 * Reads the page's HTML (or recognizes a direct image or video response) and
 * extracts posted media. When a page has none, an optional bounded search
 * follows its links to find galleries behind index pages. As a last resort the
 * page's own preview picture (og:image) is used.
 */
import type {MediaItem, ScanResult} from "../shared/media";
import {isStateChangingUrl, stripTrackingParams} from "../shared/media";
import type {LinkPeekSettings} from "../shared/settings";
import {dedupeMedia, extractMediaFromHtml, extractPageMetaMedia} from "./extract";

type PageScan = {finalUrl: string; title?: string; items: MediaItem[]; html?: string; direct?: "direct-image" | "direct-video"};

/** Enough for any real article or gallery page; bigger documents are cut off, not read whole. */
export const MAX_HTML_BYTES = 3 * 1024 * 1024;
const NON_PAGE = /\.(?:7z|avi|css|csv|docx?|exe|gz|ico|js|json|m4[av]|mov|mp[34]|pdf|pptx?|rar|tar|txt|wav|webm|xlsx?|xml|zip)(?:$|[?#])/i;
const PAGE_TYPE = /html|xml|text\/plain/i;

function clamp(value: number | undefined, fallback: number, min: number, max: number) {
  return Math.max(min, Math.min(max, Number.isFinite(value) ? Number(value) : fallback));
}

function referrerPolicy(settings?: LinkPeekSettings): ReferrerPolicy | undefined {
  if (settings?.referrerPolicy === "never") return "no-referrer";
  if (settings?.referrerPolicy === "same-origin") return "same-origin";
  return undefined;
}

/** Reads a response body as text, stopping after `maxBytes`. */
export async function readTextCapped(response: Response, maxBytes = MAX_HTML_BYTES) {
  const charset = /charset=([^;]+)/i.exec(response.headers.get("content-type") ?? "")?.[1]?.trim();
  let decoder: TextDecoder;
  try {
    decoder = new TextDecoder(charset || "utf-8");
  } catch {
    decoder = new TextDecoder("utf-8");
  }
  const reader = response.body?.getReader();
  if (!reader) return response.text();
  let text = "", bytes = 0;
  while (bytes < maxBytes) {
    const {done, value} = await reader.read();
    if (done) return text + decoder.decode();
    bytes += value.byteLength;
    text += decoder.decode(value, {stream: true});
  }
  await reader.cancel().catch(() => undefined);
  return text + decoder.decode();
}

function directItem(response: Response, requested: string, type: MediaItem["type"]): MediaItem {
  return {id: response.url, type, originalUrl: response.url, previewUrl: response.url, sourceUrl: requested, filename: new URL(response.url).pathname.split("/").pop(), score: 1};
}

async function fetchPage(url: string, settings: LinkPeekSettings | undefined, signal: AbortSignal | undefined, rootOrigin?: string): Promise<PageScan> {
  const controller = new AbortController(), abort = () => controller.abort();
  if (signal?.aborted) abort();
  else signal?.addEventListener("abort", abort, {once: true});
  const timer = setTimeout(abort, clamp(settings?.fetchTimeout, 8000, 500, 30000));
  try {
    const credentials = !rootOrigin || new URL(url).origin === rootOrigin ? "include" : "omit";
    const response = await fetch(url, {credentials, redirect: settings?.followRedirects === false ? "manual" : "follow", referrerPolicy: referrerPolicy(settings), signal: controller.signal});
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const type = (response.headers.get("content-type") ?? "").toLowerCase();
    if (type.startsWith("image/")) {
      void response.body?.cancel().catch(() => undefined);
      return {finalUrl: response.url, items: [directItem(response, url, type.includes("gif") ? "gif" : "image")], direct: "direct-image"};
    }
    if (type.startsWith("video/")) {
      void response.body?.cancel().catch(() => undefined);
      return {finalUrl: response.url, items: settings?.includeVideo === false ? [] : [directItem(response, url, "video")], direct: "direct-video"};
    }
    if (type && !PAGE_TYPE.test(type)) {
      // A download, a PDF, an audio stream...: nothing to preview, and never worth reading.
      void response.body?.cancel().catch(() => undefined);
      return {finalUrl: response.url, items: []};
    }
    const html = await readTextCapped(response);
    const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]?.replace(/\s+/g, " ").trim();
    return {finalUrl: response.url, title, items: extractMediaFromHtml(html, response.url, {}, settings), html};
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
}

/** Same-site (or any-site) links worth following from a page, skipping downloads, sign-outs and repeats. */
function linkedPages(html: string, base: string, rootOrigin: string, settings: LinkPeekSettings, seen: Set<string>) {
  const out: string[] = [];
  const anchors = /<a\b[^>]*\bhref=["']([^"']+)["'][^>]*>/gi;
  let match: RegExpExecArray | null;
  while ((match = anchors.exec(html))) {
    const tag = match[0], raw = match[1].replace(/&amp;/gi, "&");
    if (/\bdownload(?:\s|=|>)/i.test(tag) || /\brel=["'][^"']*\bnofollow\b/i.test(tag)) continue;
    let url: URL;
    try {
      url = new URL(raw, base);
    } catch {
      continue;
    }
    if (!/^https?:$/.test(url.protocol) || url.username || url.password || isStateChangingUrl(url) || NON_PAGE.test(url.href)) continue;
    if (settings.recursiveSearch !== "all" && url.origin !== rootOrigin) continue;
    url.hash = "";
    if (settings.stripTracking) stripTrackingParams(url);
    if (settings.canonicalizeQuery) url.searchParams.sort();
    if (seen.has(url.href)) continue;
    seen.add(url.href);
    out.push(url.href);
  }
  return out;
}

async function mapWithConcurrency<T, R>(values: T[], concurrency: number, work: (value: T) => Promise<R>) {
  const results: R[] = new Array(values.length);
  let next = 0;
  const worker = async () => {
    while (next < values.length) {
      const index = next++;
      results[index] = await work(values[index]);
    }
  };
  await Promise.all(Array.from({length: Math.min(concurrency, values.length)}, worker));
  return results;
}

function finish(raw: string, title: string | undefined, items: MediaItem[], adapter: string, failures: number, settings: LinkPeekSettings | undefined, kind: ScanResult["kind"] = "generic"): ScanResult {
  const deduped = dedupeMedia(items), cap = clamp(settings?.maxMediaItems, 400, 1, 5000), warnings: string[] = [];
  if (deduped.items.length > cap) warnings.push(`Stopped at the configured ${cap} media limit.`);
  if (failures) warnings.push(`Skipped ${failures} linked page${failures === 1 ? "" : "s"} that could not be read.`);
  return {url: raw, kind, title, items: deduped.items.slice(0, cap), complete: true, diagnostics: {adapter, ignored: failures, duplicates: deduped.duplicates, warnings}};
}

/**
 * Scans a page. With `allowRecursive` false only the page itself is read,
 * which is what speculative prefetch uses.
 */
export async function scanGeneric(raw: string, settings?: LinkPeekSettings, signal?: AbortSignal, allowRecursive = true): Promise<ScanResult> {
  const root = await fetchPage(raw, settings, signal);
  if (root.direct) return finish(raw, root.title, root.items, "Direct media", 0, settings, root.direct);
  const recursionOn = Boolean(settings && settings.recursiveSearch !== "off");
  const wantsRecursion = allowRecursive && recursionOn && Boolean(root.html) && (root.items.length === 0 || settings!.recursiveTrigger === "always");
  let items = root.items, pagesRead = 1, failures = 0;
  if (wantsRecursion) {
    const options = settings!, rootOrigin = new URL(root.finalUrl).origin;
    const maxDepth = clamp(options.recursiveMaxDepth, 1, 1, 3), maxPages = clamp(options.recursiveMaxPages, 6, 1, 50), cap = clamp(options.maxMediaItems, 400, 1, 5000);
    const concurrency = clamp(options.maxRequests, 3, 1, 4), seen = new Set<string>([root.finalUrl]);
    let frontier = linkedPages(root.html!, root.finalUrl, rootOrigin, options, seen), depth = 1;
    const found: MediaItem[] = [];
    while (frontier.length && pagesRead < maxPages && found.length < cap) {
      const batch = frontier.slice(0, maxPages - pagesRead);
      pagesRead += batch.length;
      const pages = await mapWithConcurrency(batch, concurrency, async url => {
        try {
          const page = await fetchPage(url, options, signal, rootOrigin);
          if (options.recursiveSearch !== "all" && new URL(page.finalUrl).origin !== rootOrigin) throw new Error("Left the site");
          return page;
        } catch (error) {
          if (signal?.aborted) throw error;
          failures++;
          return undefined;
        }
      });
      const next: string[] = [];
      for (const page of pages) {
        if (!page) continue;
        found.push(...page.items);
        if (!page.direct && page.html && depth < maxDepth) next.push(...linkedPages(page.html, page.finalUrl, rootOrigin, options, seen));
      }
      frontier = next;
      depth++;
    }
    items = [...root.items, ...found];
  }
  // A page's preview picture is better than an empty gallery, but must not stop a pending linked-page search.
  if (!items.length && root.html && (allowRecursive || !recursionOn)) {
    const preview = extractPageMetaMedia(root.html, root.finalUrl);
    if (preview.length) return finish(raw, root.title, preview, "Page preview image", failures, settings);
  }
  return finish(raw, root.title, items, pagesRead > 1 ? "Generic linked-page search" : "Generic HTML", failures, settings);
}
