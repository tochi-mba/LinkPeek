/**
 * Picture fingerprint arithmetic, shared by the service worker (which makes
 * fingerprints) and pages (which compare them against what was seen).
 *
 * A fingerprint is a 64-bit difference hash written as 16 hex digits: each bit
 * says whether a pixel of the picture shrunk to 9×8 grey is brighter than its
 * right-hand neighbour. Copies of a picture at another address, size or
 * quality land within a few bits of each other.
 */

/** Copies differ in at most this many of the 64 bits; different pictures in dozens. */
export const SAME_PICTURE_BITS = 6;

/** The hash of 9×8 grey values (row by row). */
export function differenceHash(grey: ArrayLike<number>) {
  let high = 0, low = 0;
  for (let row = 0; row < 8; row++) {
    for (let column = 0; column < 8; column++) {
      const bit = grey[row * 9 + column] > grey[row * 9 + column + 1] ? 1 : 0, index = row * 8 + column;
      if (index < 32) high = (high | (bit << (31 - index))) >>> 0;
      else low = (low | (bit << (63 - index))) >>> 0;
    }
  }
  return high.toString(16).padStart(8, "0") + low.toString(16).padStart(8, "0");
}

function popcount(value: number) {
  value -= (value >>> 1) & 0x55555555;
  value = (value & 0x33333333) + ((value >>> 2) & 0x33333333);
  return (((value + (value >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}

/** How many of the 64 bits two fingerprints disagree on. */
export function hammingDistance(a: string, b: string) {
  return popcount((parseInt(a.slice(0, 8), 16) ^ parseInt(b.slice(0, 8), 16)) >>> 0) + popcount((parseInt(a.slice(8), 16) ^ parseInt(b.slice(8), 16)) >>> 0);
}

export function samePicture(a: string, b: string) {
  return hammingDistance(a, b) <= SAME_PICTURE_BITS;
}

/** Whether a fingerprint is shaped right (pages and storage are not trusted blindly). */
export function isFingerprint(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{16}$/.test(value);
}
