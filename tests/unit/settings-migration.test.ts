import {describe, expect, it} from "vitest";
import {migrateLegacySettings} from "../../src/shared/settings-migration";

/** A version 1 install that never changed anything: every value equals the version 1 default. */
const untouchedV1 = {
  enabled: true, activationMode: "hover", activationKeywords: [], hoverDelay: 300, closeDelay: 180, intentDetection: true,
  panelSize: "medium", panelWidth: 480, defaultView: "focus", navAxis: "vertical", loopMode: "wrap", verticalGesture: "navigate",
  horizontalGesture: "scrub", prefetch: "nearby", maxRequests: 2, networkMode: "adaptive", maxCacheMb: 64, preloadMemoryMb: 64,
  preloadOriginals: "never", gifAutoplay: "focus", motion: "full", scanScope: "whole", preset: "balanced", siteProfiles: {},
  shortcuts: {next: ["ArrowDown", "ArrowRight"], previous: ["ArrowUp", "ArrowLeft"], nextLink: ["n"], close: ["Escape"], pin: ["p"], grid: ["g"], focus: ["f"], favorite: ["b"], open: ["o"], help: ["?", "/"], zoomIn: ["+", "="], zoomOut: ["-"], resetZoom: ["0"], download: ["d"]}
};

describe("migrating version 1 settings", () => {
  it("drops untouched defaults and settings that no longer exist", () => {
    expect(migrateLegacySettings(untouchedV1)).toEqual({});
  });

  it("keeps deliberate choices", () => {
    expect(migrateLegacySettings({...untouchedV1, hoverDelay: 120, includeSvg: true, siteProfiles: {"a.test": {enabled: false}}}))
      .toEqual({hoverDelay: 120, includeSvg: true, siteProfiles: {"a.test": {enabled: false}}});
  });

  it("drops values written by older releases and by the selected preset's performance limits", () => {
    expect(migrateLegacySettings({...untouchedV1, maxRequests: 3, maxCacheMb: 250, preloadMemoryMb: 192})).toEqual({});
    expect(migrateLegacySettings({...untouchedV1, preset: "fast", prefetch: "visible", maxRequests: 4, preloadMemoryMb: 128, maxMediaItems: 800, recursiveMaxDepth: 2, recursiveMaxPages: 12, hoverDelay: 120}))
      .toEqual({performanceMode: "fast", hoverDelay: 120});
    expect(migrateLegacySettings({...untouchedV1, preset: "minimal", prefetch: "off", maxRequests: 1, preloadMemoryMb: 32, maxMediaItems: 100, recursiveMaxPages: 3, recursiveSearch: "off"}))
      .toEqual({performanceMode: "saver", recursiveSearch: "off"});
    expect(migrateLegacySettings({...untouchedV1, preset: "custom", maxRequests: 1})).toEqual({maxRequests: 1});
  });

  it("maps renamed and merged settings", () => {
    expect(migrateLegacySettings({networkMode: "aggressive"})).toEqual({performanceMode: "fast"});
    expect(migrateLegacySettings({networkMode: "data"})).toEqual({performanceMode: "saver"});
    expect(migrateLegacySettings({loopMode: "resist"})).toEqual({wrapAround: false});
    expect(migrateLegacySettings({loopMode: "stop"})).toEqual({wrapAround: false});
    for (const mode of ["pan", "scroll", "disabled"]) expect(migrateLegacySettings({verticalGesture: mode})).toEqual({verticalGesture: "off"});
    expect(migrateLegacySettings({horizontalGesture: "navigate"})).toEqual({horizontalGesture: "navigate"});
    expect(migrateLegacySettings({horizontalGesture: "disabled"})).toEqual({horizontalGesture: "off"});
    expect(migrateLegacySettings({defaultView: "masonry"})).toEqual({defaultView: "grid"});
    expect(migrateLegacySettings({defaultView: "grid"})).toEqual({defaultView: "grid"});
    expect(migrateLegacySettings({defaultView: "filmstrip"})).toEqual({});
    expect(migrateLegacySettings({prefetch: "all"})).toEqual({prefetch: "visible"});
    expect(migrateLegacySettings({scanScope: "nearby"})).toEqual({});
    expect(migrateLegacySettings({scanScope: "first"})).toEqual({scanScope: "first"});
    expect(migrateLegacySettings({scanScope: "page"})).toEqual({scanScope: "page"});
    expect(migrateLegacySettings({gifAutoplay: "never"})).toEqual({gifAutoplay: false});
    for (const policy of ["next", "three", "aggressive"]) expect(migrateLegacySettings({preloadOriginals: policy})).toEqual({preloadOriginals: "next"});
    expect(migrateLegacySettings({motion: "none"})).toEqual({reducedMotion: true});
    expect(migrateLegacySettings({motion: "reduced"})).toEqual({reducedMotion: true});
  });

  it("keeps only shortcut actions that were changed and still exist", () => {
    expect(migrateLegacySettings({shortcuts: {...untouchedV1.shortcuts, grid: ["x"], focus: ["q"]}})).toEqual({shortcuts: {grid: ["x"]}});
    expect(migrateLegacySettings({shortcuts: "broken"})).toEqual({});
    expect(migrateLegacySettings({shortcuts: null})).toEqual({});
  });
});
