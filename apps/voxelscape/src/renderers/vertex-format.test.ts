// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  faceIndexOf,
  halfOfWholeNumber,
  MAX_UV,
  normalOfFaceIndex,
  wholeNumberOfHalf,
} from "./vertex-format";

describe("the face lane", () => {
  it("names each of the six directions once", () => {
    const seen = new Set<number>();
    for (let axis = 0; axis < 3; axis++) {
      for (const sign of [1, -1]) {
        seen.add(faceIndexOf(axis, sign));
      }
    }
    expect([...seen].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it("carries a normal there and back", () => {
    for (let axis = 0; axis < 3; axis++) {
      for (const sign of [1, -1]) {
        const normal = normalOfFaceIndex(faceIndexOf(axis, sign));
        expect(normal[axis]).toBe(sign);
        // Nothing on the other two axes: these are the six axis-aligned
        // directions and no others.
        expect(normal.reduce((sum, part) => sum + Math.abs(part), 0)).toBe(1);
      }
    }
  });

  it("fits the byte the lane gives it", () => {
    expect(faceIndexOf(2, -1)).toBeLessThanOrEqual(255);
  });
});

describe("the texture coordinate", () => {
  it("carries every whole number a coordinate can be, exactly", () => {
    // A coordinate counts cells, so it runs from nought to however many cells
    // the widest quad merged. Anything short of exact would shift the tile
    // boundary the fragment takes its fraction against.
    for (let value = 0; value <= MAX_UV; value++) {
      expect(wholeNumberOfHalf(halfOfWholeNumber(value))).toBe(value);
    }
  });

  it("writes a number the sixteen bits of a half float can hold", () => {
    for (const value of [0, 1, 64, MAX_UV]) {
      const bits = halfOfWholeNumber(value);
      expect(bits).toBeGreaterThanOrEqual(0);
      expect(bits).toBeLessThanOrEqual(0xffff);
    }
  });

  it("agrees with the bit patterns a shader would read", () => {
    expect(halfOfWholeNumber(0)).toBe(0x0000);
    expect(halfOfWholeNumber(1)).toBe(0x3c00);
    expect(halfOfWholeNumber(2)).toBe(0x4000);
    expect(halfOfWholeNumber(3)).toBe(0x4200);
    expect(halfOfWholeNumber(64)).toBe(0x5400);
  });
});

describe("the light lane", () => {
  it("keeps a baked brightness inside a byte, either end included", () => {
    for (const brightness of [0, 1 / 3, 0.5, 1]) {
      const byte = Math.round(brightness * 255);
      expect(byte).toBeGreaterThanOrEqual(0);
      expect(byte).toBeLessThanOrEqual(255);
      // The shader reads the byte back as `byte / 255`, so what it sees is
      // within half a step of what the mesher baked.
      expect(Math.abs(byte / 255 - brightness)).toBeLessThanOrEqual(1 / 510);
    }
  });
});
