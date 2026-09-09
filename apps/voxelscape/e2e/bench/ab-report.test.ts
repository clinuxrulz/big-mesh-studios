import { describe, expect, it } from "vitest";
import { median, powerMismatch, standsApart } from "./ab-report.ts";

describe("median", () => {
  it("takes the middle of an odd number of values", () => {
    expect(median([3, 1, 2])).toBe(2);
  });

  it("is not moved by one wild run", () => {
    expect(median([1.8, 1.9, 40])).toBe(1.9);
  });
});

describe("standsApart", () => {
  it("holds the occlusion phase's repeats apart", () => {
    expect(standsApart([0.068, 0.069, 0.1], [0.028, 0.019, 0.026])).toBe(true);
  });

  it("does not part two sets of repeats that overlap", () => {
    expect(standsApart([13.1, 13.0, 14.2], [12.9, 11.7, 15.8])).toBe(false);
  });

  it("does not part repeats that only touch at one value", () => {
    expect(standsApart([1, 2, 3], [3, 4, 5])).toBe(false);
  });

  it("parts repeats that clear each other by any margin", () => {
    expect(standsApart([1, 2, 3], [3.5, 4, 5])).toBe(true);
  });

  it("says nothing on one repeat a side, whatever the values", () => {
    expect(standsApart([1], [100])).toBe(false);
  });
});

const wall = { source: "wall" as const, charge: 1, lowPower: false };
const battery = { source: "battery" as const, charge: 1, lowPower: false };

describe("powerMismatch", () => {
  it("says nothing when both were measured on the wall", () => {
    expect(
      powerMismatch(
        { commit: "abc1234", power: [wall, wall] },
        { commit: "def5678", power: [wall, wall] },
      ),
    ).toBeNull();
  });

  it("names both sides when one was on the battery", () => {
    const said = powerMismatch(
      { commit: "abc1234", power: [battery] },
      { commit: "def5678", power: [wall] },
    );
    expect(said).toContain("abc1234 on the battery at 100%");
    expect(said).toContain("def5678 on the wall");
    expect(said).toContain("stand as they were measured");
  });

  it("catches the power changing between rounds of one side", () => {
    expect(
      powerMismatch(
        { commit: "abc1234", power: [wall, battery] },
        { commit: "def5678", power: [wall, wall] },
      ),
    ).not.toBeNull();
  });

  it("says nothing about a run nothing was recorded for", () => {
    expect(
      powerMismatch(
        { commit: "abc1234", power: [] },
        { commit: "def5678", power: [] },
      ),
    ).toBeNull();
  });
});
