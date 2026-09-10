// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  boxContains,
  boxGroundAt,
  solidBoxAt,
  type SolidBox,
} from "./prop-collision";

const bed: SolidBox = {
  minX: -1,
  maxX: 1,
  minY: 0,
  maxY: 1,
  minZ: -2,
  maxZ: 2,
};

describe("prop collision", () => {
  it("contains a point inside the box and not outside it", () => {
    expect(boxContains(bed, 0, 0.5, 0)).toBe(true);
    expect(boxContains(bed, 0, 1.5, 0)).toBe(false);
    expect(boxContains(bed, 2, 0.5, 0)).toBe(false);
  });

  it("reports solid where any box stands", () => {
    expect(solidBoxAt([bed], 0, 0.5, 0)).toBe(true);
    expect(solidBoxAt([bed], 0, 0.5, 5)).toBe(false);
    expect(solidBoxAt([], 0, 0.5, 0)).toBe(false);
  });

  it("finds the highest box top at or below the feet", () => {
    const table: SolidBox = { ...bed, maxY: 2 };
    expect(boxGroundAt([bed, table], 0, 2, 0)).toBe(2);
    expect(boxGroundAt([bed, table], 0, 1, 0)).toBe(1);
    // Over nothing: no ground.
    expect(boxGroundAt([bed], 5, 1, 5)).toBe(-Infinity);
  });
});
