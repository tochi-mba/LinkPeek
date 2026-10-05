import {describe, expect, it} from "vitest";
import {ByteCache} from "../../src/background/byte-cache";

describe("byte-bounded cache", () => {
  it("evicts least recently used entries to stay within the budget", () => {
    const cache = new ByteCache<string>();
    cache.set("a", "A", 4, 10);
    cache.set("b", "B", 4, 10);
    expect(cache.get("a")).toBe("A");
    cache.set("c", "C", 4, 10);
    expect([cache.get("a"), cache.get("b"), cache.get("c")]).toEqual(["A", undefined, "C"]);
    expect(cache.bytes).toBe(8);
    expect(cache.size).toBe(2);
  });

  it("replaces existing keys, refuses oversized values and clears", () => {
    const cache = new ByteCache<number>();
    cache.set("a", 1, 3, 10);
    cache.set("a", 2, 5, 10);
    expect(cache.bytes).toBe(5);
    expect(cache.set("big", 9, 11, 10)).toBe(false);
    expect(cache.get("big")).toBeUndefined();
    cache.delete("missing");
    cache.clear();
    expect([cache.size, cache.bytes, cache.get("a")]).toEqual([0, 0, undefined]);
  });
});
