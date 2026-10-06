/**
 * How the settings page presents every setting: plain-language label, a one-line
 * explanation, the section it lives in and whether it is an advanced detail.
 * A unit test checks that every setting appears here exactly once.
 */
import type {LinkPeekSettings} from "../shared/settings";

export type SettingKey = keyof LinkPeekSettings;
export type Control = "toggle" | "choice" | "segmented" | "number" | "range" | "keywords" | "shortcuts" | "sites" | "seen";

export interface FieldSpec {
  key: SettingKey;
  label: string;
  help: string;
  control?: Control;
  /** Display names for choice values; values not listed are not offered. */
  options?: Record<string, string>;
  unit?: string;
  /** Show a 0-1 value as a percentage. */
  percent?: boolean;
  advanced?: boolean;
}

export interface SectionSpec {
  id: string;
  title: string;
  summary: string;
  fields: FieldSpec[];
}

/** Settings that exist for the extension's own bookkeeping and are never shown. */
export const INTERNAL_SETTINGS: readonly SettingKey[] = ["onboardingComplete"];

export const SECTIONS: SectionSpec[] = [
  {
    id: "essentials", title: "Essentials", summary: "The few choices that shape everything else.",
    fields: [
      {key: "enabled", label: "LinkPeek is on", help: "Turn previews off everywhere. To pause one site, use the toolbar button while you are on it."},
      {key: "activationMode", label: "Open previews by", help: "Hover is the one-handed default. Alt + hover only opens while Alt is held. Click opens on click; Ctrl-click still opens links normally.", control: "segmented", options: {hover: "Hovering", modifier: "Alt + hover", click: "Clicking"}},
      {key: "hoverDelay", label: "Hover delay", help: "How long the pointer rests on a link before its preview opens.", unit: "ms"},
      {key: "performanceMode", label: "Performance", help: "Auto prepares what this device can comfortably handle and eases off whenever the page or the system is busy. Data saver prepares nothing ahead. Fast prepares more on capable machines.", control: "segmented", options: {auto: "Auto (recommended)", saver: "Data saver", fast: "Fast"}},
      {key: "activationKeywords", label: "Only links containing", help: "Optional. Words or phrases, one per line or separated by commas. When set, LinkPeek only previews links whose address contains one of them.", control: "keywords"}
    ]
  },
  {
    id: "opening", title: "Opening and closing", summary: "When a preview appears, and when it gets out of the way.",
    fields: [
      {key: "switchDelay", label: "Delay before switching links", help: "While a preview is open, another link takes over only after you rest on it this long. Links on the way from the open link to its preview never take over.", unit: "ms"},
      {key: "showHoverRing", label: "Show the hover countdown", help: "A small ring beside the pointer fills until the link opens. It turns green when the link's media is already prepared."},
      {key: "quickOpenWhenStill", label: "Open sooner when the pointer stops", help: "If a link's media is already prepared, its preview opens as soon as the pointer comes to rest on it, at half the hover delay."},
      {key: "ignoreScrollHover", label: "Ignore links that scroll under the pointer", help: "Scrolling the page never opens a preview by itself. Move the pointer to open the link under it."},
      {key: "closeDelay", label: "Close delay", help: "How long the preview waits after the pointer leaves it before closing.", unit: "ms"},
      {key: "closeOnOutsideClick", label: "Close when clicking elsewhere", help: "Clicking anywhere outside the preview closes it, unless it is pinned."},
      {key: "magneticBridge", label: "Forgiving path to the panel", help: "Keep the preview open while the pointer travels from the link into the panel, even across other content."},
      {key: "magneticBridgeStrength", label: "Path width", help: "How far off the direct path the pointer can wander on its way to the panel.", control: "range", percent: true, advanced: true},
      {key: "cancelMovePx", label: "Movement that restarts the timer", help: "Moving this far across a link while waiting restarts the hover delay, so sweeping over large links does not open them.", unit: "px", advanced: true}
    ]
  },
  {
    id: "browsing", title: "Browsing a gallery", summary: "Moving through media with one hand.",
    fields: [
      {key: "defaultView", label: "Open galleries as", help: "Single media first, or every item as a grid. G switches at any time, and LinkPeek remembers your last choice.", control: "segmented", options: {focus: "Single media", grid: "Grid"}},
      {key: "reverseVertical", label: "Scroll up for the next item", help: "Off: scrolling down shows the next item, like a feed. On: scrolling up does."},
      {key: "verticalGesture", label: "Vertical scrolling", help: "Browse moves through the gallery. Off leaves vertical scrolling alone.", control: "segmented", options: {navigate: "Browse", off: "Off"}},
      {key: "horizontalGesture", label: "Horizontal swipe", help: "Fast scrub jumps several items per swipe; One at a time moves by single items.", control: "segmented", options: {scrub: "Fast scrub", navigate: "One at a time", off: "Off"}},
      {key: "navSensitivity", label: "Swipe sensitivity", help: "Higher moves to the next item with a shorter swipe.", control: "range", percent: true},
      {key: "wrapAround", label: "Wrap around at the ends", help: "After the last item comes the first."},
      {key: "resumePosition", label: "Reopen where I left off", help: "A gallery you reopen in the same tab starts at the item you last viewed."},
      {key: "slideshowSeconds", label: "Slideshow speed", help: "Seconds per item when the slideshow (S) is running. Space pauses it; the arrows, scroll and mouse buttons skip ahead without stopping it.", unit: "s"},
      {key: "slideshowPlayThrough", label: "Let videos and GIFs finish", help: "In a slideshow, a video or GIF stays up until it has played through (up to a minute), even if that is longer than the slideshow speed."},
      {key: "shuffleSlideshow", label: "Shuffle everything", help: "S starts an endless slideshow of media from every link on the page, mixed so two slides in a row never come from the same link. Press S anywhere on a page, even without a preview open."},
      {key: "skipSeenMedia", label: "Skip media you have seen", help: "The shuffle never shows something LinkPeek has already shown you. What you have seen is remembered on this device only, and only while this is on.", control: "seen"},
      {key: "shuffleFollowLinks", label: "Keep finding more", help: "When the page runs out, the shuffle reads the pages its links lead to, then the links on those, for more. It stays on the same site unless Search linked pages is set to Any site, and never follows sign-out or similar links."},
      {key: "thumbnailSize", label: "Grid tile size", help: "Starting size of grid tiles. The − and + buttons (or − and + keys) change it while browsing.", unit: "px"},
      {key: "showLearningTips", label: "Show tips", help: "A short hint over the first media of each preview."},
      {key: "mouseWheel", label: "Mouse wheel over media", help: "What a regular mouse wheel does over the media.", control: "choice", options: {navigate: "Browse", scroll: "Scroll the page", zoom: "Zoom"}, advanced: true},
      {key: "reverseHorizontal", label: "Reverse horizontal swipe", help: "Swipe left instead of right to move forward.", advanced: true},
      {key: "fastSwipeAcceleration", label: "Fast swipes skip several items", help: "A quick, long swipe moves more than one item.", advanced: true},
      {key: "maxImagesPerSwipe", label: "Most items per swipe", help: "The limit for a fast swipe or horizontal scrub.", advanced: true},
      {key: "momentumFiltering", label: "Ignore trackpad momentum", help: "After a step, the coasting tail of the same swipe is ignored so one swipe is one step.", advanced: true},
      {key: "gestureCooldown", label: "Momentum window", help: "How long the coasting tail is ignored.", unit: "ms", advanced: true},
      {key: "gestureThreshold", label: "Swipe distance", help: "Base trackpad travel needed for one step, before sensitivity is applied.", unit: "px", advanced: true}
    ]
  },
  {
    id: "zoom", title: "Zoom", summary: "Looking closer without leaving the page.",
    fields: [
      {key: "pinchZoom", label: "Pinch to zoom", help: "Trackpad pinch (or Ctrl + scroll) zooms around the pointer."},
      {key: "doubleClick", label: "Double-click", help: "What double-clicking the media does.", control: "choice", options: {zoom: "Zoom here", next: "Next item", fullscreen: "Full screen", none: "Nothing"}},
      {key: "doubleClickZoom", label: "Double-click zoom", help: "How far one double-click zooms in.", unit: "×"},
      {key: "maxZoom", label: "Maximum zoom", help: "The closest zoom allowed.", unit: "×"},
      {key: "resetZoomPerImage", label: "Reset zoom for each item", help: "Every item starts fitted to the panel."},
      {key: "secondDoubleClick", label: "Double-click while zoomed", help: "Fit returns to the whole image; Zoom further keeps going in.", control: "choice", options: {fit: "Fit", increase: "Zoom further"}, advanced: true},
      {key: "panWhenZoomed", label: "Scroll pans while zoomed", help: "While zoomed in, scrolling moves around the image instead of changing items.", advanced: true},
      {key: "doubleClickDragPan", label: "Double-click and drag to pan", help: "While zoomed, double-click and hold, then drag to move the image.", advanced: true},
      {key: "pinchSensitivity", label: "Pinch speed", help: "How fast a pinch zooms.", unit: "×", advanced: true},
      {key: "panFriction", label: "Pan speed", help: "How far the image moves for each scroll while zoomed.", unit: "×", advanced: true}
    ]
  },
  {
    id: "panel", title: "Panel", summary: "Size, place and feel of the preview.",
    fields: [
      {key: "panelWidth", label: "Width", help: "Starting width. Drag any edge to resize; LinkPeek can remember your size.", unit: "px"},
      {key: "focusHeightVh", label: "Media height", help: "Height of the media area, as a share of the window.", unit: "% of window"},
      {key: "placement", label: "Placement", help: "Where a new preview appears relative to the pointer. Auto picks the side with room.", control: "choice", options: {auto: "Auto", right: "Right", left: "Left", above: "Above", below: "Below"}},
      {key: "draggablePanel", label: "Drag to move", help: "Drag the panel by its title bar."},
      {key: "resizablePanel", label: "Resize from edges", help: "Pull any edge or corner to resize."},
      {key: "rememberPanelGeometry", label: "Remember position and size", help: "New previews open where you last placed the panel. Double-click the title to forget it."},
      {key: "startExpanded", label: "Start expanded", help: "Open previews large, in the middle of the window."},
      {key: "quickViewControls", label: "Expand and tile-size buttons", help: "Show the expand button and the grid's − and + buttons in the panel."},
      {key: "reducedMotion", label: "Reduce motion", help: "No opening animation, fades or loading shimmer. Your system's reduced-motion setting is always respected too."},
      {key: "transparency", label: "Background transparency", help: "How much of the page shows through the panel.", control: "range", percent: true, advanced: true},
      {key: "blur", label: "Background blur", help: "How much the page behind the panel is blurred.", unit: "px", advanced: true},
      {key: "expandedWidthVw", label: "Expanded width", help: "Width of the expanded panel.", unit: "% of window", advanced: true},
      {key: "expandedHeightVh", label: "Expanded height", help: "Height of the expanded panel.", unit: "% of window", advanced: true},
      {key: "panelMaxVh", label: "Tallest panel", help: "The panel never grows past this share of the window.", unit: "% of window", advanced: true},
      {key: "pointerGap", label: "Gap from the pointer", help: "Space between the pointer and a new panel.", unit: "px", advanced: true}
    ]
  },
  {
    id: "media", title: "Finding media", summary: "What counts as posted media, and how hard to look.",
    fields: [
      {key: "includeGif", label: "GIFs", help: "Include animated GIFs."},
      {key: "includeVideo", label: "Videos", help: "Preview links to video files and videos posted in threads."},
      {key: "minWidth", label: "Minimum media width", help: "Skip media narrower than this when its width is known. The default is 50 px.", unit: "px"},
      {key: "minHeight", label: "Smallest image height", help: "Images shorter than this are treated as page decoration.", unit: "px"},
      {key: "quotedDuplicates", label: "Media inside quotes", help: "Forum replies often quote earlier posts. Hide skips quoted copies; Mark keeps them, labelled.", control: "segmented", options: {hide: "Hide", mark: "Mark", show: "Show"}},
      {key: "recursiveSearch", label: "Search linked pages", help: "When a page has no media of its own (an index or album list), look through the pages it links to.", control: "segmented", options: {off: "Off", "same-origin": "Same site", all: "Any site"}},
      {key: "recursiveTrigger", label: "Search linked pages when", help: "Only when the page itself has nothing, or always, to collect more.", control: "choice", options: {empty: "The page has no media", always: "Always"}},
      {key: "maxMediaItems", label: "Most media per gallery", help: "A gallery stops growing here, even for huge threads."},
      {key: "scanScope", label: "Forum threads", help: "How much of a Discourse thread to read.", control: "choice", options: {whole: "The whole thread", page: "Only the first page", first: "The first 50 posts"}},
      {key: "includeImages", label: "Still images", help: "Include JPEG and PNG images. Turn off to collect only GIFs and video.", advanced: true},
      {key: "includeWebp", label: "WebP images", help: "Include WebP images.", advanced: true},
      {key: "includeAvif", label: "AVIF images", help: "Include AVIF images.", advanced: true},
      {key: "includeSvg", label: "SVG images", help: "Include SVG images; usually icons and diagrams.", advanced: true},
      {key: "includeAvatars", label: "Profile pictures", help: "Include avatars, which are normally skipped.", advanced: true},
      {key: "includeEmoji", label: "Emoji and reactions", help: "Include emoji images, which are normally skipped.", advanced: true},
      {key: "recursiveMaxDepth", label: "Link levels to follow", help: "1 reads the pages the opened page links to; 2 also reads the pages those link to.", advanced: true},
      {key: "recursiveMaxPages", label: "Most pages per search", help: "The linked-page search stops after reading this many pages.", advanced: true},
      {key: "maxPosts", label: "Most posts per thread", help: "Very long threads stop being read here.", advanced: true},
      {key: "batchSize", label: "Posts per request", help: "Posts fetched per request while reading a thread.", advanced: true},
      {key: "progressiveScan", label: "Show media while scanning", help: "Long threads fill in as they are read instead of all at the end.", advanced: true},
      {key: "continueAfterClose", label: "Keep scanning after closing", help: "Finishing a scan after the preview closes makes reopening it instant.", control: "choice", options: {no: "Stop at once", brief: "For a moment", always: "Until done"}, advanced: true}
    ]
  },
  {
    id: "gif", title: "GIFs and video", summary: "Playback for moving media.",
    fields: [
      {key: "gifAutoplay", label: "Play GIFs automatically", help: "GIFs start playing when shown. Space pauses."},
      {key: "gifLoop", label: "Loop GIFs", help: "Start again after the last frame."},
      {key: "gifDefaultSpeed", label: "GIF speed", help: "Starting playback speed; [ and ] change it while watching.", unit: "×"},
      {key: "gifControls", label: "GIF controls", help: "How visible the play, frame and timeline controls are.", control: "segmented", options: {always: "Always", hover: "On hover", minimal: "Minimal"}},
      {key: "videoAutoplay", label: "Play videos automatically", help: "Videos start playing when shown."},
      {key: "videoMuted", label: "Start videos muted", help: "Videos play without sound until you unmute them."},
      {key: "gifPauseWhenHidden", label: "Pause GIFs in background tabs", help: "Saves battery while you are elsewhere.", advanced: true},
      {key: "gifDecodeMaxMb", label: "Largest GIF with frame controls", help: "Bigger GIFs play natively, without frame stepping.", unit: "MB", advanced: true}
    ]
  },
  {
    id: "performance", title: "Performance", summary: "How much LinkPeek prepares before you ask. Auto mode adapts these to your device on its own.",
    fields: [
      {key: "prefetch", label: "Prepare links before hover", help: "Whole page prepares the links nearest the pointer first, then quietly checks the rest of the page whenever the browser is idle, pausing when it is busy. Near the pointer and Whole screen stop at what is close by.", control: "segmented", options: {off: "Off", nearby: "Near the pointer", visible: "Whole screen", page: "Whole page"}},
      {key: "meteredOff", label: "Pause on slow or Data Saver connections", help: "When the browser reports Data Saver or a 2G connection, nothing is prepared ahead."},
      {key: "preloadOriginals", label: "Load full-size originals ahead", help: "Previews use lighter images. Next also downloads the next item's original file.", control: "segmented", options: {never: "Never", next: "Next item"}},
      {key: "maxRequests", label: "Most requests at once", help: "A hard ceiling on simultaneous scans, whatever the mode.", advanced: true},
      {key: "preloadMemoryMb", label: "Image memory limit", help: "A hard ceiling on decoded images kept ready, whatever the mode.", unit: "MB", advanced: true},
      {key: "maxCacheMb", label: "Scan cache size", help: "Memory for remembered scans, so reopening a link is instant.", unit: "MB", advanced: true},
      {key: "cacheMinutes", label: "Remember scans for", help: "After this, a link is scanned again.", unit: "min", advanced: true}
    ]
  },
  {
    id: "keyboard", title: "Keyboard", summary: "Every shortcut, rebindable. Click + then press the keys you want.",
    fields: [
      {key: "shortcuts", label: "Shortcuts", help: "Letters ignore Caps Lock. Shortcuts never fire while you are typing in a field.", control: "shortcuts"},
      {key: "inspectorChordMs", label: "Inspector second-press window", help: "The preload inspector opens with its shortcut (Ctrl+X by default) followed by the same key alone within this time, so Cut keeps working. The toolbar button opens it too.", unit: "ms", advanced: true}
    ]
  },
  {
    id: "sites", title: "Sites", summary: "Rules for particular websites.",
    fields: [
      {key: "siteProfiles", label: "Site rules", help: "A rule applies while you browse that site, and when LinkPeek scans its pages. *.example.com covers every subdomain.", control: "sites"}
    ]
  },
  {
    id: "privacy", title: "Privacy and network", summary: "LinkPeek has no server; requests go straight to the sites you preview.",
    fields: [
      {key: "stripTracking", label: "Remove tracking parameters", help: "Drop utm_, fbclid and similar parameters from links LinkPeek follows."},
      {key: "referrerPolicy", label: "Tell sites where you came from", help: "What LinkPeek's requests reveal about the page you are on.", control: "choice", options: {"same-origin": "Only within the same site", never: "Never", default: "Browser default"}},
      {key: "followRedirects", label: "Follow redirects", help: "Follow links that redirect elsewhere.", advanced: true},
      {key: "fetchTimeout", label: "Give up on a page after", help: "Slow pages are skipped after this long.", unit: "ms", advanced: true},
      {key: "canonicalizeQuery", label: "Sort link parameters", help: "Treat links that differ only in parameter order as the same page during linked-page search.", advanced: true},
      {key: "mutationObserver", label: "Watch for links added after loading", help: "Needed for infinite scroll and modern web apps. Turn off only to diagnose a problem.", advanced: true}
    ]
  }
];

export const SHORTCUT_LABELS: Record<keyof LinkPeekSettings["shortcuts"], string> = {
  next: "Next media", previous: "Previous media", nextLink: "Next link with media", previousLink: "Previous link with media",
  grid: "Grid / single media", expand: "Expand / restore", pin: "Pin open", favorite: "Save link", open: "Open original",
  openPage: "Open the linked page", download: "Download original", downloadAll: "Download the whole gallery (press twice)",
  copy: "Copy media link", slideshow: "Slideshow (shuffle when on)", pause: "Pause / resume the slideshow", popOut: "Float the preview above every window", fill: "Fill the panel / fit", rotate: "Rotate a quarter turn", zoomIn: "Zoom in (bigger tiles in grid)",
  zoomOut: "Zoom out (smaller tiles in grid)", resetZoom: "Reset zoom", help: "Show controls", close: "Close", preloadInspector: "Preload inspector (then the same key alone)"
};

export function fieldFor(key: SettingKey): FieldSpec | undefined {
  for (const section of SECTIONS) {
    const field = section.fields.find(entry => entry.key === key);
    if (field) return field;
  }
  return undefined;
}
