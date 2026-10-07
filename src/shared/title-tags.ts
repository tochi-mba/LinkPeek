/**
 * Tags mined from media titles.
 *
 * The pipeline, each stage with its reason:
 *
 * 1. Titles are deduplicated, and split on strong separators (" - ", "|", "–");
 *    a segment repeated across many titles is a site's boilerplate suffix, not
 *    a subject, and is cut before anything is counted.
 * 2. Words are normalised hard, so one subject is never split over spellings:
 *    camelCase splits ("AliceBeach"), accents fold ("Café" = "cafe"), stop
 *    words, bare numbers and media noise ("1080p", "4k", "s01e02") drop, and a
 *    trailing digit or plural s folds into its base when the base also occurs.
 * 3. Every run of one to three words is counted once per distinct title. A
 *    phrase is a candidate when at least two titles carry it but not most of
 *    them (a second net for boilerplate), and a longer phrase absorbs the
 *    shorter ones inside it when it keeps most of their count: "Alice Beach"
 *    stands alone when "beach" hardly occurs without it.
 * 4. The offered tags are picked for variety, not sheer frequency: each pick
 *    halves the weight of the titles it covers, so the next pick must speak
 *    for titles the earlier ones do not. One prolific subject takes one chip
 *    (its strong sub-themes may earn their own later) while smaller subjects
 *    still get theirs; picking stops when nothing left covers fresh ground.
 */

export interface TitleTag {
  /** The phrase as it was first seen, for display. */
  label: string;
  /** The normalised phrase, matched against titles. */
  key: string;
  /** How many distinct titles carry it. */
  count: number;
}

/** A phrase must appear in this many distinct titles to be a candidate. */
const MIN_COUNT = 2;
/** A segment repeated across this share of titles is a site's boilerplate. */
const SEGMENT_SHARE = 0.3;
/** A phrase in more than this share of titles is boilerplate, not a subject. */
const UBIQUITY = 0.6;
/** A longer phrase absorbs a shorter one inside it when it keeps this share of its count. */
const ABSORB = 0.8;
/** Each pick multiplies the weight of the titles it covers by this. */
const DIVERSITY = 0.5;
const MAX_WORDS = 3;

const STOP = new Set(("a an the and or of in on for with to at by from is are was it its as this that be not my your our " +
  "thread topic forum gallery album collection set sets pic pics picture pictures photo photos video videos gif gifs " +
  "image images media file files page post posts new old update updated part vol volume official original full").split(" "));
/** Resolution, quality and episode markers common in media titles. */
const NOISE = /^(?:\d+[kpx]|u?hd|fhd|sd|s\d+e\d+|ep\d+|pt\d+|(?:v|vol)\d+)$/;
/** Spaced hyphens and the usual title separators; a hyphen inside a name stays. */
const SEPARATORS = /\s+-+\s+|\s*(?:\||–|—|»|·|•|::)\s*/gu;
/** A lower-case letter or digit running into an upper-case letter. */
const CAMEL = /([\p{Ll}\p{N}])(\p{Lu})/gu;

type Word = {raw: string; low: string};
type Candidate = {key: string; label: string; count: number; docs: number[]};

/** Accent-free lower case, so "Café" and "cafe" are one word. */
function foldCase(raw: string) {
  return raw.normalize("NFKD").replace(/\p{M}+/gu, "").toLowerCase();
}

/** A title's meaningful words, in order, keeping the original spelling beside the normalised form. */
function words(title: string): Word[] {
  const out: Word[] = [];
  for (const raw of title.normalize("NFKC").replace(CAMEL, "$1 $2").match(/[\p{L}\p{N}]+/gu) ?? []) {
    const low = foldCase(raw);
    if (low.length >= 2 && !/^\d+$/.test(low) && !STOP.has(low) && !NOISE.test(low)) out.push({raw, low});
  }
  return out;
}

/** The spellings a plural might shorten to: "beaches" offers "beache" and "beach", "cities" offers "city". */
function singulars(word: string) {
  const out = [word];
  if (word.endsWith("s") && word.length > 2) out.push(word.slice(0, -1));
  if (word.endsWith("es") && word.length > 3) out.push(word.slice(0, -2));
  if (word.endsWith("ies") && word.length > 4) out.push(`${word.slice(0, -3)}y`);
  return out;
}

/** The spellings a word stands for: itself, its singulars, and the same for its digit-free base. */
function variants(word: string) {
  const out = new Set(singulars(word));
  const bare = word.replace(/\d+$/, "");
  if (bare !== word) {
    for (const form of singulars(bare)) out.add(form);
  }
  return out;
}

/**
 * The same word across a plural ending or an attached number: "beach" finds
 * "beaches" and "mia" finds "mia2" — but only variant-to-base, so "mia2" and
 * "mia3" stay two different things.
 */
function sameWord(a: string, b: string) {
  return a === b || variants(a).has(b) || variants(b).has(a);
}

/** Whether the title contains the tag's words in a row. */
export function titleHasTag(title: string, key: string) {
  const have = words(title).map(word => word.low), wanted = key.split(" ");
  outer: for (let start = 0; start + wanted.length <= have.length; start++) {
    for (let at = 0; at < wanted.length; at++) {
      if (!sameWord(have[start + at], wanted[at])) continue outer;
    }
    return true;
  }
  return false;
}

/** Cuts the segments that repeat across many titles: "… – Candid Forum" loses its suffix everywhere. */
function withoutBoilerplate(titles: readonly string[]): string[] {
  const segments = titles.map(title => title.split(SEPARATORS).map(part => part.trim()).filter(Boolean));
  const counts = new Map<string, number>();
  for (const parts of segments) {
    for (const part of new Set(parts.map(foldCase))) counts.set(part, (counts.get(part) ?? 0) + 1);
  }
  const ceiling = Math.max(3, Math.ceil(titles.length * SEGMENT_SHARE));
  return segments.map((parts, at) => parts.filter(part => counts.get(foldCase(part))! < ceiling).join(" ") || titles[at]);
}

/** Calls `take` once per distinct run of one to three words in the title. */
function eachPhrase(doc: readonly string[], take: (key: string, start: number, length: number) => void) {
  const seen = new Set<string>();
  for (let length = 1; length <= MAX_WORDS; length++) {
    for (let start = 0; start + length <= doc.length; start++) {
      const key = doc.slice(start, start + length).join(" ");
      if (seen.has(key)) continue;
      seen.add(key);
      take(key, start, length);
    }
  }
}

/**
 * Every tag these titles earn: the most distinctive mix first (picked for
 * coverage), then the long tail ordered by how many titles carry it. Nothing
 * that survived the filters is withheld — the caller decides how many to show.
 */
export function mineTags(titles: readonly string[], limit = Infinity): TitleTag[] {
  const distinct = [...new Set(titles.map(title => title.trim()).filter(Boolean))];
  const raw = withoutBoilerplate(distinct).map(words).filter(doc => doc.length > 0);
  if (raw.length < 3) return [];
  // A trailing number or plural folds into its base when the base also occurs, so one subject is not split over variants.
  const vocabulary = new Set(raw.flatMap(doc => doc.map(word => word.low)));
  const fold = (low: string) => {
    const bare = low.replace(/\d+$/, "");
    const base = bare !== low && bare.length >= 2 && vocabulary.has(bare) ? bare : low;
    for (const candidate of singulars(base)) {
      if (candidate !== base && vocabulary.has(candidate)) return candidate;
    }
    return base;
  };
  const docs = raw.map(doc => doc.map(word => fold(word.low)));
  const counts = new Map<string, number>(), labels = new Map<string, string>();
  docs.forEach((doc, at) => eachPhrase(doc, (key, start, length) => {
    counts.set(key, (counts.get(key) ?? 0) + 1);
    if (!labels.has(key)) labels.set(key, raw[at].slice(start, start + length).map(word => word.raw).join(" "));
  }));
  const ceiling = Math.max(3, Math.ceil(docs.length * UBIQUITY));
  const eligible = new Map([...counts].filter(([, count]) => count >= MIN_COUNT && count <= ceiling));
  // The longer phrase wins where it carries most of a shorter one's occurrences.
  for (const [key, count] of eligible) {
    const parts = key.split(" ");
    if (parts.length === 1) continue;
    for (let length = 1; length < parts.length; length++) {
      for (let start = 0; start + length <= parts.length; start++) {
        // Every run inside a counted phrase was counted in the same titles, so the inner count always exists.
        const inner = parts.slice(start, start + length).join(" ");
        if (count >= ABSORB * counts.get(inner)!) eligible.delete(inner);
      }
    }
  }
  // Each candidate learns which titles carry it, so picking can chase uncovered ground.
  const pool = new Map<string, Candidate>();
  for (const [key, count] of eligible) pool.set(key, {key, count, label: labels.get(key)!, docs: []});
  docs.forEach((doc, at) => eachPhrase(doc, key => pool.get(key)?.docs.push(at)));
  const candidates = [...pool.values()];
  const picked = pickDiverse([...candidates], docs.length, limit);
  if (picked.length >= limit) return picked;
  // The rest still name something real; they follow the picks, the commoner first.
  const have = new Set(picked.map(tag => tag.key));
  const tail = candidates.filter(candidate => !have.has(candidate.key))
    .sort((a, b) => b.count - a.count || b.key.split(" ").length - a.key.split(" ").length || (a.key < b.key ? -1 : 1))
    .map(({key, label, count}) => ({key, label, count}));
  return [...picked, ...tail].slice(0, limit);
}

/**
 * Greedy coverage: the phrase speaking for the most still-uncovered titles
 * goes next, and every pick halves the weight of the titles it covers. Ties
 * go to the higher count, then the fuller phrase, then alphabetically.
 *
 * Scores only ever fall as titles get covered, so this is the lazy form: a
 * candidate's last score is an upper bound, and it is only re-scored when it
 * reaches the top of the heap. The picks are exactly the eager algorithm's,
 * at a fraction of the work on large collections.
 */
function pickDiverse(pool: Candidate[], titleCount: number, limit: number): TitleTag[] {
  const weights = new Array<number>(titleCount).fill(1);
  const score = (candidate: Candidate) => candidate.docs.reduce((sum, doc) => sum + weights[doc], 0);
  const heap = new Heap<{candidate: Candidate; bound: number}>((a, b) => a.bound > b.bound || (a.bound === b.bound && prefer(a.candidate, b.candidate)));
  for (const candidate of pool) heap.push({candidate, bound: candidate.docs.length});
  const picked: TitleTag[] = [];
  while (picked.length < limit && heap.size) {
    const top = heap.pop()!;
    top.bound = score(top.candidate);
    const next = heap.peek();
    // Someone else may now be ahead: put this one back with its true score and look again.
    if (next && (next.bound > top.bound || (next.bound === top.bound && prefer(next.candidate, top.candidate)))) {
      heap.push(top);
      continue;
    }
    // What is left barely covers anything the picked tags do not.
    if (top.bound < 1) break;
    for (const doc of top.candidate.docs) weights[doc] *= DIVERSITY;
    picked.push({key: top.candidate.key, label: top.candidate.label, count: top.candidate.count});
  }
  return picked;
}

/** A small binary heap; `before(a, b)` says a comes out first. */
class Heap<T> {
  private items: T[] = [];

  constructor(private before: (a: T, b: T) => boolean) {}

  get size() {
    return this.items.length;
  }

  peek(): T | undefined {
    return this.items[0];
  }

  push(item: T) {
    const items = this.items;
    items.push(item);
    for (let at = items.length - 1; at > 0;) {
      const parent = (at - 1) >> 1;
      if (!this.before(items[at], items[parent])) break;
      [items[at], items[parent]] = [items[parent], items[at]];
      at = parent;
    }
  }

  pop(): T | undefined {
    const items = this.items, top = items[0], last = items.pop();
    if (!items.length) return top;
    items[0] = last!;
    let at = 0;
    while (true) {
      const left = at * 2 + 1, right = left + 1;
      let best = at;
      if (left < items.length && this.before(items[left], items[best])) best = left;
      if (right < items.length && this.before(items[right], items[best])) best = right;
      if (best === at) break;
      [items[at], items[best]] = [items[best], items[at]];
      at = best;
    }
    return top;
  }
}

function prefer(a: Candidate, b: Candidate) {
  if (a.count !== b.count) return a.count > b.count;
  const [aw, bw] = [a.key.split(" ").length, b.key.split(" ").length];
  return aw !== bw ? aw > bw : a.key < b.key;
}
