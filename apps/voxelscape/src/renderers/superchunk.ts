// One superchunk's merged geometry: the six attribute arrays every member
// block's vertices are joined into, each member's run of indices, how much of
// all that the graphics card already holds, and the pair of geometries it
// uploads into.
//
// Members join, are replaced when their voxels change, and retire when the
// window moves their slot to another cell. What a `Superchunk` does not know is
// where it sits or when it should merge: the region is a superchunk cell
// addressed by a key, and `TriangleRenderer` owns which cells have geometry,
// which of them are due, and what a frame is allowed to upload.
//
// A retired member's vertices are harmless the moment its run stops being drawn
// — nothing indexes them — so what retiring has to do is give the space back.
// The room it leaves is kept as a free run, and the next member that fits writes
// into it. That is what keeps the arrays from growing for the life of a walk, and
// it is why nothing here is ever rebuilt from every member: the alternative, and
// what this replaced, was throwing the arrays away and re-joining all eight,
// which sent the whole superchunk to the card again — half of every merge on a
// phone, and the frames it dropped.
//
// An upload sends the runs written since the last one, which is a slice in the
// middle when a freed run was filled and a tail when the arrays grew.
import { BufferAttribute, BufferGeometry } from "@random-mesh/rmsl/scene";
import { Growable } from "./growable";
import { setGeometryData, type MeshArrays, type Span } from "./mesh";
import type { Dim3 } from "../world/level-data";

/**
 * A superchunk's pair of upload geometries, one per draw pass. Kept stable for
 * the life of the `Superchunk` filling it and recycled between superchunks: the
 * renderer keys its GPU buffers by geometry object, so filling a pooled pair
 * again refills the buffers it already has instead of allocating another set.
 */
export interface GeometryPair {
  terrain: BufferGeometry;
  water: BufferGeometry;
}

/** A run of indices in the merged geometry: what one member's mesh draws. */
export interface IndexRange {
  start: number;
  count: number;
}

/** A member's runs in both passes. A member with no water draws an empty one. */
export interface MemberRanges {
  terrain: IndexRange;
  water: IndexRange;
}

/** The bytes one vertex of merged geometry adds to an upload. */
export const VERTEX_UPLOAD_BYTES = 40;

/** The bytes one index of merged geometry adds to an upload. */
export const INDEX_UPLOAD_BYTES = 4;

/** A range that holds nothing: what a member this superchunk does not hold draws. */
const EMPTY_RANGE: IndexRange = { start: 0, count: 0 };

/**
 * The accumulating vertex arrays of one pass, typed so a landed member can be
 * appended without re-joining the whole superchunk and without a boxed
 * intermediate.
 */
interface MergedArrays {
  positions: Growable<Float32Array>;
  normals: Growable<Float32Array>;
  uvs: Growable<Float32Array>;
  /** One number a vertex: the sheet tile its repeating texture wraps into. */
  tiles: Growable<Float32Array>;
  indices: Growable<Uint32Array>;
  /** One 0..1 brightness a vertex, carried from the per-block bake. */
  brightness: Growable<Float32Array>;
}

const emptyArrays = (): MergedArrays => ({
  positions: new Growable(Float32Array),
  normals: new Growable(Float32Array),
  uvs: new Growable(Float32Array),
  tiles: new Growable(Float32Array),
  indices: new Growable(Uint32Array),
  brightness: new Growable(Float32Array),
});

/**
 * Room a retired member left: where its vertices and its indices were, and how
 * many of each. A member joining fits into one only if both of its runs fit.
 */
interface FreeRun {
  vertexFirst: number;
  vertexCount: number;
  indexFirst: number;
  indexCount: number;
}

/**
 * What one pass has written since its last upload, as one run of vertices and
 * one of indices — the union of everything written, so filling a freed run near
 * the start and appending at the end in the same frame sends both and what lies
 * between. Nothing written leaves both counts at zero.
 */
interface Written {
  vertexFirst: number;
  vertexLast: number;
  indexFirst: number;
  indexLast: number;
}

const nothingWritten = (): Written => ({
  vertexFirst: Infinity,
  vertexLast: -1,
  indexFirst: Infinity,
  indexLast: -1,
});

/** The span an upload sends for one kind of thing, or undefined for nothing. */
const spanOf = (first: number, last: number): Span | undefined =>
  last < first ? undefined : { first, count: last - first + 1 };

/**
 * Appends one member's mesh into a pass at the superchunk's origin: the
 * member's block-local vertices are re-origined by `(memberCentre −
 * superchunkCentre)` and its indices re-based on the running vertex count.
 */
const appendArrays = (
  into: MergedArrays,
  from: MeshArrays,
  dx: number,
  dy: number,
  dz: number,
): void => {
  const base = into.positions.count / 3;
  into.positions.pushOffset(from.positions, dx, dy, dz);
  into.normals.pushMany(from.normals);
  into.uvs.pushMany(from.uvs);
  into.tiles.pushMany(from.tiles);
  into.brightness.pushMany(from.brightness);
  into.indices.pushShifted(from.indices, base);
};

/** Bytes a pass's six arrays occupy, written or not, since growth doubles them. */
const capacityBytes = (arrays: MergedArrays): number =>
  arrays.positions.capacityBytes +
  arrays.normals.capacityBytes +
  arrays.uvs.capacityBytes +
  arrays.tiles.capacityBytes +
  arrays.indices.capacityBytes +
  arrays.brightness.capacityBytes;

/** One pass: its arrays, the room retired members left in them, and what it owes. */
interface Pass {
  arrays: MergedArrays;
  free: FreeRun[];
  written: Written;
}

const emptyPass = (): Pass => ({
  arrays: emptyArrays(),
  free: [],
  written: nothingWritten(),
});

/** Bytes of a pass the card does not hold: the runs written since the last upload. */
const writtenBytes = (pass: Pass): number => {
  const vertices = spanOf(pass.written.vertexFirst, pass.written.vertexLast);
  const indices = spanOf(pass.written.indexFirst, pass.written.indexLast);
  return (
    (vertices?.count ?? 0) * VERTEX_UPLOAD_BYTES +
    (indices?.count ?? 0) * INDEX_UPLOAD_BYTES
  );
};

/** Widens what a pass owes to cover a run of vertices and a run of indices. */
const noteWritten = (
  pass: Pass,
  vertexFirst: number,
  vertexCount: number,
  indexFirst: number,
  indexCount: number,
): void => {
  if (vertexCount > 0) {
    pass.written.vertexFirst = Math.min(pass.written.vertexFirst, vertexFirst);
    pass.written.vertexLast = Math.max(
      pass.written.vertexLast,
      vertexFirst + vertexCount - 1,
    );
  }
  if (indexCount > 0) {
    pass.written.indexFirst = Math.min(pass.written.indexFirst, indexFirst);
    pass.written.indexLast = Math.max(
      pass.written.indexLast,
      indexFirst + indexCount - 1,
    );
  }
};

/** Where one member's mesh ended up in a pass: its indices, and its vertices. */
interface Placement {
  indices: IndexRange;
  vertices: IndexRange;
}

/**
 * Writes one member's mesh into a pass and answers where it went: over the
 * first freed run both of its parts fit in, or at the end when none does. Its
 * vertices are re-origined by `(memberCentre − superchunkCentre)` and its
 * indices re-based on wherever its vertices landed.
 */
const writeMember = (
  pass: Pass,
  mesh: MeshArrays,
  dx: number,
  dy: number,
  dz: number,
): Placement => {
  const vertices = mesh.positions.length / 3;
  const indices = mesh.indices.length;
  const fits = pass.free.findIndex(
    (run) => run.vertexCount >= vertices && run.indexCount >= indices,
  );
  if (fits === -1) {
    const vertexFirst = pass.arrays.positions.count / 3;
    const indexFirst = pass.arrays.indices.count;
    appendArrays(pass.arrays, mesh, dx, dy, dz);
    noteWritten(pass, vertexFirst, vertices, indexFirst, indices);
    return {
      indices: { start: indexFirst, count: indices },
      vertices: { start: vertexFirst, count: vertices },
    };
  }
  const run = pass.free[fits];
  pass.arrays.positions.writeOffsetAt(
    run.vertexFirst * 3,
    mesh.positions,
    dx,
    dy,
    dz,
  );
  pass.arrays.normals.writeManyAt(run.vertexFirst * 3, mesh.normals);
  pass.arrays.uvs.writeManyAt(run.vertexFirst * 2, mesh.uvs);
  pass.arrays.tiles.writeManyAt(run.vertexFirst, mesh.tiles);
  pass.arrays.brightness.writeManyAt(run.vertexFirst, mesh.brightness);
  pass.arrays.indices.writeShiftedAt(
    run.indexFirst,
    mesh.indices,
    run.vertexFirst,
  );
  noteWritten(pass, run.vertexFirst, vertices, run.indexFirst, indices);
  // What is left of the run stays free, so a smaller member can still use it.
  // The leftovers of both parts have to line up for that to be true, which they
  // do because a member's vertices and indices are written together.
  const leftVertices = run.vertexCount - vertices;
  const leftIndices = run.indexCount - indices;
  if (leftVertices > 0 && leftIndices > 0) {
    pass.free[fits] = {
      vertexFirst: run.vertexFirst + vertices,
      vertexCount: leftVertices,
      indexFirst: run.indexFirst + indices,
      indexCount: leftIndices,
    };
  } else {
    pass.free.splice(fits, 1);
  }
  return {
    indices: { start: run.indexFirst, count: indices },
    vertices: { start: run.vertexFirst, count: vertices },
  };
};

/** Keeps the room a member's runs occupied, for the next member that fits. */
const freeMember = (
  pass: Pass,
  range: IndexRange,
  vertexFirst: number,
  vertexCount: number,
): void => {
  if (range.count === 0 && vertexCount === 0) {
    return;
  }
  pass.free.push({
    vertexFirst,
    vertexCount,
    indexFirst: range.start,
    indexCount: range.count,
  });
};

/** Vertices and indices a pass is holding for nobody. */
const freeBytes = (pass: Pass): number =>
  pass.free.reduce(
    (bytes, run) =>
      bytes +
      run.vertexCount * VERTEX_UPLOAD_BYTES +
      run.indexCount * INDEX_UPLOAD_BYTES,
    0,
  );

/** Points a pass's attributes at empty arrays, letting go of what it grew. */
const releaseArrays = (geometry: BufferGeometry): void => {
  for (const [name, attribute] of Object.entries(geometry.attributes)) {
    geometry.setAttribute(
      name,
      new BufferAttribute(new Float32Array(0), attribute.itemSize),
    );
  }
  if (geometry.index !== null) {
    geometry.setIndex(new BufferAttribute(new Uint32Array(0), 1));
  }
};

/** What a mesh of a landed member weighs, as an upload. */
export const meshUploadBytes = (arrays: MeshArrays): number =>
  (arrays.positions.length / 3) * VERTEX_UPLOAD_BYTES +
  arrays.indices.length * INDEX_UPLOAD_BYTES;

/** One member's two meshes, as the mesher builds them. */
export interface MemberMeshes {
  terrain: MeshArrays;
  water: MeshArrays;
}

export class Superchunk {
  /** The members joined into these arrays, by slot. */
  private readonly joined = new Set<number>();
  private readonly terrainPass = emptyPass();
  private readonly waterPass = emptyPass();
  private readonly terrainRanges = new Map<number, IndexRange>();
  private readonly waterRanges = new Map<number, IndexRange>();
  /**
   * Where each member's vertices sit in each pass, which its index run does not
   * say: the run addresses indices, and freeing a member has to give back both.
   */
  private readonly terrainVertices = new Map<number, IndexRange>();
  private readonly waterVertices = new Map<number, IndexRange>();

  /**
   * @param center The superchunk cell's world-space centre, which every member's
   *   vertices are re-origined against.
   * @param pair The geometries to upload into, for the life of this superchunk.
   */
  constructor(
    readonly center: Dim3,
    private readonly pair: GeometryPair,
  ) {}

  /** The opaque pass's geometry. Written only by `upload`; read to draw from. */
  get terrain(): BufferGeometry {
    return this.pair.terrain;
  }

  /** The water pass's geometry. Written only by `upload`; read to draw from. */
  get water(): BufferGeometry {
    return this.pair.water;
  }

  /** Whether `member`'s mesh is in these arrays. */
  holds(member: number): boolean {
    return this.joined.has(member);
  }

  /**
   * The members joined into these arrays. The culler walks them to ask whether
   * every one of them has been proved hidden.
   */
  get members(): ReadonlySet<number> {
    return this.joined;
  }

  /**
   * Joins one member's meshes, recording the run of indices each pass draws it
   * from. A member already joined is left alone — its mesh is in the arrays
   * already, and appending it again would draw it twice.
   *
   * @param member The slot the meshes were built for.
   * @param center That slot's world-space centre.
   * @param meshes Its terrain and water meshes.
   */
  join(member: number, center: Dim3, meshes: MemberMeshes): void {
    if (this.joined.has(member)) {
      return;
    }
    const dx = center[0] - this.center[0];
    const dy = center[1] - this.center[1];
    const dz = center[2] - this.center[2];
    for (const [pass, mesh, ranges, vertices] of [
      [
        this.terrainPass,
        meshes.terrain,
        this.terrainRanges,
        this.terrainVertices,
      ],
      [this.waterPass, meshes.water, this.waterRanges, this.waterVertices],
    ] as const) {
      const placed = writeMember(pass, mesh, dx, dy, dz);
      ranges.set(member, placed.indices);
      vertices.set(member, placed.vertices);
    }
    this.joined.add(member);
  }

  /**
   * Gives back the room a member was using, because it has left this superchunk
   * or because its voxels changed and what is here for it is stale. Its run
   * stops being drawn at once — nothing indexes those vertices any more — and
   * the room is kept for the next member that fits in it. A member whose voxels
   * changed is joined again with its new mesh on the merge that follows.
   */
  retire(member: number): void {
    if (!this.joined.delete(member)) {
      return;
    }
    for (const [pass, ranges, vertices] of [
      [this.terrainPass, this.terrainRanges, this.terrainVertices],
      [this.waterPass, this.waterRanges, this.waterVertices],
    ] as const) {
      const range = ranges.get(member);
      const vertexRun = vertices.get(member);
      if (range !== undefined && vertexRun !== undefined) {
        freeMember(pass, range, vertexRun.start, vertexRun.count);
      }
      ranges.delete(member);
      vertices.delete(member);
    }
  }

  /** Where each pass draws `member` from, or empty ranges for one not held. */
  rangeOf(member: number): MemberRanges {
    return {
      terrain: this.terrainRangeOf(member),
      water: this.waterRangeOf(member),
    };
  }

  /**
   * Where a member's terrain indices sit in the joined geometry, or an empty
   * run when it holds none. Answered without building anything, for a caller
   * asking once a frame for every member of the window.
   */
  terrainRangeOf(member: number): IndexRange {
    return this.terrainRanges.get(member) ?? EMPTY_RANGE;
  }

  /** Where a member's water indices sit in the joined geometry, likewise. */
  waterRangeOf(member: number): IndexRange {
    return this.waterRanges.get(member) ?? EMPTY_RANGE;
  }

  /**
   * The bytes of these arrays the card does not hold yet. What a frame spends
   * its upload budget against, together with the meshes of the members that
   * have landed but not joined — which the renderer counts, because it is the
   * one holding them.
   */
  get pendingBytes(): number {
    return writtenBytes(this.terrainPass) + writtenBytes(this.waterPass);
  }

  /** Bytes these arrays occupy in main memory, at the capacity they grew to. */
  get bytes(): number {
    return (
      capacityBytes(this.terrainPass.arrays) +
      capacityBytes(this.waterPass.arrays)
    );
  }

  /** Of those, the bytes held in runs retired members left and nobody has taken. */
  get freeBytes(): number {
    return freeBytes(this.terrainPass) + freeBytes(this.waterPass);
  }

  /** Indices written across both passes, the runs nobody draws included. */
  get indexCount(): number {
    return (
      this.terrainPass.arrays.indices.count +
      this.waterPass.arrays.indices.count
    );
  }

  /**
   * Fills the pair with what has been joined, sending only the tail past the
   * last upload, and answers the bytes that tail weighed. The ranges `rangeOf`
   * gives out address the geometry from this moment.
   */
  upload(): number {
    const sent = this.pendingBytes;
    for (const [pass, geometry] of [
      [this.terrainPass, this.pair.terrain],
      [this.waterPass, this.pair.water],
    ] as const) {
      const vertices = spanOf(
        pass.written.vertexFirst,
        pass.written.vertexLast,
      );
      const indices = spanOf(pass.written.indexFirst, pass.written.indexLast);
      setGeometryData(
        geometry,
        {
          positions: pass.arrays.positions.array(),
          normals: pass.arrays.normals.array(),
          uvs: pass.arrays.uvs.array(),
          tiles: pass.arrays.tiles.array(),
          brightness: pass.arrays.brightness.array(),
          indices: pass.arrays.indices.array(),
        },
        // Nothing written means nothing to send; an empty span says so, where
        // leaving it out would send the whole of both arrays again.
        {
          vertices: vertices ?? { first: 0, count: 0 },
          indices: indices ?? { first: 0, count: 0 },
        },
      );
      pass.written = nothingWritten();
    }
    return sent;
  }

  /**
   * Gives the pair back, its attributes pointed at nothing so the arrays this
   * superchunk grew are collectable. The pair's GPU buffers are the caller's to
   * pool or dispose; this `Superchunk` is finished with either way.
   */
  release(): GeometryPair {
    releaseArrays(this.pair.terrain);
    releaseArrays(this.pair.water);
    return this.pair;
  }
}
