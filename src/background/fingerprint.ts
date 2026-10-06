/**
 * Makes picture fingerprints (see shared/picture.ts) in the service worker,
 * which can read any site's images: fetch, decode shrunk to 9×8, hash.
 */
import {fetchWithRetry, readBytesCapped} from "../core/http";
import {differenceHash} from "../shared/picture";

const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
const CONCURRENCY = 4;
const MEMORY = 5000;

/** Decodes a picture to its fingerprint; undefined for anything that is not a decodable raster image. */
export async function fingerprintOf(bytes: ArrayBuffer, type: string) {
  if (!type.startsWith("image/") || type.includes("svg")) return undefined;
  const bitmap = await createImageBitmap(new Blob([bytes], {type}), {resizeWidth: 9, resizeHeight: 8, resizeQuality: "medium"});
  const canvas = new OffscreenCanvas(9, 8), context = canvas.getContext("2d")!;
  context.drawImage(bitmap, 0, 0);
  bitmap.close();
  const {data} = context.getImageData(0, 0, 9, 8), grey = new Array<number>(72);
  for (let i = 0; i < 72; i++) grey[i] = data[i * 4] * 0.299 + data[i * 4 + 1] * 0.587 + data[i * 4 + 2] * 0.114;
  return differenceHash(grey);
}

/** Fingerprints pictures by address, a few at a time, remembering recent answers. */
export class Fingerprinter {
  private known = new Map<string, Promise<string | undefined>>();
  private active = 0;
  private waiting: Array<() => void> = [];

  print(url: string) {
    if (!url) return Promise.resolve(undefined);
    let answer = this.known.get(url);
    if (!answer) {
      answer = this.compute(url);
      this.known.set(url, answer);
      while (this.known.size > MEMORY) this.known.delete(this.known.keys().next().value!);
    }
    return answer;
  }

  private async compute(url: string) {
    while (this.active >= CONCURRENCY) await new Promise<void>(resolve => this.waiting.push(resolve));
    this.active++;
    // Unreadable or not a picture: its address alone identifies it.
    const print = await this.read(url).catch(() => undefined);
    this.active--;
    this.waiting.shift()?.();
    return print;
  }

  private async read(url: string) {
    const {bytes, type} = await fetchWithRetry(url, {credentials: "include"}, {mode: "background", timeoutMs: 10_000, read: async response => {
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return {bytes: await readBytesCapped(response, MAX_IMAGE_BYTES, "Too large to fingerprint"), type: (response.headers.get("content-type") ?? "").toLowerCase()};
    }});
    return fingerprintOf(bytes, type);
  }
}
