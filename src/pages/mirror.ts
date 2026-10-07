/**
 * The mirror window: a second screen for previews.
 *
 * It shows whatever gallery is open or hovered in the browser, full-bleed,
 * and it is a normal window: drag it to another monitor, minimise it, snap
 * it, or press F11 for true full screen. Browsing inside the mirror pauses
 * position-following for that gallery, so the page cannot yank the view;
 * hovering a new link follows again.
 */
import type {Budget} from "../content/resource-governor";
import type {MirrorStateMessage} from "../shared/messages";
import {SeenMedia, forgetRejected, recordSeen} from "../shared/seen-media";
import {DEFAULT_SETTINGS, loadSettings, type LinkPeekSettings} from "../shared/settings";
import {Viewer} from "../ui/viewer";

/** A dedicated window can afford a generous decoding budget; it never prepares links itself. */
const MIRROR_BUDGET: Budget = {
  speculative: false, nearbyLinks: 0, backgroundLinks: 0, backgroundPaused: false, linkConcurrency: 1, thumbsPerLink: 0,
  hoverThumbs: 0, hoverIdleThumbs: 0, imageConcurrency: 6, ahead: 6, behind: 3, galleryIdle: 400, memoryBytes: 320 * 1024 * 1024
};

const viewer = new Viewer({budget: () => MIRROR_BUDGET, persist: false});
const hint = document.getElementById("hint")!;
/** What is browsed here counts as seen too: the shuffle and the history know about it. */
const seen = new SeenMedia();
let settings: LinkPeekSettings = DEFAULT_SETTINGS;
let currentUrl: string | undefined;
/** Set while applying a remote update, so onPosition can tell local browsing apart. */
let applying = false;
/** The person is browsing this gallery here; the page stops moving its position. */
let browsingHere = false;

function show(msg: MirrorStateMessage) {
  // A move within a gallery this window does not have yet means nothing here.
  if (!msg.result && msg.url !== currentUrl) return;
  hint.hidden = true;
  applying = true;
  try {
    if (msg.result && msg.url !== currentUrl) {
      currentUrl = msg.url;
      browsingHere = false;
      const title = msg.result.title || msg.url;
      viewer.openLoading(innerWidth / 2, innerHeight / 2, settings, title, msg.index);
      viewer.fillWindow();
      // The taskbar shows which gallery this window holds.
      document.title = `${title} · LinkPeek Mirror`;
    }
    if (msg.result) viewer.show(msg.result);
    if (!browsingHere) viewer.jumpTo(msg.index);
  } finally {
    applying = false;
  }
}

/** True F11 full screen: the whole window, which may sit on another monitor. */
async function toggleFullscreen() {
  const win = await chrome.windows.getCurrent();
  await chrome.windows.update(win.id!, {state: win.state === "fullscreen" ? "normal" : "fullscreen"});
}

function onKey(event: KeyboardEvent) {
  if (event.key === "F11") {
    event.preventDefault();
    void toggleFullscreen();
    return;
  }
  if (!viewer.key(event)) return;
  event.preventDefault();
  event.stopPropagation();
}

async function start() {
  settings = await loadSettings();
  viewer.restoreViewerState({expanded: false});
  viewer.onDismiss = () => {
    currentUrl = undefined;
    hint.hidden = false;
    document.title = "LinkPeek Mirror";
  };
  viewer.onExpand = () => {
    void toggleFullscreen();
    return true;
  };
  // Settings changed elsewhere (keys, slideshow speed) apply here too.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.settings) void loadSettings().then(fresh => settings = fresh);
  });
  viewer.onPosition = () => {
    if (!applying) browsingHere = true;
  };
  viewer.onSeen = item => recordSeen(seen, item, settings);
  viewer.onRejected = forgetRejected;
  void seen.load();
  chrome.runtime.onMessage.addListener((msg: {type?: string}) => {
    if (msg?.type === "LINKPEEK_MIRROR_STATE") show(msg as MirrorStateMessage);
    return false;
  });
  document.addEventListener("keydown", onKey);
  // Tells the pages already open that a mirror is listening, so they start sending previews.
  await chrome.runtime.sendMessage({type: "LINKPEEK_MIRROR_READY"}).catch(() => undefined);
}

void start();
