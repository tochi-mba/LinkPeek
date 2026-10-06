/** Messages exchanged between the content script, the service worker and the popup. */
import type {LinkKind, ScanResult} from "./media";
import type {HistoryEntry} from "./history";
import type {PerformanceMode} from "./settings";

/** `linked`: also search the pages it links to, because the page's own media all turned out too small. */
export type ScanRequest = {type: "LINKPEEK_SCAN"; url: string; kind: LinkKind; token: string; linked?: boolean};
export type PrefetchRequest = {type: "LINKPEEK_PREFETCH"; url: string; kind: LinkKind; deep: boolean};
export type CancelScanRequest = {type: "LINKPEEK_CANCEL_SCAN"; url: string; token: string};
export type FetchBinaryRequest = {type: "LINKPEEK_FETCH_BINARY"; url: string; maxMb: number};
export type DownloadRequest = {type: "LINKPEEK_DOWNLOAD"; url: string; filename?: string};
/** Every original of a gallery, into one folder in the downloads directory. */
export type DownloadAllRequest = {type: "LINKPEEK_DOWNLOAD_ALL"; folder: string; items: Array<{url: string; filename: string}>};
/** Opens a URL in a new tab next to the current one, in the background unless `active`. */
export type OpenTabRequest = {type: "LINKPEEK_OPEN_TAB"; url: string; active?: boolean};
export type ClearCacheRequest = {type: "LINKPEEK_CLEAR_CACHE"};
/** Settings page: how many galleries are saved on the device, or forget them all. */
export type GalleryStatsRequest = {type: "LINKPEEK_GALLERY_STATS"};
/** A page saw an item for the first time: add it to the history and the saved media, as each is on. */
export type HistoryAddRequest = {type: "LINKPEEK_HISTORY_ADD"; entry: HistoryEntry};
export type HistoryClearRequest = {type: "LINKPEEK_HISTORY_CLEAR"};
/** Settings page: how much saved media there is, or delete it all. */
export type LibraryStatsRequest = {type: "LINKPEEK_LIBRARY_STATS"};
export type LibraryClearRequest = {type: "LINKPEEK_LIBRARY_CLEAR"};
/** From a page (which cannot open extension pages itself): open the library, on a view. */
export type OpenLibraryRequest = {type: "LINKPEEK_OPEN_LIBRARY"; view?: "seen" | "saved"; filter?: "all" | "unseen" | "seen"};
/** Picture fingerprints for these addresses (null where a picture could not be read). */
export type FingerprintRequest = {type: "LINKPEEK_FINGERPRINT"; urls: string[]};
export type ForgetGalleriesRequest = {type: "LINKPEEK_FORGET_GALLERIES"};

export type BackgroundRequest = ScanRequest | PrefetchRequest | CancelScanRequest | FetchBinaryRequest | DownloadRequest | DownloadAllRequest | OpenTabRequest | ClearCacheRequest
  | ToggleMirrorRequest | MirrorReadyRequest | MirrorQueryRequest | GalleryStatsRequest | ForgetGalleriesRequest | FingerprintRequest
  | HistoryAddRequest | HistoryClearRequest | LibraryStatsRequest | LibraryClearRequest | OpenLibraryRequest;

/** Sent by the service worker while a long scan is still running. */
export type ScanProgress = {type: "LINKPEEK_SCAN_PROGRESS"; token: string; url: string; result: ScanResult};

/** Asked by the popup; answered by the content script of the active tab. */
export type StatusRequest = {type: "LINKPEEK_STATUS"};
/** Sent by the popup to show or hide the preload inspector on the active tab. */
export type ToggleInspectorRequest = {type: "LINKPEEK_TOGGLE_INSPECTOR"};
/** From the toolbar popup: start the shuffle slideshow on this page. */
export type StartShuffleRequest = {type: "LINKPEEK_START_SHUFFLE"};

export type ScanResponse = ScanResult | {error: string} | {cancelled: true};
export type BinaryResponse = {base64: string; mime: string; bytes: number} | {error: string};

export interface TabStatus {
  enabled: boolean;
  mode: PerformanceMode;
  /** 0 to 1: how much of the device-sized budget is currently in use. */
  headroom: number;
  /** Why LinkPeek is easing off, when it is. */
  reason?: string;
  tier: "light" | "standard" | "high";
  prepared: number;
  inspectorOpen: boolean;
}

/** From the toolbar popup: open the mirror window, or close the one that is open. */
export type ToggleMirrorRequest = {type: "LINKPEEK_TOGGLE_MIRROR"};
/** From the mirror window once it is listening. */
export type MirrorReadyRequest = {type: "LINKPEEK_MIRROR_READY"};
/** From a page at load: is a mirror window open right now? */
export type MirrorQueryRequest = {type: "LINKPEEK_MIRROR_QUERY"};
/** Background -> tabs: whether a mirror window is listening, so pages only send previews while one is. */
export type MirrorOpenMessage = {type: "LINKPEEK_MIRROR_OPEN"; open: boolean};
/** Content -> the mirror window: the gallery and position on screen right now. */
/**
 * Content -> the mirror window: the gallery and position on screen. `result`
 * is sent only when the gallery changed (new, grown or finished); a move
 * within it sends the position alone.
 */
export type MirrorStateMessage = {type: "LINKPEEK_MIRROR_STATE"; url: string; index: number; result?: ScanResult};
