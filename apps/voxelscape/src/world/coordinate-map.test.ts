// @vitest-environment node
import { describe, expect, it } from "vitest";
import { CoordinateMap } from "./coordinate-map";

/**
 * A spread of coordinates wide enough to fill a table several times over and
 * to collide inside it, so a probe run is more than one slot long.
 */
const spread = (count: number): [number, number, number][] => {
  const out: [number, number, number][] = [];
  for (let i = 0; i < count; i++) {
    out.push([i % 7, Math.floor(i / 7) % 5, i]);
  }
  return out;
};

describe("CoordinateMap", () => {
  it("reads back what it was given, at negative coordinates too", () => {
    const map = new CoordinateMap<string>();
    map.set(1, 2, 3, "a");
    map.set(-4, -5, -6, "b");
    expect(map.get(1, 2, 3)).toBe("a");
    expect(map.get(-4, -5, -6)).toBe("b");
    expect(map.get(1, 2, 4)).toBeUndefined();
    expect(map.size).toBe(2);
  });

  it("replaces a value at a coordinate it already holds", () => {
    const map = new CoordinateMap<string>();
    map.set(1, 2, 3, "first");
    map.set(1, 2, 3, "second");
    expect(map.get(1, 2, 3)).toBe("second");
    expect(map.size).toBe(1);
  });

  it("says whether a delete removed anything", () => {
    const map = new CoordinateMap<string>();
    map.set(1, 2, 3, "a");
    expect(map.delete(1, 2, 3)).toBe(true);
    expect(map.delete(1, 2, 3)).toBe(false);
    expect(map.get(1, 2, 3)).toBeUndefined();
    expect(map.size).toBe(0);
  });

  it("keeps every other entry findable after a delete", () => {
    const coordinates = spread(400);
    const map = new CoordinateMap<number>();
    coordinates.forEach((c, at) => map.set(c[0], c[1], c[2], at));

    // Every third, so the survivors are scattered through the probe runs the
    // removed ones were part of rather than sitting in one block.
    const removed = coordinates.filter((_, at) => at % 3 === 0);
    for (const c of removed) {
      expect(map.delete(c[0], c[1], c[2])).toBe(true);
    }
    expect(map.size).toBe(coordinates.length - removed.length);

    coordinates.forEach((c, at) => {
      expect(map.get(c[0], c[1], c[2])).toBe(at % 3 === 0 ? undefined : at);
    });
  });

  it("reuses the room a removed entry held", () => {
    const coordinates = spread(200);
    const map = new CoordinateMap<number>();
    coordinates.forEach((c, at) => map.set(c[0], c[1], c[2], at));
    for (const c of coordinates) {
      map.delete(c[0], c[1], c[2]);
    }
    expect(map.size).toBe(0);

    coordinates.forEach((c, at) => map.set(c[0], c[1], c[2], at * 2));
    expect(map.size).toBe(coordinates.length);
    coordinates.forEach((c, at) => {
      expect(map.get(c[0], c[1], c[2])).toBe(at * 2);
    });
  });

  it("visits the entries that are left, and no others", () => {
    const coordinates = spread(100);
    const map = new CoordinateMap<number>();
    coordinates.forEach((c, at) => map.set(c[0], c[1], c[2], at));
    for (const c of coordinates.filter((_, at) => at % 2 === 0)) {
      map.delete(c[0], c[1], c[2]);
    }

    const seen: number[] = [];
    map.forEach((_x, _y, _z, value) => seen.push(value));
    expect(seen.sort((a, b) => a - b)).toEqual(
      coordinates.map((_, at) => at).filter((at) => at % 2 === 1),
    );
  });
});
