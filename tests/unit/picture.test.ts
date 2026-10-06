import {describe, expect, it} from "vitest";
import {SAME_PICTURE_BITS, differenceHash, hammingDistance, isFingerprint, samePicture} from "../../src/shared/picture";

/** A 9×8 grey picture from a function of (column, row). */
const picture = (shade: (x: number, y: number) => number) => Array.from({length: 72}, (_, i) => shade(i % 9, Math.floor(i / 9)));

describe("picture fingerprints", () => {
  it("encode which pixel of each pair is brighter, as 16 hex digits", () => {
    expect(differenceHash(picture(x => 100 - x))).toBe("ffffffffffffffff");
    expect(differenceHash(picture(x => x))).toBe("0000000000000000");
    // Only the first comparison of the first row and the last of the last row are "brighter".
    const corners = picture((x, y) => (x === 0 && y === 0) || (x === 7 && y === 7) ? 10 : 0);
    expect(differenceHash(corners)).toBe("8000000000000001");
  });

  it("count the bits two fingerprints disagree on, and call a few bits the same picture", () => {
    expect(hammingDistance("ffffffffffffffff", "0000000000000000")).toBe(64);
    expect(hammingDistance("8000000000000001", "0000000000000000")).toBe(2);
    expect(hammingDistance("00000000000000ff", "000000000000000f")).toBe(4);
    expect(samePicture("0000000000000000", "000000000000003f")).toBe(SAME_PICTURE_BITS >= 6);
    expect(samePicture("0000000000000000", "00000000000000ff")).toBe(false);
  });

  it("only accept well-formed fingerprints", () => {
    expect([isFingerprint("0123456789abcdef"), isFingerprint("0123456789ABCDEF"), isFingerprint("abc"), isFingerprint(7)]).toEqual([true, false, false, false]);
  });
});
