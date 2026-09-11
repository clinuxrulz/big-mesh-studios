// Edit-chunk records for atproto storage: the `EditLayer` overlay is chunked
// into 32x32x32 world-voxel cells, and each chunk's sparse edits are written
// as one custom record in the user's repo. Chunking by absolute voxel (not by
// which ring block held them) keeps a record addressable by location, so any
// client can resolve it onto its own regenerated terrain.
import type { WorldVoxel, VoxelEdit } from "../world/edit-layer";

// `mergeIntoLayer` moved into `edit-layer.ts` with the overlay it operates on,
// but is re-exported here so sync callers keep importing it alongside the
// chunk codec.
export { mergeIntoLayer } from "../world/edit-layer";

/** One side of an edit chunk, in voxels. */
export const EDIT_CHUNK_DIM = 32;
/** The atproto record collection for edit chunks. */
export const EDIT_COLLECTION = "app.bms.voxelscape.edit";

export interface EditChunkCoord {
  x: number;
  y: number;
  z: number;
}

/** One edit inside a chunk record: the voxel's new id plus when it was made. */
export type EditChunkEdit = {
  x: number;
  y: number;
  z: number;
  id: number;
  /**
   * Milliseconds since epoch when the edit was made (per-edit, matching the
   * WebRTC optimistic path's `EditItem`). Absent on records written before
   * this field existed, whose entries fall back to the record's `createdAt`.
   */
  ts?: number;
};

/**
 * One edit record: a sparse list of voxel ids inside one 32³ chunk. Declared
 * as a type alias rather than an interface so it stays assignable to the
 * `Record<string, unknown>` an atproto record body is typed as — TypeScript
 * infers an implicit index signature for the one and not the other.
 */
export type EditChunkRecord = {
  $type: typeof EDIT_COLLECTION;
  chunk: EditChunkCoord;
  /** Terrain seed the world was generated with, for reproducible base terrain. */
  seed: number | null;
  /**
   * The place this chunk belongs to — an `at://` address, a demo's synthetic
   * id, or `null` for the default world — so a `multi:edit` place's other
   * players can find exactly the edits made to it, rather than every edit
   * this account has ever made anywhere. Absent on a record written before
   * this existed, which reads the same as `null`: the default world.
   */
  place?: string | null;
  createdAt: string;
  edits: EditChunkEdit[];
};

export const chunkOf = (w: WorldVoxel): EditChunkCoord => ({
  x: Math.floor(w[0] / EDIT_CHUNK_DIM),
  y: Math.floor(w[1] / EDIT_CHUNK_DIM),
  z: Math.floor(w[2] / EDIT_CHUNK_DIM),
});

export const chunkLocal = (
  w: WorldVoxel,
): { x: number; y: number; z: number } => ({
  x: w[0] - Math.floor(w[0] / EDIT_CHUNK_DIM) * EDIT_CHUNK_DIM,
  y: w[1] - Math.floor(w[1] / EDIT_CHUNK_DIM) * EDIT_CHUNK_DIM,
  z: w[2] - Math.floor(w[2] / EDIT_CHUNK_DIM) * EDIT_CHUNK_DIM,
});

export const chunkKey = (c: EditChunkCoord): string => `${c.x}/${c.y}/${c.z}`;

export const parseChunkKey = (key: string): EditChunkCoord => {
  const [x, y, z] = key.split("/");
  return { x: Number(x), y: Number(y), z: Number(z) };
};

/** Absolute world voxel of any edit chunk record. */
export const recordVoxel = (
  record: Pick<EditChunkRecord, "chunk" | "edits">,
  edit: EditChunkRecord["edits"][number],
): WorldVoxel => [
  record.chunk.x * EDIT_CHUNK_DIM + edit.x,
  record.chunk.y * EDIT_CHUNK_DIM + edit.y,
  record.chunk.z * EDIT_CHUNK_DIM + edit.z,
];

/**
 * Groups `entries` into one record per 32³ chunk, sharing a single
 * `createdAt`. Returns a map keyed by `chunkKey` of the assembled record.
 */
export const groupEditsByChunk = (
  entries: Array<{ w: WorldVoxel; edit: VoxelEdit }>,
  seed: number | null,
  place: string | null,
  createdAt: string,
): Map<string, EditChunkRecord> => {
  const groups = new Map<string, EditChunkRecord>();
  for (const { w, edit } of entries) {
    const c = chunkOf(w);
    const key = chunkKey(c);
    let record = groups.get(key);
    if (record === undefined) {
      record = {
        $type: EDIT_COLLECTION,
        chunk: c,
        seed,
        place,
        createdAt,
        edits: [],
      };
      groups.set(key, record);
    }
    const l = chunkLocal(w);
    record.edits.push({
      x: l.x,
      y: l.y,
      z: l.z,
      id: edit.id,
      ts: edit.updatedAt,
    });
  }
  return groups;
};

/** Stable short hash of a string, for embedding a place's address in a record key. */
const hashPlace = (s: string): string => {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(36);
};

/**
 * A valid atproto record key for a chunk: deterministic from the place and
 * chunk coordinates, so re-uploading the same chunk overwrites the record
 * already there instead of leaving an earlier upload behind it.
 */
export const makeRkey = (place: string | null, c: EditChunkCoord): string =>
  `e_${hashPlace(place ?? "default")}_${c.x}_${c.y}_${c.z}`;

/**
 * Flattens records from a repo back into overlay snapshot entries ready to
 * feed `editLayerFromSnapshot` (or merge into a live layer). Coords are
 * reassembled from chunk + local; each edit carries the per-edit `ts` when the
 * record has one, falling back to the record's `createdAt` for older records.
 */
export const recordsToEntries = (
  records: EditChunkRecord[],
): Array<{ w: WorldVoxel; edit: VoxelEdit }> => {
  const out: Array<{ w: WorldVoxel; edit: VoxelEdit }> = [];
  for (const record of records) {
    const t = Date.parse(record.createdAt);
    const fallback = Number.isFinite(t) ? t : 0;
    for (const edit of record.edits) {
      const updatedAt =
        typeof edit.ts === "number" && Number.isFinite(edit.ts)
          ? edit.ts
          : fallback;
      out.push({
        w: recordVoxel(record, edit),
        edit: { id: edit.id, updatedAt },
      });
    }
  }
  return out;
};
