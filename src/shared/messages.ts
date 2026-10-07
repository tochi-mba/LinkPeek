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
/** Library page: opening a saved file marks that existing row seen, independently of offline-save settings. */
export type LibrarySeenRequest = {type: "LINKPEEK_LIBRARY_SEEN"; url: string};
/** Library page: index existing files from Downloads / LinkPeek / Tumblr. */
export type TumblrImportsRequest = {type: "LINKPEEK_TUMBLR_IMPORTS"};
/** Library viewer: reveal an existing file in the operating system's file browser. */
export type ShowDownloadRequest = {type: "LINKPEEK_DOWNLOAD_SHOW"; id: number};
/** Library page: measure every saved file, drop ones below the minimums, and fill in missing Downloads copies. */
export type LibraryAuditRequest = {type: "LINKPEEK_LIBRARY_AUDIT"};
/** Worker -> the library page: the check moved along, through the saved files and then the history. */
export type AuditTickMessage = {type: "LINKPEEK_AUDIT_TICK"; phase: "files" | "history"; checked: number; total: number; removed: number; mirrored: number; url: string; resting: number};
/** A page's preview found this media too small after showing it: take back its history entries and saved file. */
export type ForgetMediaRequest = {type: "LINKPEEK_FORGET_MEDIA"; original: string; saved: string};
/** Library page: forget these saved files - bytes, index entries and Downloads copies. */
export type LibraryRemoveRequest = {type: "LINKPEEK_LIBRARY_REMOVE"; urls: string[]};
/** Library page: strike these entries (matched by time and address) from the history. */
export type HistoryRemoveRequest = {type: "LINKPEEK_HISTORY_REMOVE"; entries: Array<{a: number; o: string}>};
/** From a page (which cannot open extension pages itself): open the library, on a view. */
export type OpenLibraryRequest = {type: "LINKPEEK_OPEN_LIBRARY"; view?: "seen" | "saved"; filter?: "all" | "unseen" | "seen"};
/** Picture fingerprints for these addresses (null where a picture could not be read). */
export type FingerprintRequest = {type: "LINKPEEK_FINGERPRINT"; urls: string[]};
export type ForgetGalleriesRequest = {type: "LINKPEEK_FORGET_GALLERIES"};

export type TumblrPhase = "collecting" | "done" | "stopped" | "failed";
/** Progress for the Tumblr blog download shown in the toolbar popup. */
export interface TumblrJobState {
  blog: string;
  phase: TumblrPhase;
  posts: number;
  total: number;
  found: number;
  saved: number;
  failed: number;
  skipped: number;
  collected: boolean;
  error?: string;
  /** Blogs waiting behind this one, in order. */
  queue?: string[];
}
export type TumblrStatusRequest = {type: "LINKPEEK_TUMBLR_STATUS"};
export type TumblrStartRequest = {type: "LINKPEEK_TUMBLR_START"; blog: string};
export type TumblrStopRequest = {type: "LINKPEEK_TUMBLR_STOP"};
export type TumblrRemoveQueuedRequest = {type: "LINKPEEK_TUMBLR_REMOVE_QUEUED"; blog: string};
export type TumblrClearQueueRequest = {type: "LINKPEEK_TUMBLR_CLEAR_QUEUE"};

export type BackgroundRequest = ScanRequest | PrefetchRequest | CancelScanRequest | FetchBinaryRequest | DownloadRequest | DownloadAllRequest | OpenTabRequest | ClearCacheRequest
  | ToggleMirrorRequest | MirrorReadyRequest | MirrorQueryRequest | GalleryStatsRequest | ForgetGalleriesRequest | FingerprintRequest
  | HistoryAddRequest | HistoryClearRequest | LibraryStatsRequest | LibraryClearRequest | LibrarySeenRequest | TumblrImportsRequest | ShowDownloadRequest | LibraryAuditRequest | OpenLibraryRequest
  | LibraryRemoveRequest | HistoryRemoveRequest | ForgetMediaRequest | TumblrStatusRequest | TumblrStartRequest | TumblrStopRequest
  | TumblrRemoveQueuedRequest | TumblrClearQueueRequest;

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
