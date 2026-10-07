/**
 * The LinkPeek settings model.
 *
 * Storage keeps only the values a person changed (sparse overrides) plus a
 * schema version. Anything left at its default follows DEFAULT_SETTINGS, so a
 * better default in a later release reaches everyone who never touched it.
 */
import {migrateLegacySettings} from "./settings-migration";
import {normalizeCombo} from "./shortcuts";

export type ActivationMode = "hover" | "modifier" | "click";
export type PerformanceMode = "auto" | "saver" | "fast";
export type PrefetchMode = "off" | "nearby" | "visible" | "page";
export type ViewMode = "focus" | "grid";
export type Placement = "auto" | "right" | "left" | "above" | "below";

export const SHORTCUT_ACTIONS = [
  "next", "previous", "nextLink", "previousLink", "grid", "expand", "pin", "favorite",
  "open", "openPage", "download", "downloadAll", "copy", "slideshow", "pause", "fill", "rotate", "zoomIn", "zoomOut", "resetZoom",
  "popOut", "help", "close", "preloadInspector"
] as const;
export type ShortcutAction = typeof SHORTCUT_ACTIONS[number];
export type Shortcuts = Record<ShortcutAction, string[]>;
export type SiteProfiles = Record<string, Partial<LinkPeekSettings>>;

export interface LinkPeekSettings {
  // Opening previews
  enabled: boolean;
  activationMode: ActivationMode;
  hoverDelay: number;
  switchDelay: number;
  inspectorChordMs: number;
  quickOpenWhenStill: boolean;
  showHoverRing: boolean;
  ignoreScrollHover: boolean;
  cancelMovePx: number;
  closeDelay: number;
  closeOnOutsideClick: boolean;
  magneticBridge: boolean;
  magneticBridgeStrength: number;
  activationKeywords: string[];

  // Panel
  panelWidth: number;
  panelMaxVh: number;
  focusHeightVh: number;
  placement: Placement;
  pointerGap: number;
  draggablePanel: boolean;
  resizablePanel: boolean;
  rememberPanelGeometry: boolean;
  startExpanded: boolean;
  expandedWidthVw: number;
  expandedHeightVh: number;
  quickViewControls: boolean;
  transparency: number;
  blur: number;
  reducedMotion: boolean;
  showLearningTips: boolean;

  // Browsing a gallery
  defaultView: ViewMode;
  wrapAround: boolean;
  resumePosition: boolean;
  slideshowSeconds: number;
  /** Videos and GIFs stay up until they have played through (up to a minute). */
  slideshowPlayThrough: boolean;
  /** S starts an endless slideshow mixing media from every link on the page. */
  shuffleSlideshow: boolean;
  /** The shuffle shows GIFs first, still pictures only while no GIF is available. */
  shuffleFavorGifs: boolean;
  /** The shuffle skips media LinkPeek has already shown. */
  skipSeenMedia: boolean;
  /** Everything LinkPeek shows is listed on the History page. */
  keepHistory: boolean;
  /** When the page runs out, the shuffle follows links to further pages. */
  shuffleFollowLinks: boolean;
  /** While the mirror window is open, previews show only there (the page panel keeps working, unseen). */
  mirrorOnly: boolean;
  /** Each item shows the page or post it came from, when that is not already the gallery's own title. */
  showSourceTitle: boolean;
  thumbnailSize: number;
  verticalGesture: "navigate" | "off";
  horizontalGesture: "scrub" | "navigate" | "off";
  reverseVertical: boolean;
  reverseHorizontal: boolean;
  mouseWheel: "navigate" | "scroll" | "zoom";
  navSensitivity: number;
  gestureThreshold: number;
  gestureCooldown: number;
  momentumFiltering: boolean;
  fastSwipeAcceleration: boolean;
  maxImagesPerSwipe: number;

  // Zoom
  pinchZoom: boolean;
  pinchSensitivity: number;
  doubleClick: "zoom" | "fullscreen" | "next" | "none";
  doubleClickZoom: number;
  secondDoubleClick: "fit" | "increase";
  maxZoom: number;
  panWhenZoomed: boolean;
  panFriction: number;
  doubleClickDragPan: boolean;
  resetZoomPerImage: boolean;

  // Finding media
  includeImages: boolean;
  includeGif: boolean;
  includeWebp: boolean;
  includeAvif: boolean;
  includeSvg: boolean;
  includeVideo: boolean;
  includeAvatars: boolean;
  includeEmoji: boolean;
  minWidth: number;
  minHeight: number;
  quotedDuplicates: "hide" | "mark" | "show";
  recursiveSearch: "off" | "same-origin" | "all";
  recursiveTrigger: "empty" | "always";
  recursiveMaxDepth: number;
  recursiveMaxPages: number;
  maxMediaItems: number;
  scanScope: "whole" | "page" | "first";
  maxPosts: number;
  batchSize: number;
  progressiveScan: boolean;
  continueAfterClose: "no" | "brief" | "always";

  // GIF and video
  gifAutoplay: boolean;
  gifLoop: boolean;
  gifDefaultSpeed: number;
  gifControls: "always" | "hover" | "minimal";
  gifPauseWhenHidden: boolean;
  gifDecodeMaxMb: number;
  videoAutoplay: boolean;
  videoMuted: boolean;

  // Performance
  performanceMode: PerformanceMode;
  prefetch: PrefetchMode;
  meteredOff: boolean;
  maxRequests: number;
  preloadMemoryMb: number;
  preloadOriginals: "never" | "next";
  maxCacheMb: number;
  cacheMinutes: number;
  /** Keep galleries on this device, so links opened or prepared before show at once. */
  rememberGalleries: boolean;
  rememberGalleriesDays: number;
  /** Every picture, GIF and video shown is saved on the device, for offline viewing on the History page. */
  saveMediaOffline: boolean;
  /** Media of prepared links is saved too, not only what is shown. */
  savePreparedMedia: boolean;
  savedMediaBudgetMb: number;
  /** Each saved file is also written into Downloads / LinkPeek Library, so the files themselves can be browsed. */
  saveToDownloads: boolean;
  /** Library tiles hold a GIF still until the pointer rests on them. */
  libraryGifHover: boolean;
  /** Library video tiles play, muted, while the pointer rests on them. */
  libraryVideoHover: boolean;

  // Keyboard and sites
  shortcuts: Shortcuts;
  siteProfiles: SiteProfiles;

  // Privacy and network
  stripTracking: boolean;
  canonicalizeQuery: boolean;
  referrerPolicy: "default" | "same-origin" | "never";
  followRedirects: boolean;
  fetchTimeout: number;
  mutationObserver: boolean;

  onboardingComplete: boolean;
}

export const DEFAULT_SHORTCUTS: Shortcuts = {
  next: ["ArrowDown", "ArrowRight", "Space"],
  previous: ["ArrowUp", "ArrowLeft"],
  nextLink: ["n"],
  previousLink: ["Shift+n"],
  grid: ["g"],
  expand: ["f"],
  pin: ["p"],
  favorite: ["b"],
  open: ["o"],
  download: ["d"],
  copy: ["c"],
  slideshow: ["s"],
  pause: ["Space"],
  popOut: ["e"],
  zoomIn: ["+", "="],
  zoomOut: ["-"],
  resetZoom: ["0"],
  help: ["?"],
  close: ["Escape"],
  openPage: ["Shift+o"],
  downloadAll: ["Shift+d"],
  fill: ["w"],
  rotate: ["r"],
  preloadInspector: ["Ctrl+x"]
};

export const DEFAULT_SETTINGS: LinkPeekSettings = {
  enabled: true,
  activationMode: "hover",
  hoverDelay: 300,
  switchDelay: 650,
  inspectorChordMs: 900,
  quickOpenWhenStill: true,
  showHoverRing: true,
  ignoreScrollHover: true,
  cancelMovePx: 18,
  closeDelay: 180,
  closeOnOutsideClick: true,
  magneticBridge: true,
  magneticBridgeStrength: 0.7,
  activationKeywords: [],

  panelWidth: 480,
  panelMaxVh: 70,
  focusHeightVh: 54,
  placement: "auto",
  pointerGap: 12,
  draggablePanel: true,
  resizablePanel: true,
  rememberPanelGeometry: true,
  startExpanded: false,
  expandedWidthVw: 92,
  expandedHeightVh: 92,
  quickViewControls: true,
  transparency: 0.08,
  blur: 16,
  reducedMotion: false,
  showLearningTips: true,

  defaultView: "focus",
  wrapAround: true,
  resumePosition: true,
  slideshowSeconds: 3,
  slideshowPlayThrough: true,
  shuffleSlideshow: true,
  shuffleFavorGifs: true,
  skipSeenMedia: true,
  keepHistory: true,
  shuffleFollowLinks: true,
  mirrorOnly: true,
  showSourceTitle: true,
  thumbnailSize: 120,
  verticalGesture: "navigate",
  horizontalGesture: "scrub",
  reverseVertical: false,
  reverseHorizontal: false,
  mouseWheel: "navigate",
  navSensitivity: 0.55,
  gestureThreshold: 62,
  gestureCooldown: 140,
  momentumFiltering: true,
  fastSwipeAcceleration: true,
  maxImagesPerSwipe: 3,

  pinchZoom: true,
  pinchSensitivity: 1,
  doubleClick: "zoom",
  doubleClickZoom: 2,
  secondDoubleClick: "fit",
  maxZoom: 8,
  panWhenZoomed: true,
  panFriction: 0.85,
  doubleClickDragPan: true,
  resetZoomPerImage: true,

  includeImages: true,
  includeGif: true,
  includeWebp: true,
  includeAvif: true,
  includeSvg: false,
  includeVideo: true,
  includeAvatars: false,
  includeEmoji: false,
  minWidth: 50,
  minHeight: 160,
  quotedDuplicates: "hide",
  recursiveSearch: "same-origin",
  recursiveTrigger: "empty",
  recursiveMaxDepth: 3,
  recursiveMaxPages: 50,
  maxMediaItems: 400,
  scanScope: "whole",
  maxPosts: 2000,
  batchSize: 50,
  progressiveScan: true,
  continueAfterClose: "brief",

  gifAutoplay: true,
  gifLoop: true,
  gifDefaultSpeed: 1,
  gifControls: "always",
  gifPauseWhenHidden: true,
  gifDecodeMaxMb: 32,
  videoAutoplay: true,
  videoMuted: true,

  performanceMode: "auto",
  prefetch: "page",
  meteredOff: true,
  maxRequests: 4,
  preloadMemoryMb: 256,
  preloadOriginals: "never",
  maxCacheMb: 64,
  cacheMinutes: 60,
  rememberGalleries: true,
  rememberGalleriesDays: 30,
  saveMediaOffline: true,
  savePreparedMedia: true,
  savedMediaBudgetMb: 2048,
  saveToDownloads: true,
  libraryGifHover: false,
  libraryVideoHover: true,

  shortcuts: DEFAULT_SHORTCUTS,
  siteProfiles: {},

  stripTracking: true,
  canonicalizeQuery: true,
  referrerPolicy: "same-origin",
  followRedirects: true,
  fetchTimeout: 8000,
  mutationObserver: true,

  onboardingComplete: false
};

/** Allowed values for every enumerated setting. */
export const SETTING_CHOICES: Partial<Record<keyof LinkPeekSettings, readonly string[]>> = {
  activationMode: ["hover", "modifier", "click"],
  placement: ["auto", "right", "left", "above", "below"],
  defaultView: ["focus", "grid"],
  verticalGesture: ["navigate", "off"],
  horizontalGesture: ["scrub", "navigate", "off"],
  mouseWheel: ["navigate", "scroll", "zoom"],
  doubleClick: ["zoom", "fullscreen", "next", "none"],
  secondDoubleClick: ["fit", "increase"],
  quotedDuplicates: ["hide", "mark", "show"],
  recursiveSearch: ["off", "same-origin", "all"],
  recursiveTrigger: ["empty", "always"],
  scanScope: ["whole", "page", "first"],
  continueAfterClose: ["no", "brief", "always"],
  gifControls: ["always", "hover", "minimal"],
  performanceMode: ["auto", "saver", "fast"],
  prefetch: ["off", "nearby", "visible", "page"],
  preloadOriginals: ["never", "next"],
  referrerPolicy: ["default", "same-origin", "never"]
};

export interface NumberRange {min: number; max: number; step: number}

/** Inclusive bounds and step for every numeric setting. */
export const SETTING_RANGES: Partial<Record<keyof LinkPeekSettings, NumberRange>> = {
  hoverDelay: {min: 0, max: 2000, step: 25},
  switchDelay: {min: 0, max: 3000, step: 50},
  cancelMovePx: {min: 4, max: 80, step: 2},
  closeDelay: {min: 0, max: 2000, step: 20},
  magneticBridgeStrength: {min: 0, max: 1, step: 0.05},
  panelWidth: {min: 280, max: 1600, step: 10},
  panelMaxVh: {min: 40, max: 98, step: 1},
  focusHeightVh: {min: 30, max: 90, step: 1},
  pointerGap: {min: 0, max: 48, step: 1},
  expandedWidthVw: {min: 50, max: 98, step: 1},
  expandedHeightVh: {min: 50, max: 98, step: 1},
  transparency: {min: 0, max: 0.9, step: 0.01},
  blur: {min: 0, max: 40, step: 1},
  slideshowSeconds: {min: 1, max: 30, step: 0.5},
  thumbnailSize: {min: 48, max: 320, step: 4},
  navSensitivity: {min: 0, max: 1, step: 0.05},
  gestureThreshold: {min: 12, max: 200, step: 2},
  gestureCooldown: {min: 0, max: 600, step: 10},
  maxImagesPerSwipe: {min: 1, max: 10, step: 1},
  pinchSensitivity: {min: 0.2, max: 3, step: 0.1},
  doubleClickZoom: {min: 1.25, max: 8, step: 0.25},
  maxZoom: {min: 1, max: 20, step: 0.5},
  panFriction: {min: 0.1, max: 2, step: 0.05},
  minWidth: {min: 0, max: 2000, step: 1},
  inspectorChordMs: {min: 100, max: 5000, step: 50},
  minHeight: {min: 0, max: 2000, step: 10},
  recursiveMaxDepth: {min: 1, max: 3, step: 1},
  recursiveMaxPages: {min: 1, max: 50, step: 1},
  maxMediaItems: {min: 1, max: 5000, step: 25},
  maxPosts: {min: 20, max: 10000, step: 20},
  batchSize: {min: 10, max: 100, step: 10},
  gifDefaultSpeed: {min: 0.25, max: 4, step: 0.25},
  gifDecodeMaxMb: {min: 1, max: 100, step: 1},
  maxRequests: {min: 1, max: 8, step: 1},
  preloadMemoryMb: {min: 32, max: 1024, step: 16},
  maxCacheMb: {min: 16, max: 1024, step: 16},
  cacheMinutes: {min: 1, max: 1440, step: 5},
  rememberGalleriesDays: {min: 1, max: 365, step: 1},
  savedMediaBudgetMb: {min: 256, max: 51200, step: 256},
  fetchTimeout: {min: 1000, max: 30000, step: 500}
};

/** Settings that change what a scan returns; cached scans are keyed on these. */
export const SCAN_SETTING_KEYS = [
  "includeImages", "includeGif", "includeWebp", "includeAvif", "includeSvg", "includeVideo",
  "includeAvatars", "includeEmoji", "minWidth", "minHeight", "quotedDuplicates", "recursiveSearch",
  "recursiveTrigger", "recursiveMaxDepth", "recursiveMaxPages", "maxMediaItems", "scanScope", "maxPosts",
  "stripTracking", "canonicalizeQuery", "followRedirects", "referrerPolicy"
] as const satisfies readonly (keyof LinkPeekSettings)[];

export const SETTINGS_VERSION = 2;
const MAX_KEYWORDS = 50;
const MAX_KEYS_PER_ACTION = 4;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sameValue(a: unknown, b: unknown) {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Cleans keyword input: trims entries and drops empties and case-insensitive duplicates. */
export function normalizeKeywords(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const seen = new Set<string>(), out: string[] = [];
  for (const entry of value) {
    const keyword = String(entry).trim();
    if (!keyword || seen.has(keyword.toLowerCase())) continue;
    seen.add(keyword.toLowerCase());
    out.push(keyword);
  }
  return out.slice(0, MAX_KEYWORDS);
}

function sanitizeShortcuts(value: unknown): Partial<Shortcuts> | undefined {
  if (!isRecord(value)) return undefined;
  const out: Partial<Shortcuts> = {};
  for (const action of SHORTCUT_ACTIONS) {
    const keys = value[action];
    if (!Array.isArray(keys)) continue;
    const combos = keys.map(key => normalizeCombo(String(key))).filter((combo): combo is string => Boolean(combo));
    out[action] = [...new Set(combos)].slice(0, MAX_KEYS_PER_ACTION);
  }
  return out;
}

function sanitizeSiteProfiles(value: unknown): SiteProfiles | undefined {
  if (!isRecord(value)) return undefined;
  const out: SiteProfiles = {};
  for (const [host, override] of Object.entries(value)) {
    const pattern = host.trim().toLowerCase();
    if (!pattern || !isRecord(override)) continue;
    out[pattern] = sanitizeOverrides(override, false);
  }
  return out;
}

/**
 * Returns a valid value for `key`, or undefined when `value` cannot be used.
 * Numbers are clamped into range rather than rejected.
 */
export function sanitizeValue<K extends keyof LinkPeekSettings>(key: K, value: unknown): LinkPeekSettings[K] | undefined {
  const fallback = DEFAULT_SETTINGS[key];
  if (key === "shortcuts") return sanitizeShortcuts(value) as LinkPeekSettings[K] | undefined;
  if (key === "siteProfiles") return sanitizeSiteProfiles(value) as LinkPeekSettings[K] | undefined;
  if (key === "activationKeywords") return normalizeKeywords(value) as LinkPeekSettings[K] | undefined;
  if (typeof fallback === "boolean") return typeof value === "boolean" ? value as LinkPeekSettings[K] : undefined;
  if (typeof fallback === "number") {
    if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
    const range = SETTING_RANGES[key];
    return (range ? Math.min(range.max, Math.max(range.min, value)) : value) as LinkPeekSettings[K];
  }
  const choices = SETTING_CHOICES[key];
  if (choices) return typeof value === "string" && choices.includes(value) ? value as LinkPeekSettings[K] : undefined;
  return undefined;
}

/** Keeps the keys of `raw` that are known settings with valid values. */
export function sanitizeOverrides(raw: Record<string, unknown>, allowNested = true): Partial<LinkPeekSettings> {
  const out: Partial<LinkPeekSettings> = {};
  for (const key of Object.keys(DEFAULT_SETTINGS) as (keyof LinkPeekSettings)[]) {
    if (!(key in raw)) continue;
    if (!allowNested && (key === "siteProfiles" || key === "onboardingComplete")) continue;
    const value = sanitizeValue(key, raw[key]);
    if (value !== undefined) (out as Record<string, unknown>)[key] = value;
  }
  return out;
}

/** Builds complete settings from stored overrides, ignoring anything invalid. */
export function resolveSettings(overrides: unknown): LinkPeekSettings {
  const clean = isRecord(overrides) ? sanitizeOverrides(overrides) : {};
  return {
    ...DEFAULT_SETTINGS,
    ...clean,
    shortcuts: {...DEFAULT_SHORTCUTS, ...(clean.shortcuts ?? {})},
    siteProfiles: clean.siteProfiles ?? {}
  };
}

/** The sparse form that is written to storage: only values that differ from defaults. */
export function settingsOverrides(settings: LinkPeekSettings): Partial<LinkPeekSettings> {
  const out: Partial<LinkPeekSettings> = {};
  for (const key of Object.keys(DEFAULT_SETTINGS) as (keyof LinkPeekSettings)[]) {
    if (key === "shortcuts") {
      const changed = SHORTCUT_ACTIONS.filter(action => !sameValue(settings.shortcuts[action], DEFAULT_SHORTCUTS[action]));
      if (changed.length) out.shortcuts = Object.fromEntries(changed.map(action => [action, settings.shortcuts[action]])) as Shortcuts;
      continue;
    }
    if (!sameValue(settings[key], DEFAULT_SETTINGS[key])) (out as Record<string, unknown>)[key] = settings[key];
  }
  return out;
}

export async function loadSettings(): Promise<LinkPeekSettings> {
  const stored = await chrome.storage.local.get(["settings", "settingsVersion"]);
  if (stored.settingsVersion === SETTINGS_VERSION) return resolveSettings(stored.settings);
  const overrides = migrateLegacySettings(isRecord(stored.settings) ? stored.settings : {});
  await chrome.storage.local.set({settings: overrides, settingsVersion: SETTINGS_VERSION});
  return resolveSettings(overrides);
}

export async function saveSettings(settings: LinkPeekSettings) {
  await chrome.storage.local.set({settings: settingsOverrides(settings), settingsVersion: SETTINGS_VERSION});
}

/** Finds the site profile for a hostname: an exact match first, then the longest wildcard. */
export function siteProfileFor(profiles: SiteProfiles, host: string): Partial<LinkPeekSettings> | undefined {
  const name = host.toLowerCase();
  if (profiles[name]) return profiles[name];
  let best: [string, Partial<LinkPeekSettings>] | undefined;
  for (const entry of Object.entries(profiles)) {
    const pattern = entry[0];
    if (!pattern.startsWith("*.")) continue;
    const suffix = pattern.slice(1);
    if ((name.endsWith(suffix) || name === pattern.slice(2)) && (!best || pattern.length > best[0].length)) best = entry;
  }
  return best?.[1];
}

/** Applies the site profile for `url` on top of the global settings. */
export function effectiveSettings(settings: LinkPeekSettings, url: string): LinkPeekSettings {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return settings;
  }
  const override = siteProfileFor(settings.siteProfiles, host);
  return override ? {...settings, ...override, shortcuts: settings.shortcuts, siteProfiles: settings.siteProfiles} : settings;
}

/** True when keywords are off, or the URL contains at least one keyword (case-insensitive). */
export function linkMatchesKeywords(settings: Pick<LinkPeekSettings, "activationKeywords">, url: string) {
  const keywords = settings.activationKeywords.map(keyword => keyword.trim().toLowerCase()).filter(Boolean);
  if (!keywords.length) return true;
  let target = url.toLowerCase();
  try {
    target = decodeURIComponent(url).toLowerCase();
  } catch {
    // A malformed escape: match against the raw URL instead.
  }
  return keywords.some(keyword => target.includes(keyword));
}
