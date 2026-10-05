/**
 * The shuffle: an endless mix of media from many links.
 *
 * Each link's media waits in its own randomly ordered queue. Every pick takes
 * the next item from a random link other than the one just shown, so two
 * slides in a row never come from the same link while another link has media
 * left. Media already in the mix, or already seen, is skipped.
 *
 * The mix also keeps the frontier of links still to explore: the page's own
 * links first, then links found on the pages read so far. Links come out in
 * random order, each at most once.
 */
import {canonicalMediaUrl, type MediaItem, type ScanResult} from "../shared/media";

export type Random = () => number;

export function shuffled<T>(values: readonly T[], random: Random): T[] {
  const out = [...values];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

export class ShuffleMix {
  private queues = new Map<string, MediaItem[]>();
  /** Links whose media is in the mix, so each is added once. */
  private added = new Set<string>();
  /** Media already placed in the mix, by canonical address. */
  private placed = new Set<string>();
  private last?: string;
  /** Links to explore, and every link ever queued so none is explored twice. */
  private frontier: string[] = [];
  private queued = new Set<string>();

  constructor(private isSeen: (item: MediaItem) => boolean, private random: Random = Math.random) {}

  /** Adds a link's gallery; the links its pages lead to join the frontier. */
  add(link: string, result: ScanResult, followLinks = true) {
    // Its own gallery is here now, so it never needs exploring.
    this.queued.add(link);
    if (followLinks) for (const context of result.linkContexts ?? []) this.explore(context.links);
    if (this.added.has(link)) return;
    this.added.add(link);
    const items = shuffled(result.items, this.random).filter(item => !this.isSeen(item) && !this.placed.has(canonicalMediaUrl(item.originalUrl)));
    if (items.length) this.queues.set(link, items);
  }

  has(link: string) {
    return this.added.has(link);
  }

  /** Media waiting across all links. */
  get remaining() {
    let count = 0;
    for (const queue of this.queues.values()) count += queue.length;
    return count;
  }

  /** Links that still have media waiting. */
  get links() {
    return this.queues.size;
  }

  /**
   * Up to `count` items, never two in a row from one link. With `repeatLink`,
   * a lone remaining link may follow itself (used once there is nothing left
   * to explore, so the shuffle does not stall).
   */
  take(count: number, repeatLink = false) {
    const out: MediaItem[] = [];
    while (out.length < count) {
      const choices = [...this.queues.keys()].filter(link => link !== this.last || (repeatLink && this.queues.size === 1));
      if (!choices.length) break;
      const link = choices[Math.floor(this.random() * choices.length)], queue = this.queues.get(link)!, item = queue.shift()!;
      if (!queue.length) this.queues.delete(link);
      const key = canonicalMediaUrl(item.originalUrl);
      // Seen since it was queued (in a normal preview), or the same picture reached through another link.
      if (this.isSeen(item) || this.placed.has(key)) continue;
      this.placed.add(key);
      this.last = link;
      out.push(item);
    }
    return out;
  }

  /** Queues links to explore later; each link is queued once, ever. */
  explore(links: readonly string[]) {
    for (const link of links) {
      if (this.queued.has(link)) continue;
      this.queued.add(link);
      this.frontier.push(link);
    }
  }

  /** The next `count` links to explore, picked at random. */
  nextLinks(count: number) {
    const out: string[] = [];
    while (out.length < count && this.frontier.length) {
      const at = Math.floor(this.random() * this.frontier.length);
      out.push(this.frontier[at]);
      this.frontier[at] = this.frontier[this.frontier.length - 1];
      this.frontier.pop();
    }
    return out;
  }

  get exploring() {
    return this.frontier.length;
  }
}
