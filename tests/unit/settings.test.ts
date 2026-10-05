import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {
  DEFAULT_SETTINGS, DEFAULT_SHORTCUTS, SCAN_SETTING_KEYS, SETTINGS_VERSION, SETTING_CHOICES, SETTING_RANGES, effectiveSettings,
  linkMatchesKeywords, loadSettings, normalizeKeywords, resolveSettings, sanitizeOverrides, sanitizeValue, saveSettings,
  settingsOverrides, siteProfileFor
} from "../../src/shared/settings";

describe("default settings", () => {
  it("are touchpad-first, adaptive and conservative about recursion", () => {
    expect(DEFAULT_SETTINGS.activationMode).toBe("hover");
    expect(DEFAULT_SETTINGS.performanceMode).toBe("auto");
    expect(DEFAULT_SETTINGS.recursiveSearch).toBe("same-origin");
    expect(DEFAULT_SETTINGS.recursiveTrigger).toBe("empty");
    expect(DEFAULT_SETTINGS.ignoreScrollHover).toBe(true);
    expect(DEFAULT_SETTINGS.shortcuts.nextLink).toEqual(["n"]);
    expect(DEFAULT_SETTINGS.shortcuts.previousLink).toEqual(["Shift+n"]);
  });

  it("give every enumerated default an allowed value and every numeric default a range", () => {
    for (const [key, choices] of Object.entries(SETTING_CHOICES)) expect(choices).toContain(DEFAULT_SETTINGS[key as keyof typeof DEFAULT_SETTINGS]);
    for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
      if (typeof value !== "number") continue;
      const range = SETTING_RANGES[key as keyof typeof DEFAULT_SETTINGS];
      expect(range, key).toBeDefined();
      expect(value).toBeGreaterThanOrEqual(range!.min);
      expect(value).toBeLessThanOrEqual(range!.max);
    }
  });

  it("key cached scans only on settings that exist", () => {
    for (const key of SCAN_SETTING_KEYS) expect(key in DEFAULT_SETTINGS).toBe(true);
  });
});

describe("sanitizing stored values", () => {
  it("keeps valid values, clamps numbers and rejects wrong types", () => {
    expect(sanitizeValue("enabled", false)).toBe(false);
    expect(sanitizeValue("enabled", "no")).toBeUndefined();
    expect(sanitizeValue("hoverDelay", 99999)).toBe(2000);
    expect(sanitizeValue("hoverDelay", -5)).toBe(0);
    expect(sanitizeValue("hoverDelay", Number.NaN)).toBeUndefined();
    expect(sanitizeValue("hoverDelay", "300")).toBeUndefined();
    expect(sanitizeValue("activationMode", "click")).toBe("click");
    expect(sanitizeValue("activationMode", "telepathy")).toBeUndefined();
    expect(sanitizeValue("activationMode", 3)).toBeUndefined();
    const defaults = DEFAULT_SETTINGS as unknown as Record<string, unknown>;
    defaults.futureNumber = 5;
    expect(sanitizeValue("futureNumber" as keyof typeof DEFAULT_SETTINGS, 7)).toBe(7);
    defaults.futureText = "x";
    expect(sanitizeValue("futureText" as keyof typeof DEFAULT_SETTINGS, "x")).toBeUndefined();
    delete defaults.futureNumber;
    delete defaults.futureText;
    expect(sanitizeValue("unknown" as keyof typeof DEFAULT_SETTINGS, "x")).toBeUndefined();
  });

  it("normalizes keywords, shortcuts and site profiles", () => {
    expect(normalizeKeywords([" Gallery ", "gallery", "", "photos"])).toEqual(["Gallery", "photos"]);
    expect(normalizeKeywords("gallery")).toBeUndefined();
    expect(normalizeKeywords(Array.from({length: 60}, (_, i) => `k${i}`))).toHaveLength(50);
    expect(sanitizeValue("shortcuts", {grid: ["G", "g", "Shift+X", "", "Shift"], unknown: ["x"], next: "nope"})).toEqual({grid: ["g", "Shift+x"]});
    expect(sanitizeValue("shortcuts", {help: ["a", "b", "c", "d", "e"]})).toEqual({help: ["a", "b", "c", "d"]});
    expect(sanitizeValue("shortcuts", [])).toBeUndefined();
    expect(sanitizeValue("siteProfiles", {" Forum.Example ": {hoverDelay: 50, siteProfiles: {}, onboardingComplete: true, bogus: 1}, "": {}, "x.test": "bad"}))
      .toEqual({"forum.example": {hoverDelay: 50}});
    expect(sanitizeValue("siteProfiles", null)).toBeUndefined();
  });

  it("drops unknown keys and invalid values from overrides", () => {
    expect(sanitizeOverrides({hoverDelay: 120, prefetch: "everything", networkMode: "data", enabled: true})).toEqual({hoverDelay: 120, enabled: true});
  });
});

describe("resolving and storing settings", () => {
  it("fills defaults around overrides and merges shortcut actions", () => {
    const resolved = resolveSettings({hoverDelay: 120, shortcuts: {grid: ["x"]}});
    expect(resolved.hoverDelay).toBe(120);
    expect(resolved.shortcuts.grid).toEqual(["x"]);
    expect(resolved.shortcuts.next).toEqual(DEFAULT_SHORTCUTS.next);
    expect(resolveSettings("garbage")).toEqual(DEFAULT_SETTINGS);
    expect(resolveSettings(undefined).siteProfiles).toEqual({});
  });

  it("stores only the values that differ from defaults", () => {
    const settings = resolveSettings({hoverDelay: 120, shortcuts: {grid: ["x"]}, siteProfiles: {"a.test": {enabled: false}}});
    expect(settingsOverrides(settings)).toEqual({hoverDelay: 120, shortcuts: {grid: ["x"]}, siteProfiles: {"a.test": {enabled: false}}});
    expect(settingsOverrides(DEFAULT_SETTINGS)).toEqual({});
  });

  describe("with extension storage", () => {
    let store: Record<string, unknown>;
    beforeEach(() => {
      store = {};
      vi.stubGlobal("chrome", {storage: {local: {
        get: vi.fn(async (keys: string[]) => Object.fromEntries(keys.map(key => [key, store[key]]))),
        set: vi.fn(async (values: Record<string, unknown>) => Object.assign(store, values))
      }}});
    });
    afterEach(() => vi.unstubAllGlobals());

    it("reads current-version overrides without rewriting them", async () => {
      store = {settings: {hoverDelay: 90}, settingsVersion: SETTINGS_VERSION};
      expect((await loadSettings()).hoverDelay).toBe(90);
      expect(chrome.storage.local.set).not.toHaveBeenCalled();
    });

    it("migrates version 1 settings once and stores the sparse result", async () => {
      store = {settings: {hoverDelay: 450, closeDelay: 180, panelSize: "medium", networkMode: "data", loopMode: "stop"}};
      const loaded = await loadSettings();
      expect(loaded.hoverDelay).toBe(450);
      expect(loaded.performanceMode).toBe("saver");
      expect(loaded.wrapAround).toBe(false);
      expect(store.settingsVersion).toBe(SETTINGS_VERSION);
      expect(store.settings).toEqual({hoverDelay: 450, performanceMode: "saver", wrapAround: false});
    });

    it("treats missing or malformed stored settings as a fresh install", async () => {
      store = {settings: "corrupt"};
      expect(await loadSettings()).toEqual(DEFAULT_SETTINGS);
      expect(store.settings).toEqual({});
    });

    it("saves sparse overrides with the schema version", async () => {
      await saveSettings(resolveSettings({blur: 4}));
      expect(store).toEqual({settings: {blur: 4}, settingsVersion: SETTINGS_VERSION});
    });
  });
});

describe("site profiles", () => {
  const profiles = {"a.test": {hoverDelay: 1}, "*.b.test": {hoverDelay: 2}, "*.deep.b.test": {hoverDelay: 3}, "*.c.test": {enabled: false}};

  it("match exact hosts first, then the most specific wildcard, including the bare domain", () => {
    expect(siteProfileFor(profiles, "A.TEST")).toEqual({hoverDelay: 1});
    expect(siteProfileFor(profiles, "x.b.test")).toEqual({hoverDelay: 2});
    expect(siteProfileFor(profiles, "x.deep.b.test")).toEqual({hoverDelay: 3});
    expect(siteProfileFor(profiles, "b.test")).toEqual({hoverDelay: 2});
    expect(siteProfileFor(profiles, "notb.test")).toBeUndefined();
    expect(siteProfileFor(profiles, "elsewhere.test")).toBeUndefined();
  });

  it("apply on top of the global settings without replacing shortcuts or the profile list", () => {
    const settings = resolveSettings({siteProfiles: profiles});
    expect(effectiveSettings(settings, "https://x.c.test/page").enabled).toBe(false);
    expect(effectiveSettings(settings, "https://a.test/").shortcuts).toBe(settings.shortcuts);
    expect(effectiveSettings(settings, "https://none.test/")).toBe(settings);
    expect(effectiveSettings(settings, "not a url")).toBe(settings);
  });
});

describe("activation keywords", () => {
  it("allow every link when empty and otherwise match decoded URLs case-insensitively", () => {
    expect(linkMatchesKeywords({activationKeywords: []}, "https://x.test/a")).toBe(true);
    expect(linkMatchesKeywords({activationKeywords: [" ", "Gallery"]}, "https://x.test/My%20GALLERY")).toBe(true);
    expect(linkMatchesKeywords({activationKeywords: ["photos"]}, "https://x.test/a")).toBe(false);
    expect(linkMatchesKeywords({activationKeywords: ["%zz"]}, "https://x.test/%zz")).toBe(true);
  });
});
