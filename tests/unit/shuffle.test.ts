import {describe, expect, it} from "vitest";
import {ShuffleMix, shuffled} from "../../src/content/shuffle";
import type {MediaItem, ScanResult} from "../../src/shared/media";

const item = (link: string, n: number): MediaItem => ({
  id: `${link}-${n}`, type: "image", originalUrl: `https://cdn.test/${link}/${n}.jpg`, previewUrl: `https://cdn.test/${link}/${n}-small.jpg`, sourceUrl: `https://x.test/${link}`, score: 1
});
const gallery = (link: string, count: number, links: string[] = []): ScanResult => ({
  url: `https://x.test/${link}`, kind: "generic", complete: true, items: Array.from({length: count}, (_, n) => item(link, n)),
  linkContexts: [{sourceUrl: `https://x.test/${link}`, links}]
});
/** A repeatable stand-in for Math.random. */
function seeded(seed = 7) {
  return () => (seed = (seed * 16807) % 2147483647) / 2147483647;
}

describe("shuffling", () => {
  it("keeps every value and leaves the input alone", () => {
    const input = [1, 2, 3, 4, 5];
    expect(shuffled(input, seeded()).sort()).toEqual(input);
    expect(input).toEqual([1, 2, 3, 4, 5]);
  });
});

describe("the mix", () => {
  it("never puts two items from one link next to each other while another link has media", () => {
    const mix = new ShuffleMix(() => false, seeded());
    mix.add("a", gallery("a", 6));
    mix.add("b", gallery("b", 3));
    mix.add("c", gallery("c", 3));
    expect([mix.remaining, mix.links]).toEqual([12, 3]);
    const taken = mix.take(20);
    const links = taken.map(entry => entry.sourceUrl);
    expect(links.every((link, i) => i === 0 || link !== links[i - 1])).toBe(true);
    // Only "a" is left, and it was just shown: nothing more until another link arrives...
    expect(mix.remaining).toBeGreaterThan(0);
    expect(mix.take(5)).toEqual([]);
    // ...unless there is nothing left to explore.
    expect(mix.take(5, true).length).toBeGreaterThan(0);
  });

  it("skips media already seen, already in the mix, or seen after it was queued", () => {
    const seen = new Set(["https://cdn.test/a/0.jpg"]);
    const mix = new ShuffleMix(media => seen.has(media.originalUrl), seeded());
    mix.add("a", gallery("a", 3));
    mix.add("a", gallery("a", 3));
    // The same picture reached through another link counts once.
    mix.add("b", {...gallery("b", 1), items: [item("a", 1), item("b", 0)]});
    expect(mix.has("a")).toBe(true);
    seen.add("https://cdn.test/a/2.jpg");
    const taken = mix.take(10, true).map(entry => entry.originalUrl);
    expect(taken.sort()).toEqual(["https://cdn.test/a/1.jpg", "https://cdn.test/b/0.jpg"]);
    expect(mix.take(1, true)).toEqual([]);
  });

  it("explores each link at most once, in random order, following links only when asked", () => {
    const mix = new ShuffleMix(() => false, seeded());
    mix.explore(["p1", "p2", "p2"]);
    mix.add("a", gallery("a", 0, ["c1", "c2", "p1"]));
    mix.add("b", gallery("b", 0, ["skipped"]), false);
    mix.add("c", {url: "c", kind: "direct-image", complete: true, items: []});
    expect(mix.exploring).toBe(4);
    const order = [...mix.nextLinks(3), ...mix.nextLinks(3)];
    expect(order.sort()).toEqual(["c1", "c2", "p1", "p2"]);
    // A link whose gallery was added is never explored again.
    mix.explore(["a", "c1"]);
    expect([mix.exploring, mix.nextLinks(1)]).toEqual([0, []]);
  });
});

describe("GIFs first", () => {
  const mixed = (link: string, kinds: Array<"gif" | "image">): ScanResult => ({...gallery(link, kinds.length), items: kinds.map((type, n) => ({...item(link, n), type}))});

  it("shows every GIF before any still picture while GIFs from other links are on offer", () => {
    const mix = new ShuffleMix(() => false, seeded(), true);
    mix.add("a", mixed("a", ["image", "gif"]));
    mix.add("b", mixed("b", ["gif", "image"]));
    mix.add("c", mixed("c", ["image", "gif"]));
    const order = mix.take(10, true), links = order.map(entry => entry.sourceUrl);
    expect(order.slice(0, 3).map(entry => entry.type)).toEqual(["gif", "gif", "gif"]);
    expect(links.every((link, i) => i === 0 || link !== links[i - 1] || links.slice(i - 1).every(rest => rest === link))).toBe(true);
  });

  it("fills in with a still picture rather than repeat the link that holds the only GIFs, and never waits for one", () => {
    const mix = new ShuffleMix(() => false, seeded(), true);
    mix.add("a", mixed("a", ["gif", "gif"]));
    mix.add("b", mixed("b", ["image"]));
    expect(mix.take(3).map(entry => `${entry.sourceUrl.slice(-1)}:${entry.type}`)).toEqual(["a:gif", "b:image", "a:gif"]);
  });

  it("explores links known to hold GIFs first", () => {
    const mix = new ShuffleMix(() => false, seeded(), true);
    mix.explore(["p1", "p2", "gif1", "p3", "gif2"]);
    expect(mix.nextLinks(2, link => link.startsWith("gif")).sort()).toEqual(["gif1", "gif2"]);
    expect(mix.nextLinks(1, link => link.startsWith("gif"))).toHaveLength(1);
  });
});
