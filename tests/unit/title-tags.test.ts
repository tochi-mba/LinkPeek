import {describe, expect, it} from "vitest";
import {mineTags, titleHasTag} from "../../src/shared/title-tags";

const take = (titles: string[], limit?: number) => mineTags(titles, limit).map(tag => tag.key);

describe("mining tags from titles", () => {
  it("needs at least three distinct usable titles", () => {
    expect(mineTags([])).toEqual([]);
    expect(mineTags(["Alice", "Alice", " Alice ", "", "  ", "12 34 56"])).toEqual([]);
  });

  it("finds recurring names across distinct titles, keeping the first spelling for display", () => {
    const tags = mineTags(["Alice at the beach", "ALICE in town", "alice goes shopping", "Bob's day", "Bob again", "Bob the third", "Carol once"]);
    expect(tags.map(tag => tag.key)).toEqual(["alice", "bob"]);
    expect(tags[0]).toEqual({key: "alice", label: "Alice", count: 3});
  });

  it("counts each phrase once per title, however often it repeats inside one", () => {
    expect(take(["mia mia mia", "mia solo", "duo mia", "other things", "more other"])).toEqual(["mia"]);
  });

  it("drops stop words, bare numbers and single letters from phrases", () => {
    const tags = take(["The best of Mia part 1", "Mia 2 a new set", "mia 3 update", "noise here", "noise there x"]);
    expect(tags).toEqual(["mia"]);
  });

  it("treats what nearly every title shares as boilerplate, not a subject", () => {
    const titles = Array.from({length: 10}, (_, i) => `Subject ${i} – Candid Forum`);
    titles[0] = "Alice – Candid Forum";
    titles[1] = "Alice two – Candid Forum";
    titles[2] = "Alice three – Candid Forum";
    expect(take(titles)).toEqual(["alice"]);
  });

  it("lets the longer phrase absorb the shorter ones it carries", () => {
    // "beach" never occurs without "alice beach", so only the full phrase remains.
    expect(take(["Alice Beach one", "alice beach two", "alice beach three", "zebra", "yak", "xylo", "willow", "violet"]))
      .toEqual(["alice beach"]);
    // "alice" stands on its own often enough to stay a tag beside the phrase.
    const both = take([
      "Alice beach 1", "Alice beach 2", "Alice beach 3",
      "Alice city 1", "Alice city 2", "Alice city 3", "Alice park", "Alice home", "Alice away", "Alice solo",
      "zebra", "yak", "xylo", "willow", "violet", "umber", "teal", "sage"
    ]);
    expect(both).toContain("alice");
    expect(both).toContain("alice beach");
    expect(both).not.toContain("beach");
  });

  it("ranks by how many titles carry the tag, then alphabetically, up to the limit", () => {
    const tags = mineTags([
      "zoe aa", "zoe bb", "zoe cc", "zoe dd",
      "ann ee", "ann ff", "ann gg",
      "ben hh", "ben ii", "ben jj",
      "zebra", "yak", "xylo", "willow", "violet", "umber"
    ]);
    expect(tags.map(tag => tag.key)).toEqual(["zoe", "ann", "ben"]);
    expect(take(["zoe pp", "zoe qq", "zoe rr", "ann ss", "ann tt", "ann uu", "zebra", "yak", "xylo"], 1)).toEqual(["ann"]);
  });

  it("reads accented and non-Latin titles", () => {
    expect(take(["Café day", "café night", "CAFÉ noon", "zebra", "yak", "xylo", "willow", "violet"])).toEqual(["café"]);
  });
});

describe("matching a tag against a title", () => {
  it("matches the tag's words in a row, whatever the case, punctuation or stop words between them", () => {
    expect(titleHasTag("ALICE, at the BEACH!", "alice beach")).toBe(true);
    expect(titleHasTag("Alice stays home", "alice beach")).toBe(false);
    expect(titleHasTag("beach alice", "alice beach")).toBe(false);
    expect(titleHasTag("", "alice")).toBe(false);
    expect(titleHasTag("Alice", "alice")).toBe(true);
  });
});
