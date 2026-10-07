/**
 * Existing Tumblr downloads are already the offline copy. Chrome does not
 * expose their bytes, but its downloads history does expose the original URL,
 * absolute filename, size and download id. This turns those records back into
 * Library rows without downloading or caching the files a second time.
 */
import type {MediaLibrary} from "./media-library";
import type {MediaItem} from "../shared/media";
import {mediaKey, SEEN_PREFIX} from "../shared/seen-media";

export interface TumblrDownloadImport {
  url: string;
  local: string;
  blog: string;
  postId: string;
  at: number;
  type: MediaItem["type"];
  bytes: number;
  dl: number;
}

const VIDEO = new Set(["mp4", "mov", "m4v", "webm", "mkv"]);
const AUDIO = new Set(["mp3", "m4a", "ogg", "oga", "wav", "aac", "flac"]);
const PICTURE = new Set(["jpg", "jpeg", "png", "pnj", "webp", "avif", "gif", "jif"]);

/** A native path as a file: URL. It works when Chrome's “Allow access to file URLs” switch is on. */
export function localFileUrl(filename: string) {
  const path = filename.replace(/\\/g, "/");
  const encoded = path.split("/").map((part, index) => index === 0 && /^[a-z]:$/i.test(part) ? part : encodeURIComponent(part)).join("/");
  return `file://${path.startsWith("/") ? "" : "/"}${encoded}`;
}

/** Reads a LinkPeek/Tumblr filename and the usable media metadata around it. */
export function tumblrDownload(item: chrome.downloads.DownloadItem): TumblrDownloadImport | undefined {
  if (item.state !== "complete" || item.exists === false) return undefined;
  const filename = item.filename.replace(/\\/g, "/");
  const match = /(?:^|\/)LinkPeek\/Tumblr\/([^/]+)\/(?:(\d{4})-(\d{2})-(\d{2})|undated) (\d+)-\d+(?: \(\d+\))?\.([a-z0-9]+)$/i.exec(filename);
  if (!match) return undefined;
  const ext = match[6].toLowerCase(), mime = item.mime?.toLowerCase() ?? "";
  if (!VIDEO.has(ext) && !AUDIO.has(ext) && !PICTURE.has(ext)) return undefined;
  const url = item.finalUrl || item.url;
  if (!/^https?:\/\//i.test(url)) return undefined;
  const type: MediaItem["type"] = mime === "image/gif" || ext === "gif" ? "gif"
    : mime.startsWith("video/") || VIDEO.has(ext) ? "video"
    : mime.startsWith("audio/") || AUDIO.has(ext) ? "audio" : "image";
  const dated = match[2] ? new Date(Number(match[2]), Number(match[3]) - 1, Number(match[4]), 12).getTime() : undefined;
  const recorded = Date.parse(item.endTime ?? item.startTime ?? "");
  return {
    url, local: localFileUrl(item.filename), blog: match[1].toLowerCase(), postId: match[5],
    at: dated ?? (Number.isFinite(recorded) ? recorded : Date.now()), type,
    bytes: Math.max(0, item.fileSize ?? item.totalBytes ?? 0), dl: item.id
  };
}

export type TumblrImportResult = {found: number; imported: number};

/** Imports the newest surviving Downloads record for each Tumblr media URL. */
export async function importTumblrDownloads(library: MediaLibrary): Promise<TumblrImportResult> {
  const downloads = await chrome.downloads.search({orderBy: ["-startTime"]}).catch(() => []);
  const unique = new Map<string, TumblrDownloadImport>();
  for (const item of downloads) {
    const media = tumblrDownload(item);
    if (media && !unique.has(media.url)) unique.set(media.url, media);
  }
  const keyed = [...unique.values()].map(media => ({media, key: mediaKey({originalUrl: media.url})}));
  const bucketNames = [...new Set(keyed.map(({key}) => SEEN_PREFIX + key[0]))];
  const buckets = bucketNames.length ? await chrome.storage.local.get(bucketNames) : {};
  let imported = 0;
  for (const {media, key} of keyed) {
    const bucket = buckets[SEEN_PREFIX + key[0]];
    const seen = Array.isArray(bucket) && bucket.includes(key);
    const result = await library.importExternal(media.url, {
      seen, type: media.type, source: `https://www.tumblr.com/${encodeURIComponent(media.blog)}/${media.postId}`,
      title: `@${media.blog} · post ${media.postId}`, original: media.url, local: media.local,
      dl: media.dl, external: true, diskBytes: media.bytes
    }, media.at);
    if (result === "saved") imported++;
  }
  if (unique.size) await library.saveIndex();
  return {found: unique.size, imported};
}
