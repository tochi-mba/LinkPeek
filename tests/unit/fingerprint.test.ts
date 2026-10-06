import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {Fingerprinter, fingerprintOf} from "../../src/background/fingerprint";

let pixels: Uint8ClampedArray, closed: number;

beforeEach(() => {
  closed = 0;
  // A picture brighter on the left: every comparison says "brighter".
  pixels = new Uint8ClampedArray(72 * 4).map((_, i) => 250 - (Math.floor(i / 4) % 9) * 20);
  vi.stubGlobal("createImageBitmap", vi.fn(async () => ({close: () => closed++})));
  vi.stubGlobal("OffscreenCanvas", class {
    getContext() {
      return {drawImage: vi.fn(), getImageData: () => ({data: pixels})};
    }
  });
});
afterEach(() => vi.unstubAllGlobals());

const image = (type = "image/jpeg", status = 200) => new Response(new Uint8Array([1, 2, 3]), {status, headers: {"content-type": type}});

describe("fingerprinting a picture", () => {
  it("shrinks it to 9×8 grey and hashes it, but leaves vector and non-pictures alone", async () => {
    expect(await fingerprintOf(new ArrayBuffer(3), "image/jpeg")).toBe("ffffffffffffffff");
    expect(createImageBitmap).toHaveBeenCalledWith(expect.any(Blob), {resizeWidth: 9, resizeHeight: 8, resizeQuality: "medium"});
    expect(closed).toBe(1);
    expect(await fingerprintOf(new ArrayBuffer(3), "image/svg+xml")).toBeUndefined();
    expect(await fingerprintOf(new ArrayBuffer(3), "text/html")).toBeUndefined();
  });
});

describe("the fingerprinter", () => {
  it("fetches each address once, a few at a time, and gives up quietly on failures", async () => {
    let active = 0, peak = 0;
    const fetch = vi.fn(async (url: string) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise(resolve => setTimeout(resolve, 1));
      active--;
      return url.includes("broken") ? image("image/jpeg", 404) : url.includes("page") ? image("text/html") : image();
    });
    vi.stubGlobal("fetch", fetch);
    const printer = new Fingerprinter();
    const urls = Array.from({length: 8}, (_, i) => `https://cdn.test/${i}.jpg`);
    const prints = await Promise.all([...urls, urls[0], "https://cdn.test/broken.jpg", "https://cdn.test/page", ""].map(url => printer.print(url)));
    expect(prints.slice(0, 9)).toEqual(Array(9).fill("ffffffffffffffff"));
    expect(prints.slice(9)).toEqual([undefined, undefined, undefined]);
    expect(fetch).toHaveBeenCalledTimes(10);
    expect(peak).toBeLessThanOrEqual(4);
  });

  it("forgets the oldest answers past its memory", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => image()));
    const printer = new Fingerprinter();
    for (let i = 0; i <= 5000; i++) void printer.print(`https://cdn.test/${i}.jpg`);
    await printer.print("https://cdn.test/0.jpg");
    expect(fetch).toHaveBeenCalledTimes(5002);
  }, 60_000);
});
