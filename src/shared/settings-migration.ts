/**
 * One-time migration from the version 1 settings format.
 *
 * Version 1 stored every setting, defaults included, so a stored value cannot
 * tell a deliberate choice from an untouched default. A value is kept only when
 * it differs from the version 1 default (and, for performance limits, from the
 * value the selected version 1 preset wrote). Everything else falls back to the
 * current defaults. Settings that no longer exist are dropped.
 */
import type {LinkPeekSettings} from "./settings";

type Legacy = Record<string, unknown>;

/** Version 1 defaults for settings that still exist. */
const V1_DEFAULTS: Legacy = {
  enabled: true, activationMode: "hover", activationKeywords: [], hoverDelay: 300, closeDelay: 180, cancelMovePx: 18,
  magneticBridge: true, magneticBridgeStrength: 0.7, panelWidth: 480, panelMaxVh: 70, focusHeightVh: 54,
  expandedWidthVw: 92, expandedHeightVh: 92, startExpanded: false, quickViewControls: true, draggablePanel: true,
  resizablePanel: true, rememberPanelGeometry: true, placement: "auto", pointerGap: 12, transparency: 0.08, blur: 16,
  pinchZoom: true, doubleClick: "zoom", navSensitivity: 0.55, gestureThreshold: 62, momentumFiltering: true,
  gestureCooldown: 140, fastSwipeAcceleration: true, maxImagesPerSwipe: 3, reverseVertical: false,
  reverseHorizontal: false, maxZoom: 8, pinchSensitivity: 1, doubleClickZoom: 2, secondDoubleClick: "fit",
  doubleClickDragPan: true, panWhenZoomed: true, panFriction: 0.85, resetZoomPerImage: true, includeImages: true,
  includeGif: true, includeWebp: true, includeAvif: true, includeSvg: false, includeAvatars: false, includeEmoji: false,
  minWidth: 200, minHeight: 160, quotedDuplicates: "hide", maxMediaItems: 400, recursiveSearch: "same-origin",
  recursiveTrigger: "empty", recursiveMaxDepth: 1, recursiveMaxPages: 6, scanScope: "whole", maxPosts: 2000,
  progressiveScan: true, continueAfterClose: "brief", prefetch: "nearby", maxRequests: 2, batchSize: 50,
  meteredOff: true, cacheMinutes: 60, maxCacheMb: 64, preloadMemoryMb: 64, preloadOriginals: "never", gifLoop: true,
  gifDefaultSpeed: 1, gifPauseWhenHidden: true, gifDecodeMaxMb: 32, gifControls: "always", thumbnailSize: 120,
  mouseWheel: "navigate", stripTracking: true, referrerPolicy: "same-origin", reducedMotion: false,
  fetchTimeout: 8000, followRedirects: true, canonicalizeQuery: true, mutationObserver: true,
  onboardingComplete: false, showLearningTips: true, siteProfiles: {}
};

/** Values an older release wrote by default before version 1 settled. */
const V1_LEGACY_VALUES: Legacy = {maxRequests: 3, maxCacheMb: 250, preloadMemoryMb: 192};

/** Performance limits each version 1 preset wrote; these follow the new mode instead. */
const V1_PRESET_LIMITS: Record<string, Legacy> = {
  balanced: {prefetch: "nearby", maxRequests: 2, maxMediaItems: 400, recursiveMaxDepth: 1, recursiveMaxPages: 6},
  minimal: {prefetch: "off", maxRequests: 1, preloadMemoryMb: 32, maxMediaItems: 100, recursiveMaxPages: 3},
  fast: {prefetch: "visible", maxRequests: 4, preloadMemoryMb: 128, maxMediaItems: 800, recursiveMaxDepth: 2, recursiveMaxPages: 12}
};

const V1_SHORTCUTS: Legacy = {
  next: ["ArrowDown", "ArrowRight"], previous: ["ArrowUp", "ArrowLeft"], nextLink: ["n"], close: ["Escape"],
  pin: ["p"], grid: ["g"], favorite: ["b"], open: ["o"], help: ["?", "/"], zoomIn: ["+", "="], zoomOut: ["-"],
  resetZoom: ["0"], download: ["d"]
};

function same(a: unknown, b: unknown) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function performanceMode(raw: Legacy): LinkPeekSettings["performanceMode"] | undefined {
  if (raw.networkMode === "data" || raw.preset === "minimal") return "saver";
  if (raw.networkMode === "aggressive" || raw.preset === "fast") return "fast";
  return undefined;
}

function changedShortcuts(raw: unknown) {
  if (!raw || typeof raw !== "object") return undefined;
  const out: Legacy = {};
  for (const [action, keys] of Object.entries(raw as Legacy)) {
    if (action in V1_SHORTCUTS && !same(keys, V1_SHORTCUTS[action])) out[action] = keys;
  }
  return Object.keys(out).length ? out : undefined;
}

/** Converts version 1 stored settings into version 2 overrides (still unsanitized). */
export function migrateLegacySettings(raw: Legacy): Legacy {
  const out: Legacy = {};
  const presetLimits = V1_PRESET_LIMITS[String(raw.preset)] ?? {};
  for (const [key, fallback] of Object.entries(V1_DEFAULTS)) {
    if (!(key in raw)) continue;
    const value = raw[key];
    if (same(value, fallback) || same(value, V1_LEGACY_VALUES[key]) || (key in presetLimits && same(value, presetLimits[key]))) continue;
    out[key] = value;
  }
  const mode = performanceMode(raw);
  if (mode) out.performanceMode = mode;
  if (raw.loopMode === "stop" || raw.loopMode === "resist") out.wrapAround = false;
  if (raw.verticalGesture === "pan" || raw.verticalGesture === "scroll" || raw.verticalGesture === "disabled") out.verticalGesture = "off";
  if (raw.horizontalGesture === "navigate") out.horizontalGesture = "navigate";
  if (raw.horizontalGesture === "disabled") out.horizontalGesture = "off";
  if (raw.defaultView === "grid" || raw.defaultView === "masonry") out.defaultView = "grid";
  if (raw.prefetch === "all") out.prefetch = "visible";
  if (raw.scanScope === "page" || raw.scanScope === "first") out.scanScope = raw.scanScope;
  else delete out.scanScope;
  if (raw.gifAutoplay === "never") out.gifAutoplay = false;
  if (raw.preloadOriginals === "next" || raw.preloadOriginals === "three" || raw.preloadOriginals === "aggressive") out.preloadOriginals = "next";
  if (raw.motion === "reduced" || raw.motion === "none") out.reducedMotion = true;
  const shortcuts = changedShortcuts(raw.shortcuts);
  if (shortcuts) out.shortcuts = shortcuts;
  return out;
}
