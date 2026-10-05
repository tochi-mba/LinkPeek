/** Messages exchanged between the content script, the service worker and the popup. */
import type {LinkKind, ScanResult} from "./media";
import type {PerformanceMode} from "./settings";

export type ScanRequest = {type: "LINKPEEK_SCAN"; url: string; kind: LinkKind; token: string};
export type PrefetchRequest = {type: "LINKPEEK_PREFETCH"; url: string; kind: LinkKind; deep: boolean};
export type CancelScanRequest = {type: "LINKPEEK_CANCEL_SCAN"; url: string; token: string};
export type FetchBinaryRequest = {type: "LINKPEEK_FETCH_BINARY"; url: string; maxMb: number};
export type DownloadRequest = {type: "LINKPEEK_DOWNLOAD"; url: string; filename?: string};
/** Every original of a gallery, into one folder in the downloads directory. */
export type DownloadAllRequest = {type: "LINKPEEK_DOWNLOAD_ALL"; folder: string; items: Array<{url: string; filename: string}>};
/** Opens a URL in a new tab next to the current one, in the background unless `active`. */
export type OpenTabRequest = {type: "LINKPEEK_OPEN_TAB"; url: string; active?: boolean};
export type ClearCacheRequest = {type: "LINKPEEK_CLEAR_CACHE"};

export type BackgroundRequest = ScanRequest | PrefetchRequest | CancelScanRequest | FetchBinaryRequest | DownloadRequest | DownloadAllRequest | OpenTabRequest | ClearCacheRequest;

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
