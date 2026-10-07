/**
 * Still frames for GIF and video tiles in the Library, so moving media shows
 * a picture of itself without playing until the pointer rests on it.
 *
 * A GIF's still is its first frame. A video's is a frame from a stable
 * "random" point 5 to 35 percent of the way in, chosen from its address, so
 * it is the same every time and usually past a black opening. Stills are
 * scaled down and encoded as JPEG; the page caches them on this device.
 */

/** Stills are scaled so their longer side is at most this. */
const MAX_EDGE = 640;
/** A clip that has not shown a frame by now is given up on. */
const VIDEO_TIMEOUT_MS = 15_000;

/** A stable point in a clip, as a share of its length, from its address. */
export function framePoint(url: string) {
  let hash = 2166136261;
  for (let at = 0; at < url.length; at++) {
    hash ^= url.charCodeAt(at);
    hash = Math.imul(hash, 16777619);
  }
  return 0.05 + ((hash >>> 0) % 1000) / 1000 * 0.3;
}

/**
 * Draws a frame scaled down and encodes it. Rejects — never throws — when the
 * frame cannot be read back (a cross-origin source taints the canvas).
 */
async function encode(source: CanvasImageSource, width: number, height: number): Promise<Blob> {
  const scale = Math.min(1, MAX_EDGE / Math.max(width, height, 1));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  canvas.getContext("2d")!.drawImage(source, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error("No still")), "image/jpeg", 0.82));
}

/** The first frame of a GIF (or of any picture). */
export async function gifStill(bytes: Blob) {
  const bitmap = await createImageBitmap(bytes);
  try {
    return await encode(bitmap, bitmap.width, bitmap.height);
  } finally {
    bitmap.close();
  }
}

/** A frame from a video at its stable point; rejects when the clip cannot be read in time. */
export function videoStill(src: string, key: string, timeoutMs = VIDEO_TIMEOUT_MS): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const video = document.createElement("video");
    video.muted = true;
    video.preload = "auto";
    const finish = (error: Error | undefined, blob?: Blob) => {
      clearTimeout(timer);
      video.removeAttribute("src");
      if (error) reject(error);
      else resolve(blob!);
    };
    const timer = setTimeout(() => finish(new Error("Timed out")), timeoutMs);
    video.addEventListener("loadedmetadata", () => {
      video.currentTime = Number.isFinite(video.duration) ? video.duration * framePoint(key) : 0;
    }, {once: true});
    video.addEventListener("seeked", () => {
      encode(video, video.videoWidth, video.videoHeight).then(blob => finish(undefined, blob), finish);
    }, {once: true});
    video.addEventListener("error", () => finish(new Error("Unreadable video")), {once: true});
    video.src = src;
  });
}
