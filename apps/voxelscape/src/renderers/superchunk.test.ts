// @vitest-environment node
import { describe, expect, it } from "vitest";
import { BufferGeometry } from "@random-mesh/rmsl/scene";
import {
  INDEX_UPLOAD_BYTES,
  Superchunk,
  VERTEX_UPLOAD_BYTES,
  meshUploadBytes,
  type GeometryPair,
} from "./superchunk";
import { emptyMesh, type MeshArrays } from "./mesh";
import type { Dim3 } from "../world/level-data";

/** A pair of geometries to fill, as the renderer's pool would hand over. */
const pair = (): GeometryPair => ({
  terrain: new BufferGeometry(),
  water: new BufferGeometry(),
});

/**
 * A mesh of `quads` quads at one point, enough for the arithmetic: four
 * vertices and six indices each, and the attributes a merged vertex carries.
 */
const meshOf = (quads: number, at = 0): MeshArrays => {
  const vertices = quads * 4;
  return {
    positions: new Float32Array(
      Array.from({ length: vertices * 3 }, (_, i) => at + i),
    ),
    normals: new Float32Array(vertices * 3),
    uvs: new Float32Array(vertices * 2),
    tiles: new Float32Array(vertices),
    brightness: new Float32Array(vertices).fill(1),
    indices: new Uint32Array(
      Array.from({ length: quads * 6 }, (_, i) => i % vertices),
    ),
  };
};

const meshes = (quads: number, at = 0) => ({
  terrain: meshOf(quads, at),
  water: emptyMesh(),
});

const CENTER: Dim3 = [0, 0, 0];

describe("Superchunk", () => {
  it("gives each member the run of indices its own mesh drew", () => {
    const superchunk = new Superchunk(CENTER, pair());
    superchunk.join(1, [0, 0, 0], meshes(2));
    superchunk.join(2, [64, 0, 0], meshes(3));

    // Two quads is twelve indices, three is eighteen, and the second member's
    // run starts where the first one ended.
    expect(superchunk.rangeOf(1).terrain).toEqual({ start: 0, count: 12 });
    expect(superchunk.rangeOf(2).terrain).toEqual({ start: 12, count: 18 });
    expect(superchunk.members.size).toBe(2);
    expect(superchunk.holds(1)).toBe(true);
    expect(superchunk.holds(3)).toBe(false);
  });

  it("answers an empty run for a member it does not hold", () => {
    const superchunk = new Superchunk(CENTER, pair());
    expect(superchunk.rangeOf(9).terrain).toEqual({ start: 0, count: 0 });
    expect(superchunk.rangeOf(9).water).toEqual({ start: 0, count: 0 });
  });

  it("re-origins a member's vertices against the superchunk's centre", () => {
    // A member 64 units along x, joined into a superchunk centred at the
    // origin, has to draw 64 units along x — the merged geometry is one object
    // and every member's vertices are in its space.
    const superchunk = new Superchunk([0, 0, 0], pair());
    superchunk.join(1, [64, 0, 0], meshes(1));
    superchunk.upload();
    const positions = superchunk.terrain.getAttribute("position")!;
    expect(positions.array[0]).toBeCloseTo(64);
  });

  it("owes the card everything until it uploads, and nothing after", () => {
    const superchunk = new Superchunk(CENTER, pair());
    const mesh = meshes(2);
    superchunk.join(1, [0, 0, 0], mesh);

    // Four vertices a quad and six indices, both passes counted.
    const owed = meshUploadBytes(mesh.terrain) + meshUploadBytes(mesh.water);
    expect(superchunk.pendingBytes).toBe(owed);

    expect(superchunk.upload()).toBe(owed);
    expect(superchunk.pendingBytes).toBe(0);
  });

  it("sends only what it gained since the last upload", () => {
    const superchunk = new Superchunk(CENTER, pair());
    superchunk.join(1, [0, 0, 0], meshes(2));
    superchunk.upload();

    const second = meshes(3, 100);
    superchunk.join(2, [64, 0, 0], second);
    const owed =
      meshUploadBytes(second.terrain) + meshUploadBytes(second.water);
    expect(superchunk.pendingBytes).toBe(owed);
    expect(superchunk.upload()).toBe(owed);

    // The tail is what the attribute is told to re-send: twelve vertices of the
    // second member's three quads, from where the first member's ended.
    const positions = superchunk.terrain.getAttribute("position")!;
    expect(positions.updateRange).toEqual({ offset: 8 * 3, count: 12 * 3 });
  });

  it("uploads nothing when nothing was joined since the last one", () => {
    const superchunk = new Superchunk(CENTER, pair());
    superchunk.join(1, [0, 0, 0], meshes(2));
    superchunk.upload();

    expect(superchunk.upload()).toBe(0);
    expect(superchunk.terrain.getAttribute("position")!.updateRange).toEqual({
      offset: 0,
      count: 0,
    });
  });

  it("owes a rebuild once a member's voxels have been replaced", () => {
    const superchunk = new Superchunk(CENTER, pair());
    superchunk.join(1, [0, 0, 0], meshes(2));
    expect(superchunk.owesRebuild).toBe(false);

    superchunk.replace(1);

    // The member is still a member — what is stale is the vertices behind it,
    // and only a rebuild from every member's mesh is rid of them.
    expect(superchunk.owesRebuild).toBe(true);
    expect(superchunk.holds(1)).toBe(true);
  });

  it("says nothing is owed when a member it never held is replaced", () => {
    const superchunk = new Superchunk(CENTER, pair());
    superchunk.join(1, [0, 0, 0], meshes(1));
    superchunk.replace(7);
    expect(superchunk.owesRebuild).toBe(false);
  });

  it("stops drawing a retired member at once, and owes a rebuild", () => {
    const superchunk = new Superchunk(CENTER, pair());
    superchunk.join(1, [0, 0, 0], meshes(2));
    superchunk.join(2, [64, 0, 0], meshes(3));
    superchunk.upload();

    superchunk.retire(1);

    // Nothing draws the retired member's vertices, though they are still in the
    // arrays until the rebuild — which is the cost ADR 0034's free list is for.
    expect(superchunk.rangeOf(1).terrain).toEqual({ start: 0, count: 0 });
    expect(superchunk.holds(1)).toBe(false);
    expect(superchunk.members.size).toBe(1);
    expect(superchunk.owesRebuild).toBe(true);
    // The member that stayed draws exactly what it drew before.
    expect(superchunk.rangeOf(2).terrain).toEqual({ start: 12, count: 18 });
  });

  it("joins a member once, however many times it is offered", () => {
    const superchunk = new Superchunk(CENTER, pair());
    superchunk.join(1, [0, 0, 0], meshes(2));
    superchunk.join(1, [0, 0, 0], meshes(2));
    expect(superchunk.rangeOf(1).terrain).toEqual({ start: 0, count: 12 });
    expect(superchunk.indexCount).toBe(12);
  });

  it("weighs its arrays at the capacity they grew to", () => {
    const superchunk = new Superchunk(CENTER, pair());
    const empty = superchunk.bytes;
    superchunk.join(1, [0, 0, 0], meshes(400));
    expect(superchunk.bytes).toBeGreaterThan(empty);
    // Growth doubles, so capacity is at least what was written.
    const written =
      400 * 4 * VERTEX_UPLOAD_BYTES + 400 * 6 * INDEX_UPLOAD_BYTES;
    expect(superchunk.bytes).toBeGreaterThanOrEqual(written);
  });

  it("hands its pair back with nothing in it", () => {
    const held = pair();
    const superchunk = new Superchunk(CENTER, held);
    superchunk.join(1, [0, 0, 0], meshes(2));
    superchunk.upload();
    expect(superchunk.terrain.getAttribute("position")!.count).toBeGreaterThan(
      0,
    );

    const back = superchunk.release();

    // The same geometries, so the renderer's GPU buffers for them survive, but
    // holding none of the arrays this superchunk grew.
    expect(back).toBe(held);
    expect(back.terrain.getAttribute("position")!.count).toBe(0);
    expect(back.water.getAttribute("position")!.count).toBe(0);
  });
});
