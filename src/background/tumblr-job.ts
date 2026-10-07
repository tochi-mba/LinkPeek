/**
 * Downloads every file a Tumblr blog holds, in the background: closing the
 * popup or leaving the page does not stop it.
 *
 * Posts are read a page at a time while files download a few at a time, so
 * saving starts at once. Every file saved is remembered per blog, so pressing
 * again later fetches only what is new — or carries on from where an
 * interrupted run stopped. Progress lives in session storage (the popup draws
 * it) and on the toolbar badge.
 */
import {apiTokenFrom, firstPostsPath, mediaOf, readPostsPage, tumblrFileName, type TumblrMedia} from "../core/tumblr";
import type {TumblrJobState, TumblrPhase} from "../shared/messages";

export type {TumblrJobState, TumblrPhase} from "../shared/messages";

export const TUMBLR_JOB = "tumblrJob";
export const TUMBLR_SAVED_PREFIX = "tumblrSaved:";
/**
 * What the downloads ask for. Asked like a web page, Tumblr's media hosts
 * answer with an HTML viewer instead of the file, so this names media types
 * first (and the formats files are named after before newer ones).
 */
export const MEDIA_ACCEPT = "image/png,image/jpeg,image/gif,video/mp4,video/quicktime,image/*;q=0.8,video/*;q=0.8,audio/*;q=0.8,*/*;q=0.5";

/** Downloads saved at once: enough to keep busy, few enough to leave the connection usable. */
const WORKERS = 3;
/** A download that has not finished by now is counted as failed, so one stuck file cannot stall the rest. */
const DOWNLOAD_TIMEOUT_MS = 10 * 60_000;
/** How many saved files are remembered between writes of the memory. */
const REMEMBER_EVERY = 25;
const API = "https://www.tumblr.com/api";

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export class TumblrDownloader {
  private run?: {blog: string; stop: boolean; state: TumblrJobState};
  private finishing = new Map<number, (ok: boolean) => void>();

  /** The job running or last run, for the popup. One left mid-way by a worker that was shut down reads as stopped. */
  async status(): Promise<TumblrJobState | undefined> {
    if (this.run) return this.run.state;
    const stored = (await chrome.storage.session.get(TUMBLR_JOB))[TUMBLR_JOB] as TumblrJobState | undefined;
    return stored?.phase === "collecting" ? {...stored, phase: "stopped"} : stored;
  }

  /** Starts on a blog (one job at a time: while one runs, its state is the answer). */
  start(blog: string): TumblrJobState {
    if (this.run) return this.run.state;
    const state: TumblrJobState = {blog, phase: "collecting", posts: 0, total: 0, found: 0, saved: 0, failed: 0, skipped: 0, collected: false};
    this.run = {blog, stop: false, state};
    void this.work(this.run);
    return state;
  }

  /** Stops starting new downloads; those already under way finish. */
  stop() {
    if (this.run) this.run.stop = true;
  }

  /** Forgets which files of a blog were saved, so the next run saves everything again. */
  async forget(blog: string) {
    await chrome.storage.local.remove(TUMBLR_SAVED_PREFIX + blog);
  }

  /** Feeds Chrome's download events in, so each download's end is known. */
  onDownloadChanged(delta: chrome.downloads.DownloadDelta) {
    const state = delta.state?.current;
    if (state === "complete" || state === "interrupted") this.finishing.get(delta.id)?.(state === "complete");
  }

  private async publish(state: TumblrJobState) {
    await chrome.storage.session.set({[TUMBLR_JOB]: state}).catch(() => undefined);
    // Reading posts fills the first half of the badge, saving files the second.
    const share = state.collected ? 0.5 + 0.5 * (state.saved + state.failed) / Math.max(1, state.found) : 0.5 * state.posts / Math.max(1, state.total);
    const text = state.phase === "collecting" ? `${Math.min(99, Math.floor(share * 100))}%` : "";
    await chrome.action?.setBadgeText({text}).catch(() => undefined);
  }

  private async work(run: {blog: string; stop: boolean; state: TumblrJobState}) {
    const {blog, state} = run;
    const memoryKey = TUMBLR_SAVED_PREFIX + blog;
    const stored = (await chrome.storage.local.get(memoryKey))[memoryKey];
    const saved = new Set<string>(Array.isArray(stored) ? stored : []);
    const queue: TumblrMedia[] = [], queued = new Set<string>(), waiting: Array<() => void> = [];
    const wake = () => waiting.splice(0).forEach(resolve => resolve());
    let unsaved = 0;
    const remember = () => chrome.storage.local.set({[memoryKey]: [...saved]}).catch(() => undefined);
    const worker = async () => {
      while (!run.stop) {
        const media = queue.shift();
        if (!media) {
          if (state.collected) return;
          await new Promise<void>(resolve => waiting.push(resolve));
          continue;
        }
        if (await this.save(blog, media)) {
          state.saved++;
          saved.add(media.key);
          if (++unsaved >= REMEMBER_EVERY) {
            unsaved = 0;
            await remember();
          }
        } else {
          state.failed++;
        }
        await this.publish(state);
      }
    };
    const workers = Array.from({length: WORKERS}, worker);
    await this.publish(state);
    try {
      let token = await this.token(blog), path: string | undefined = firstPostsPath(blog);
      while (path && !run.stop) {
        const answer = await this.page(path, token, async () => token = await this.token(blog));
        const page = readPostsPage(answer);
        state.total = Math.max(state.total, page.total);
        for (const post of page.posts) {
          // Ads ride along in the stream; only posts count.
          if (post.object_type !== "post") continue;
          state.posts++;
          for (const media of mediaOf(post)) {
            // Saved on an earlier run, or already waiting (a reblog of a post seen earlier in this one).
            if (saved.has(media.key) || queued.has(media.key)) {
              state.skipped++;
              continue;
            }
            state.found++;
            queued.add(media.key);
            queue.push(media);
          }
        }
        wake();
        await this.publish(state);
        path = page.next;
      }
    } catch (error) {
      state.phase = "failed";
      state.error = (error as Error).message;
    }
    state.collected = true;
    wake();
    await Promise.all(workers);
    await remember();
    if (state.phase !== "failed") state.phase = run.stop ? "stopped" : "done";
    this.run = undefined;
    await this.publish(state);
  }

  /** The web app's token, read from the blog's own page on tumblr.com. */
  private async token(blog: string) {
    const response = await fetch(`https://www.tumblr.com/${encodeURIComponent(blog)}`, {credentials: "include"});
    if (response.status === 404) throw new Error("This blog doesn't exist, or isn't public");
    const token = response.ok ? apiTokenFrom(await response.text()) : undefined;
    if (!token) throw new Error(`Couldn't open this blog on tumblr.com (${response.status})`);
    return token;
  }

  /** One page of posts, waiting out rate limits and fetching a fresh token once if the old one is refused. */
  private async page(path: string, token: string, refresh: () => Promise<string>): Promise<unknown> {
    let refreshed = false;
    const request = async (attempt: number): Promise<unknown> => {
      const response = await fetch(`${API}${path}`, {credentials: "include", headers: {Authorization: `Bearer ${token}`}});
      if (response.ok) return response.json();
      if ((response.status === 401 || response.status === 403) && !refreshed) {
        refreshed = true;
        token = await refresh();
        return request(attempt + 1);
      }
      if (response.status === 429 && attempt < 5) {
        const after = Number(response.headers.get("retry-after"));
        await sleep(Number.isFinite(after) && after > 0 ? after * 1000 : 15_000 * (attempt + 1));
        return request(attempt + 1);
      }
      throw new Error(`Tumblr refused the posts (${response.status})`);
    };
    return request(0);
  }

  /** Saves one file into Downloads and waits for it to finish; false when it could not be saved. */
  private async save(blog: string, media: TumblrMedia) {
    const id = await chrome.downloads.download({
      url: media.url, filename: tumblrFileName(blog, media), conflictAction: "uniquify", saveAs: false,
      headers: [{name: "Accept", value: MEDIA_ACCEPT}]
    }).catch(() => undefined);
    if (id === undefined) return false;
    const done = new Promise<boolean>(resolve => {
      const timer = setTimeout(() => resolve(false), DOWNLOAD_TIMEOUT_MS);
      this.finishing.set(id, ok => {
        clearTimeout(timer);
        resolve(ok);
      });
    });
    // It may have finished already, before anyone was listening.
    const [now] = await chrome.downloads.search({id}).catch(() => []);
    if (now?.state === "complete" || now?.state === "interrupted") this.onDownloadChanged({id, state: {current: now.state}});
    const ok = await done;
    this.finishing.delete(id);
    return ok;
  }
}
