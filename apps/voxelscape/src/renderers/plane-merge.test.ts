// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  SlicePlane,
  type FaceLight,
  type MergedRectangle,
} from "./plane-merge";

/** Every rectangle a plane covers itself with, in the order it finds them. */
const rectanglesOf = (plane: SlicePlane): MergedRectangle[] => {
  const found: MergedRectangle[] = [];
  plane.eachRectangle((rectangle) => found.push(rectangle));
  return found;
};

/** A face lit the same on all four corners, with no block light. */
const flat = (value: number): FaceLight => ({
  sky: [value, value, value, value],
  block: [0, 0, 0, 0],
});

describe("SlicePlane", () => {
  it("covers nothing when nothing was set", () => {
    expect(rectanglesOf(new SlicePlane(4, 4))).toEqual([]);
  });

  it("takes a row of matching faces as one wide rectangle", () => {
    const plane = new SlicePlane(4, 4);
    for (let first = 0; first < 3; first++) {
      plane.set(first, 0, 7, flat(1));
    }
    expect(rectanglesOf(plane)).toEqual([
      { first: 0, second: 0, wide: 3, tall: 1, id: 7, sky: 1, block: 0 },
    ]);
  });

  it("grows a rectangle across rows that match along its whole width", () => {
    const plane = new SlicePlane(4, 4);
    for (let second = 0; second < 3; second++) {
      for (let first = 0; first < 2; first++) {
        plane.set(first, second, 7, flat(1));
      }
    }
    expect(rectanglesOf(plane)).toEqual([
      { first: 0, second: 0, wide: 2, tall: 3, id: 7, sky: 1, block: 0 },
    ]);
  });

  it("stops a rectangle at a row that is only partly filled", () => {
    const plane = new SlicePlane(4, 4);
    plane.set(0, 0, 7, flat(1));
    plane.set(1, 0, 7, flat(1));
    plane.set(0, 1, 7, flat(1));
    const found = rectanglesOf(plane);
    expect(found).toHaveLength(2);
    expect(found[0]).toMatchObject({ wide: 2, tall: 1 });
    expect(found[1]).toMatchObject({ first: 0, second: 1, wide: 1, tall: 1 });
  });

  it("keeps faces of different voxels apart", () => {
    const plane = new SlicePlane(4, 4);
    plane.set(0, 0, 7, flat(1));
    plane.set(1, 0, 9, flat(1));
    expect(rectanglesOf(plane).map((one) => one.id)).toEqual([7, 9]);
  });

  it("keeps faces lit differently apart", () => {
    const plane = new SlicePlane(4, 4);
    plane.set(0, 0, 7, flat(1));
    plane.set(1, 0, 7, flat(0.5));
    expect(rectanglesOf(plane).map((one) => one.sky)).toEqual([1, 0.5]);
  });

  it("leaves a face that is not shaded flat on its own, for the caller to draw", () => {
    const plane = new SlicePlane(4, 4);
    plane.set(0, 0, 7, flat(1));
    plane.set(1, 0, 7, { sky: [1, 1, 0.5, 1], block: [0, 0, 0, 0] });
    plane.set(2, 0, 7, flat(1));
    const found = rectanglesOf(plane);
    expect(found).toHaveLength(3);
    expect(found.map((one) => one.sky)).toEqual([1, null, 1]);
    expect(found.every((one) => one.wide === 1 && one.tall === 1)).toBe(true);
  });

  it("keeps faces apart when only their block light differs", () => {
    const plane = new SlicePlane(4, 4);
    plane.set(0, 0, 7, flat(1));
    plane.set(1, 0, 7, { sky: [1, 1, 1, 1], block: [0.8, 0.8, 0.8, 0.8] });
    expect(rectanglesOf(plane)).toEqual([
      { first: 0, second: 0, wide: 1, tall: 1, id: 7, sky: 1, block: 0 },
      { first: 1, second: 0, wide: 1, tall: 1, id: 7, sky: 1, block: 0.8 },
    ]);
  });

  it("treats an unlit plane as flat, so a world without light still merges", () => {
    const plane = new SlicePlane(4, 4);
    plane.set(0, 0, 7, null);
    plane.set(1, 0, 7, null);
    expect(rectanglesOf(plane)).toEqual([
      { first: 0, second: 0, wide: 2, tall: 1, id: 7, sky: 1, block: 0 },
    ]);
  });

  it("covers every face exactly once", () => {
    const plane = new SlicePlane(5, 5);
    const shades = [1, 1, 0.5, 1, 0.25];
    for (let second = 0; second < 5; second++) {
      for (let first = 0; first < 5; first++) {
        plane.set(first, second, 3, flat(shades[(first + second) % 5]));
      }
    }
    let covered = 0;
    for (const rectangle of rectanglesOf(plane)) {
      covered += rectangle.wide * rectangle.tall;
    }
    expect(covered).toBe(25);
  });

  it("forgets a slice when it is cleared for the next one", () => {
    const plane = new SlicePlane(4, 4);
    plane.set(0, 0, 7, flat(1));
    rectanglesOf(plane);
    plane.clear();
    expect(rectanglesOf(plane)).toEqual([]);
  });
});
