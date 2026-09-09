import { describe, expect, it } from "vitest";
import { lateFrames, uploadsOverBudget } from "./late.ts";
import type { RunSamples } from "../report.ts";

const fieldNames = ["gapMs", "uploadBytes", "merges"];
const phaseNames = ["merge", "draw", "advance"];

/** A run of frames, each given as its fields and then its phases. */
const samplesOf = (frames: number[][]): RunSamples => ({
  rows: frames.flat(),
  rowStride: fieldNames.length + phaseNames.length,
  fieldNames,
  phaseNames,
});

//                       gap  upload    merges  merge  draw  advance
const quiet = [16.7, 0, 0, 0.1, 0.9, 1.2];
const janky = [33.4, 5 * 1024 * 1024, 1, 10.7, 6.6, 27.6];
const middling = [16.7, 1024, 1, 4.5, 1.1, 4.9];

describe("lateFrames", () => {
  it("keeps only the frames that went over the budget", () => {
    const late = lateFrames(samplesOf([quiet, janky, quiet]), 16.7, 8);
    expect(late).toHaveLength(1);
    expect(late[0].mainMs).toBeCloseTo(44.9);
    expect(late[0].merges).toBe(1);
    expect(late[0].uploadBytes).toBe(5 * 1024 * 1024);
  });

  it("puts the costliest frame first", () => {
    const late = lateFrames(samplesOf([middling, janky]), 5, 8);
    expect(late[0].mainMs).toBeGreaterThan(late[1].mainMs);
  });

  it("names the phases that took the time, longest first", () => {
    const [late] = lateFrames(samplesOf([janky]), 16.7, 8);
    expect(late.spent.map((phase) => phase.name)).toEqual([
      "advance",
      "merge",
      "draw",
    ]);
  });

  it("places a frame in the run by the gaps before it", () => {
    const [late] = lateFrames(samplesOf([quiet, quiet, janky]), 16.7, 8);
    expect(late.at).toBeCloseTo((16.7 + 16.7 + 33.4) / 1000);
  });

  it("returns no more than it was asked for", () => {
    const late = lateFrames(samplesOf([janky, janky, janky]), 16.7, 2);
    expect(late).toHaveLength(2);
  });

  it("finds nothing in a run that never went over", () => {
    expect(lateFrames(samplesOf([quiet, quiet]), 16.7, 8)).toEqual([]);
  });
});

describe("uploadsOverBudget", () => {
  it("counts the frames that sent more than one frame's worth", () => {
    expect(
      uploadsOverBudget(samplesOf([quiet, janky, middling]), 2 * 1024 * 1024),
    ).toBe(1);
  });

  it("counts none in a run that uploaded nothing", () => {
    expect(uploadsOverBudget(samplesOf([quiet, quiet]), 2 * 1024 * 1024)).toBe(
      0,
    );
  });
});
