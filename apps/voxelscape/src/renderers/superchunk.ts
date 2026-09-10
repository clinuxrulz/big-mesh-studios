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
// The card's copy is the reason `committed` exists: an upload sends only the
// tail past what the last one sent, so a superchunk that gained one member pays
// for that member rather than for itself. A member replaced or retired makes the
// arrays behind it wrong, and this says so — `owesRebuild` — because rebuilding
// needs every member's mesh, which the renderer holds and this does not.
import { BufferAttribute, BufferGeometry } from "@random-mesh/rmsl/scene";
import { Growable } from "./growable";
import { setGeometryData, type MeshArrays } from "./mesh";
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

/** How many vertices and indices of one pass the card holds from the last upload. */
interface Committed {
  vertices: number;
  indices: number;
}

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

/** Bytes of a pass the card does not hold: everything past the last upload. */
const tailBytes = (arrays: MergedArrays, committed: Committed): number =>
  Math.max(0, arrays.positions.count / 3 - committed.vertices) *
    VERTEX_UPLOAD_BYTES +
  Math.max(0, arrays.indices.count - committed.indices) * INDEX_UPLOAD_BYTES;

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
  private readonly terrainArrays = emptyArrays();
  private readonly waterArrays = emptyArrays();
  private readonly terrainRanges = new Map<number, IndexRange>();
  private readonly waterRanges = new Map<number, IndexRange>();
  private readonly terrainCommitted: Committed = { vertices: 0, indices: 0 };
  private readonly waterCommitted: Committed = { vertices: 0, indices: 0 };
  private rebuildOwed = false;

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
    const terrainStart = this.terrainArrays.indices.count;
    appendArrays(this.terrainArrays, meshes.terrain, dx, dy, dz);
    this.terrainRanges.set(member, {
      start: terrainStart,
      count: meshes.terrain.indices.length,
    });
    const waterStart = this.waterArrays.indices.count;
    appendArrays(this.waterArrays, meshes.water, dx, dy, dz);
    this.waterRanges.set(member, {
      start: waterStart,
      count: meshes.water.indices.length,
    });
    this.joined.add(member);
  }

  /**
   * Says that a joined member's voxels changed, so what is in these arrays for
   * it is stale. The member stays a member; the arrays owe a rebuild, which
   * only the renderer can drive because it holds every member's mesh.
   */
  replace(member: number): void {
    if (this.joined.has(member)) {
      this.rebuildOwed = true;
    }
  }

  /**
   * Says that a member has left this superchunk — the window moved its slot to
   * another cell. Its run stops being drawn at once, and the arrays owe a
   * rebuild to be rid of the vertices behind it.
   */
  retire(member: number): void {
    if (!this.joined.delete(member)) {
      return;
    }
    this.terrainRanges.delete(member);
    this.waterRanges.delete(member);
    this.rebuildOwed = true;
  }

  /**
   * Whether these arrays hold vertices no member should be drawing — a replaced
   * or retired member's. Rebuilding means a fresh `Superchunk` joined from every
   * member the renderer still has a mesh for.
   */
  get owesRebuild(): boolean {
    return this.rebuildOwed;
  }

  /** Where each pass draws `member` from, or empty ranges for one not held. */
  rangeOf(member: number): MemberRanges {
    return {
      terrain: this.terrainRanges.get(member) ?? EMPTY_RANGE,
      water: this.waterRanges.get(member) ?? EMPTY_RANGE,
    };
  }

  /**
   * The bytes of these arrays the card does not hold yet. What a frame spends
   * its upload budget against, together with the meshes of the members that
   * have landed but not joined — which the renderer counts, because it is the
   * one holding them.
   */
  get pendingBytes(): number {
    return (
      tailBytes(this.terrainArrays, this.terrainCommitted) +
      tailBytes(this.waterArrays, this.waterCommitted)
    );
  }

  /** Bytes these arrays occupy in main memory, at the capacity they grew to. */
  get bytes(): number {
    return capacityBytes(this.terrainArrays) + capacityBytes(this.waterArrays);
  }

  /** Indices drawn across both passes, which is three per triangle. */
  get indexCount(): number {
    return this.terrainArrays.indices.count + this.waterArrays.indices.count;
  }

  /**
   * Fills the pair with what has been joined, sending only the tail past the
   * last upload, and answers the bytes that tail weighed. The ranges `rangeOf`
   * gives out address the geometry from this moment.
   */
  upload(): number {
    const sent = this.pendingBytes;
    setGeometryData(
      this.pair.terrain,
      {
        positions: this.terrainArrays.positions.array(),
        normals: this.terrainArrays.normals.array(),
        uvs: this.terrainArrays.uvs.array(),
        tiles: this.terrainArrays.tiles.array(),
        brightness: this.terrainArrays.brightness.array(),
        indices: this.terrainArrays.indices.array(),
      },
      this.terrainCommitted.vertices,
      this.terrainCommitted.indices,
    );
    setGeometryData(
      this.pair.water,
      {
        positions: this.waterArrays.positions.array(),
        normals: this.waterArrays.normals.array(),
        uvs: this.waterArrays.uvs.array(),
        tiles: this.waterArrays.tiles.array(),
        brightness: this.waterArrays.brightness.array(),
        indices: this.waterArrays.indices.array(),
      },
      this.waterCommitted.vertices,
      this.waterCommitted.indices,
    );
    this.terrainCommitted.vertices = this.terrainArrays.positions.count / 3;
    this.terrainCommitted.indices = this.terrainArrays.indices.count;
    this.waterCommitted.vertices = this.waterArrays.positions.count / 3;
    this.waterCommitted.indices = this.waterArrays.indices.count;
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
