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

  it("offers a subject that appears in just two titles", () => {
    expect(take(["mia mia mia", "mia solo", "duo mia", "other things", "more other"])).toEqual(["mia", "other"]);
  });

  it("drops stop words, bare numbers, single letters and media noise from phrases", () => {
    expect(take(["The best of Mia part 1", "Mia 2 a new set", "mia 3 update", "noise here", "noise there x"])).toEqual(["mia", "noise"]);
    expect(take(["Mia 1080p rip", "mia 4k hd", "MIA s01e02 uhd", "pad qq", "pad ww"])).toEqual(["mia", "pad"]);
  });

  it("folds plurals into their singular when both occur, leaving lone endings alone", () => {
    const tags = mineTags([
      "Sunny beach walk", "two beaches here", "beach again now",
      "city lights aa", "cities glow bb", "city view cc",
      "glass houses", "glass towers", "rx7 drive", "rx7 night"
    ]);
    expect(tags.map(tag => tag.key)).toEqual(["beach", "city", "glass", "rx7"]);
    expect(tags[0].count).toBe(3);
  });

  it("folds a trailing number into the word it varies, when that word occurs on its own", () => {
    expect(take(["Mia beach", "mia2 x2 pose", "mia3 walk", "filler qq", "filler ww"])).toEqual(["mia", "filler"]);
  });

  it("splits camelCase words so run-together titles still match", () => {
    const tags = mineTags(["AliceBeach set", "alice beach fun", "Alice beach more", "zebra", "yak", "xylo"]);
    expect(tags.map(tag => tag.key)).toEqual(["alice beach"]);
    expect(tags[0].label).toBe("Alice Beach");
  });

  it("cuts a separator segment repeated across titles before counting anything", () => {
    const tags = take([
      "Alice aa – Candid Forum", "Alice bb – Candid Forum", "Alice cc – Candid Forum",
      "Bob dd – Candid Forum", "Bob ee", "Bob ff",
      "Carol gg", "Carol hh", "Dave ii", "Dave jj",
      "Candid Forum"
    ]);
    expect(tags).toEqual(["alice", "bob", "carol", "dave"]);
    expect(tags).not.toContain("candid");
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

  it("picks for variety: smaller subjects come before a big subject's sub-themes", () => {
    const tags = take([
      "Alice beach aa", "Alice beach bb", "Alice beach cc",
      "Alice city dd", "Alice city ee", "Alice city ff",
      "Bob gg", "Bob hh",
      "Carol ii", "Carol jj"
    ], 4);
    expect(tags).toEqual(["alice", "bob", "carol", "alice beach"]);
  });

  it("prefers the fuller phrase when a tie must break, whichever side of it stands", () => {
    expect(take(["rose lily aa", "rose lily bb", "moss cc", "moss dd"])).toEqual(["rose lily", "moss"]);
    expect(take(["moss cc", "moss dd", "rose lily aa", "rose lily bb"])).toEqual(["rose lily", "moss"]);
  });

  it("breaks a coverage tie by how common each phrase is", () => {
    // After "mega big" is picked, "wide" (4 titles, damped) and "sub" (2 fresh) tie on coverage; the commoner one wins.
    expect(take([
      "wide mega big aa", "mega big wide bb", "mega big cc wide", "wide dd mega big",
      "sub ee", "sub ff"
    ])).toEqual(["mega big", "wide", "sub"]);
  });

  it("holds nothing back: the diverse picks lead and the long tail follows by count", () => {
    expect(take(["rose lily aa", "rose lily bb", "rose cc", "rose dd", "lily ee", "lily ff"])).toEqual(["lily", "rose", "rose lily"]);
    const tags = take([
      "rose lily aa", "rose lily bb", "rose cc", "rose dd", "lily ee", "lily ff",
      "mint fern gg", "mint fern hh", "mint jj", "mint kk", "fern mm", "fern nn",
      "oak elm pp", "oak elm qq", "oak elm rr", "oak ss", "oak tt", "oak uu", "elm vv", "elm ww", "elm xx"
    ]);
    expect(new Set(tags.slice(0, 6))).toEqual(new Set(["rose", "lily", "mint", "fern", "oak", "elm"]));
    expect(tags.slice(6)).toEqual(["oak elm", "mint fern", "rose lily"]);
  });

  it("honours a limit by cutting the tail first", () => {
    expect(take(["rose lily aa", "rose lily bb", "rose cc", "rose dd", "lily ee", "lily ff"], 2)).toEqual(["lily", "rose"]);
  });

  it("ranks ties by how many titles carry the tag, then alphabetically, up to the limit", () => {
    const tags = mineTags([
      "zoe aa", "zoe bb", "zoe cc", "zoe dd",
      "ann ee", "ann ff", "ann gg",
      "ben hh", "ben ii", "ben jj",
      "zebra", "yak", "xylo", "willow", "violet", "umber"
    ]);
    expect(tags.map(tag => tag.key)).toEqual(["zoe", "ann", "ben"]);
    expect(take(["zoe pp", "zoe qq", "zoe rr", "ann ss", "ann tt", "ann uu", "zebra", "yak", "xylo"], 1)).toEqual(["ann"]);
  });

  it("folds accents so spelling variants are one subject", () => {
    const tags = mineTags(["Café day", "cafe night", "CAFÉ noon", "zebra", "yak", "xylo", "willow", "violet"]);
    expect(tags.map(tag => tag.key)).toEqual(["cafe"]);
    expect(tags[0]).toEqual({key: "cafe", label: "Café", count: 3});
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

  it("matches across plural endings, attached numbers, camelCase and accents", () => {
    expect(titleHasTag("Three beaches at dawn", "beach")).toBe(true);
    expect(titleHasTag("the beach at dawn", "beaches")).toBe(true);
    expect(titleHasTag("two cities by night", "city")).toBe(true);
    expect(titleHasTag("Mia2 returns", "mia")).toBe(true);
    expect(titleHasTag("AliceBeach day", "alice beach")).toBe(true);
    expect(titleHasTag("CAFÉ at night", "cafe")).toBe(true);
    expect(titleHasTag("beaten path", "beach")).toBe(false);
    expect(titleHasTag("os map", "ox")).toBe(false);
  });
});
