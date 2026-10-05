/**
 * Whole-thread media for Discourse topics.
 *
 * The topic JSON carries the first page of posts and the full post-id stream.
 * Missing posts are fetched in batches and their cooked bodies parsed, so the
 * gallery covers the whole thread rather than whatever the page has mounted.
 */
import type {MediaItem, ScanResult} from "../shared/media";
import type {LinkPeekSettings} from "../shared/settings";
import {dedupeMedia, extractMediaFromHtml} from "./extract";
import {fetchWithRetry, type RetryMode} from "./http";

export type DPost = {id: number; post_number: number; username?: string; cooked?: string; post_url?: string};
export type DTopic = {id: number; title?: string; post_stream?: {posts?: DPost[]; stream?: number[]}};
export type DiscourseSeed = {topic: DTopic; warning?: string};
export type DiscourseScanHooks = {signal?: AbortSignal; onProgress?: (result: ScanResult) => void};

const LIMIT_WARNING = "Stopped at the configured";
const PROGRESS_INTERVAL_MS = 120;

function ensureNotAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
}

function topicJsonUrl(raw: string) {
  const url = new URL(raw), parts = url.pathname.split("/").filter(Boolean), t = parts.indexOf("t");
  if (t < 0) return null;
  const idIndex = parts.findIndex((part, index) => index > t && /^\d+$/.test(part));
  if (idIndex < 0) return null;
  url.pathname = `/${parts.slice(0, idIndex + 1).join("/")}.json`;
  url.search = "";
  url.hash = "";
  return url;
}

async function fetchText(url: string, signal?: AbortSignal, retryMode: RetryMode = "interactive") {
  ensureNotAborted(signal);
  return fetchWithRetry(url, {credentials: "include", redirect: "follow", signal}, retryMode, undefined, async response => {
    if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
    return response.text();
  });
}

async function fetchJson(url: string, signal?: AbortSignal, retryMode: RetryMode = "interactive") {
  return JSON.parse(await fetchText(url, signal, retryMode));
}

/** Reads the topic Discourse embeds in its HTML for crawlers, when the JSON endpoint is blocked. */
export function parsePreloadedDiscourseTopic(html: string, topicId: number): DTopic | null {
  const script = /<script\b[^>]*id=["']data-preloaded["'][^>]*>([\s\S]*?)<\/script>/i.exec(html)?.[1];
  if (!script) return null;
  try {
    const preload = JSON.parse(script.trim()) as Record<string, unknown>, raw = preload[`topic_${topicId}`];
    if (typeof raw === "string") return JSON.parse(raw) as DTopic;
    if (raw && typeof raw === "object") return raw as DTopic;
  } catch {
    // Malformed preload data: fall through to the original error.
  }
  return null;
}

async function fetchTopic(raw: string, jsonUrl: URL, signal?: AbortSignal, retryMode: RetryMode = "interactive"): Promise<DiscourseSeed> {
  try {
    return {topic: await fetchJson(jsonUrl.href, signal, retryMode) as DTopic};
  } catch (primaryError) {
    if (signal?.aborted) throw primaryError;
    const id = Number(/(\d+)\.json$/.exec(jsonUrl.pathname)![1]);
    const fallback = parsePreloadedDiscourseTopic(await fetchText(raw, signal, retryMode), id);
    if (!fallback) throw primaryError;
    return {topic: fallback, warning: "Used embedded Discourse topic data after the JSON endpoint was unavailable."};
  }
}

function mediaFromPosts(posts: DPost[], topicUrl: string, settings?: LinkPeekSettings) {
  const items: MediaItem[] = [];
  for (const post of posts) {
    if (!post.cooked) continue;
    const source = post.post_url ? new URL(post.post_url, topicUrl).href : `${topicUrl.replace(/\/$/, "")}/${post.post_number}`;
    items.push(...extractMediaFromHtml(post.cooked, topicUrl, {postId: post.id, postNumber: post.post_number, author: post.username, sourceUrl: source}, settings));
  }
  return items;
}

function toResult(raw: string, topic: DTopic, items: MediaItem[], postsScanned: number, totalPosts: number, settings: LinkPeekSettings | undefined, complete: boolean, warning?: string): ScanResult {
  const deduped = dedupeMedia(items), cap = Math.max(1, Math.min(5000, settings?.maxMediaItems ?? 400));
  const warnings = warning ? [warning] : [];
  if (deduped.items.length > cap) warnings.push(`${LIMIT_WARNING} ${cap} media limit.`);
  return {
    url: raw, kind: "discourse", title: topic.title, items: deduped.items.slice(0, cap), complete, postsScanned, totalPosts,
    diagnostics: {adapter: "Discourse", ignored: 0, duplicates: deduped.duplicates, warnings}
  };
}

function hitLimit(result: ScanResult) {
  return result.diagnostics!.warnings.some(warning => warning.startsWith(LIMIT_WARNING));
}

/** The post ids this scan covers, honouring the thread scope and post limit. */
function scopedStream(topic: DTopic, settings: LinkPeekSettings | undefined, maxPosts: number) {
  const initial = topic.post_stream?.posts ?? [], all = topic.post_stream?.stream ?? initial.map(post => post.id);
  const limit = settings?.scanScope === "first" ? Math.min(maxPosts, 50) : maxPosts;
  return {limit, stream: (settings?.scanScope === "page" ? initial.map(post => post.id) : all).slice(0, limit)};
}

function initialState(raw: string, topic: DTopic, stream: number[], settings?: LinkPeekSettings, warning?: string) {
  const topicUrl = new URL(raw);
  topicUrl.hash = "";
  topicUrl.search = "";
  const selected = new Set(stream);
  const posts = [...new Map((topic.post_stream?.posts ?? []).filter(post => selected.has(post.id)).map(post => [post.id, post])).values()].sort((a, b) => a.post_number - b.post_number);
  const items = mediaFromPosts(posts, topicUrl.href, settings);
  return {topicUrl: topicUrl.href, posts, items, result: toResult(raw, topic, items, posts.length, stream.length, settings, posts.length >= stream.length, warning)};
}

/** The first page of a topic, cheap enough to run before hover. The seed lets a later full scan skip the topic request. */
export async function prefetchDiscourse(raw: string, settings?: LinkPeekSettings, signal?: AbortSignal): Promise<{result: ScanResult; seed: DiscourseSeed}> {
  const jsonUrl = topicJsonUrl(raw);
  if (!jsonUrl) throw new Error("Not a Discourse topic URL");
  const seed = await fetchTopic(raw, jsonUrl, signal, "background");
  const {stream} = scopedStream(seed.topic, settings, settings?.maxPosts ?? 2000);
  return {result: initialState(raw, seed.topic, stream, settings, seed.warning).result, seed};
}

async function fetchBatch(topicId: number, origin: string, ids: number[], signal?: AbortSignal): Promise<DPost[]> {
  ensureNotAborted(signal);
  const url = new URL(`/t/${topicId}/posts.json`, origin);
  for (const id of ids) url.searchParams.append("post_ids[]", String(id));
  try {
    const data = await fetchJson(url.href, signal) as {post_stream?: {posts?: DPost[]}};
    return data.post_stream?.posts ?? [];
  } catch (error) {
    if (signal?.aborted) throw error;
    // Some forums disable the batch endpoint; fall back to one request per post.
    const recovered: DPost[] = [];
    for (const id of ids) {
      ensureNotAborted(signal);
      try {
        recovered.push(await fetchJson(new URL(`/posts/${id}.json`, origin).href, signal) as DPost);
      } catch (inner) {
        if (signal?.aborted) throw inner;
      }
    }
    return recovered;
  }
}

/** Scans every post in the topic, reporting progress as batches arrive. */
export async function scanDiscourse(raw: string, batchSize = 50, maxPosts = 2000, settings?: LinkPeekSettings, seed?: DiscourseSeed, hooks: DiscourseScanHooks = {}): Promise<ScanResult> {
  const {signal, onProgress} = hooks, jsonUrl = topicJsonUrl(raw);
  if (!jsonUrl) throw new Error("Not a Discourse topic URL");
  ensureNotAborted(signal);
  const fetched = seed ?? await fetchTopic(raw, jsonUrl, signal), topic = fetched.topic;
  const {limit, stream} = scopedStream(topic, settings, maxPosts);
  const state = initialState(raw, topic, stream, settings, fetched.warning);
  const have = new Set(state.posts.map(post => post.id)), missing = stream.filter(id => !have.has(id));
  const first = {...state.result, complete: missing.length === 0 || hitLimit(state.result)};
  onProgress?.(first);
  if (first.complete) return first;

  const size = Math.max(1, Math.min(100, batchSize || 50)), batches: number[][] = [];
  for (let i = 0; i < missing.length; i += size) batches.push(missing.slice(i, i + size));
  const batchPosts: DPost[][] = batches.map(() => []), batchItems: MediaItem[][] = batches.map(() => []);
  let cursor = 0, completed = 0, capped = false, lastProgressAt = performance.now();
  const compose = (complete: boolean) => {
    const postsScanned = state.posts.length + batchPosts.reduce((sum, posts) => sum + posts.length, 0);
    return toResult(raw, topic, [...state.items, ...batchItems.flat()], postsScanned, stream.length, settings, complete, fetched.warning);
  };
  const worker = async () => {
    while (!capped && cursor < batches.length) {
      ensureNotAborted(signal);
      const index = cursor++;
      batchPosts[index] = await fetchBatch(topic.id, jsonUrl.origin, batches[index], signal);
      batchItems[index] = mediaFromPosts(batchPosts[index], state.topicUrl, settings);
      completed++;
      const progress = compose(false), now = performance.now();
      if (hitLimit(progress)) capped = true;
      if (onProgress && completed < batches.length && now - lastProgressAt >= PROGRESS_INTERVAL_MS) {
        lastProgressAt = now;
        onProgress(progress);
      }
    }
  };
  const concurrency = Math.max(1, Math.min(settings?.maxRequests ?? 3, batches.length));
  await Promise.all(Array.from({length: concurrency}, worker));
  ensureNotAborted(signal);
  const final = compose(true);
  final.complete = capped || final.postsScanned! >= Math.min(stream.length, limit);
  return final;
}
