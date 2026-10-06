/**
 * Tags mined from media titles.
 *
 * Recurring phrases across distinct titles become tags: each distinct title is
 * broken into words (stop words and bare numbers dropped) and every run of one
 * to three words is counted once per title. A phrase becomes a tag when it
 * appears in at least three titles but not in most of them — what nearly every
 * title shares is boilerplate (the site's own name), not a subject. A longer
 * phrase absorbs the shorter ones inside it when it keeps most of their count:
 * "Alice Beach" stands alone when "beach" hardly occurs without "alice".
 */

export interface TitleTag {
  /** The phrase as it was first seen, for display. */
  label: string;
  /** The normalised phrase, matched against titles. */
  key: string;
  /** How many distinct titles carry it. */
  count: number;
}

const MIN_TITLES = 3;
/** A phrase in more than this share of titles is boilerplate, not a subject. */
const UBIQUITY = 0.6;
/** A longer phrase absorbs a shorter one inside it when it keeps this share of its count. */
const ABSORB = 0.8;
const MAX_WORDS = 3;

const STOP = new Set(("a an the and or of in on for with to at by from is are was it its as this that be not my your our " +
  "thread topic forum gallery album collection set sets pic pics picture pictures photo photos video videos gif gifs " +
  "image images media file files page post posts new old update updated part vol volume official original full").split(" "));

type Word = {raw: string; low: string};

/** A title's meaningful words, in order, keeping the original spelling beside the lowercased form. */
function words(title: string): Word[] {
  const out: Word[] = [];
  for (const raw of title.normalize("NFKC").match(/[\p{L}\p{N}]+/gu) ?? []) {
    const low = raw.toLowerCase();
    if (low.length >= 2 && !/^\d+$/.test(low) && !STOP.has(low)) out.push({raw, low});
  }
  return out;
}

/** Whether the title contains the tag's words in a row. */
export function titleHasTag(title: string, key: string) {
  const have = words(title).map(word => word.low), wanted = key.split(" ");
  outer: for (let start = 0; start + wanted.length <= have.length; start++) {
    for (let at = 0; at < wanted.length; at++) {
      if (have[start + at] !== wanted[at]) continue outer;
    }
    return true;
  }
  return false;
}

/** The tags worth offering for these titles, strongest first. */
export function mineTags(titles: readonly string[], limit = 16): TitleTag[] {
  const distinct = [...new Set(titles.map(title => title.trim()).filter(Boolean))];
  const docs = distinct.map(words).filter(doc => doc.length > 0);
  if (docs.length < MIN_TITLES) return [];
  const counts = new Map<string, number>(), labels = new Map<string, string>();
  for (const doc of docs) {
    const seen = new Set<string>();
    for (let length = 1; length <= MAX_WORDS; length++) {
      for (let start = 0; start + length <= doc.length; start++) {
        const slice = doc.slice(start, start + length);
        const key = slice.map(word => word.low).join(" ");
        if (seen.has(key)) continue;
        seen.add(key);
        counts.set(key, (counts.get(key) ?? 0) + 1);
        if (!labels.has(key)) labels.set(key, slice.map(word => word.raw).join(" "));
      }
    }
  }
  const ceiling = Math.max(MIN_TITLES, Math.ceil(docs.length * UBIQUITY));
  const candidates = [...counts].filter(([, count]) => count >= MIN_TITLES && count <= ceiling);
  // The longer phrase wins where it carries most of a shorter one's occurrences.
  const absorbed = new Set<string>();
  for (const [key, count] of candidates) {
    const parts = key.split(" ");
    if (parts.length === 1) continue;
    for (let length = 1; length < parts.length; length++) {
      for (let start = 0; start + length <= parts.length; start++) {
        // Every run inside a counted phrase was counted in the same titles, so the inner count always exists.
        const inner = parts.slice(start, start + length).join(" ");
        if (count >= ABSORB * counts.get(inner)!) absorbed.add(inner);
      }
    }
  }
  return candidates.filter(([key]) => !absorbed.has(key))
    .map(([key, count]) => ({key, count, label: labels.get(key)!}))
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key))
    .slice(0, limit);
}
