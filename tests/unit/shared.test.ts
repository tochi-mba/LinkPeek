import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {escapeHtml, linkText, policyAllows} from "../../src/shared/dom";
import {favoriteKey, isFavorite, loadFavorites, removeFavorite, toggleFavorite} from "../../src/shared/favorites";
import {REX, rexCss} from "../../src/shared/theme";

describe("saved links", () => {
  let store: Record<string, unknown>;
  beforeEach(() => {
    store = {};
    vi.stubGlobal("chrome", {storage: {local: {
      get: vi.fn(async (key: string) => ({[key]: store[key]})),
      set: vi.fn(async (values: Record<string, unknown>) => Object.assign(store, values))
    }}});
  });
  afterEach(() => vi.unstubAllGlobals());

  it("are keyed without fragments or tracking", () => {
    expect(favoriteKey("https://x.test/t/1?utm_source=a&page=2#post")).toBe("https://x.test/t/1?page=2");
  });

  it("load newest first, repairing and deduplicating whatever was stored", async () => {
    store.favorites = [
      {url: "https://x.test/a", title: " A ", addedAt: 1, mediaCount: 3},
      {url: "https://x.test/b#x", title: "", addedAt: "5"},
      {url: "https://x.test/c", title: "C"},
      {url: "https://x.test/a?utm_medium=z", title: "dup", addedAt: 9},
      {url: "http://[bad"}, {url: 42}, null
    ];
    expect(await loadFavorites()).toEqual([
      {url: "https://x.test/b", title: "https://x.test/b", addedAt: 5, mediaCount: undefined},
      {url: "https://x.test/a", title: "A", addedAt: 1, mediaCount: 3}
      ,{url: "https://x.test/c", title: "C", addedAt: 0, mediaCount: undefined}
    ]);
    store.favorites = "corrupt";
    expect(await loadFavorites()).toEqual([]);
  });

  it("toggle on and off, and remove", async () => {
    vi.spyOn(Date, "now").mockReturnValue(100);
    expect(await toggleFavorite({url: "https://x.test/t", title: " Thread ", mediaCount: 2})).toEqual({saved: true, favorite: {url: "https://x.test/t", title: "Thread", addedAt: 100, mediaCount: 2}});
    expect(await isFavorite("https://x.test/t#again")).toBe(true);
    expect(await toggleFavorite({url: "https://x.test/t"})).toEqual({saved: false});
    await toggleFavorite({url: "https://x.test/u"});
    expect((await loadFavorites())[0].title).toBe("https://x.test/u");
    await removeFavorite("https://x.test/u");
    expect(await isFavorite("https://x.test/u")).toBe(false);
  });
});

describe("helpers", () => {
  it("escape HTML for text and attributes", () => {
    expect(escapeHtml(`<a href="x">Tom & Jerry's</a>`)).toBe("&lt;a href=&quot;x&quot;&gt;Tom &amp; Jerry&#39;s&lt;/a&gt;");
  });

  it("ask the page's permissions policy before using a feature it can switch off", () => {
    const page = (policy: object) => Object.assign(document.implementation.createHTMLDocument(""), policy);
    const allowed = new Set(["fullscreen"]);
    const policy = {allowsFeature: (feature: string) => allowed.has(feature), features: () => ["fullscreen", "compute-pressure"]};
    expect(policyAllows("fullscreen", page({featurePolicy: policy}))).toBe(true);
    expect(policyAllows("compute-pressure", page({featurePolicy: policy}))).toBe(false);
    // A feature the browser's policy does not know about is not restricted by it.
    expect(policyAllows("battery", page({featurePolicy: policy}))).toBe(true);
    // The newer name wins, and a policy that cannot list its features is taken at its word.
    expect(policyAllows("battery", page({permissionsPolicy: {allowsFeature: () => false}, featurePolicy: policy}))).toBe(false);
    expect(policyAllows("fullscreen", page({}))).toBe(true);
    expect(policyAllows("fullscreen")).toBe(true);
  });

  it("read the words a page shows for a link, including its pictures' descriptions", () => {
    const anchor = document.createElement("a");
    anchor.innerHTML = `  Alice <b>beach</b>\n day <img alt="Sunset at the pier" title="Pier"><img>`;
    anchor.title = "Thread title";
    anchor.setAttribute("aria-label", "Open thread");
    expect(linkText(anchor)).toBe("Alice beach day Thread title Open thread Sunset at the pier Pier");
    expect(linkText(document.createElement("a"))).toBe("");
  });

  it("expose the REX palette and isolate the shadow root", () => {
    expect(REX.signal).toBe("#D7FF3F");
    expect(rexCss).toContain("all: initial");
  });
});

describe("the content script entry", () => {
  it("boots one preview controller", async () => {
    const boot = vi.fn(async () => undefined);
    vi.doMock("../../src/content/controller", () => ({PreviewController: class {
      boot = boot;
    }}));
    vi.resetModules();
    await import("../../src/content");
    expect(boot).toHaveBeenCalledTimes(1);
    vi.doUnmock("../../src/content/controller");
  });
});
