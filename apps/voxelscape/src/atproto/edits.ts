// Edit-chunk records for atproto storage: the `EditLayer` overlay is chunked
// into 32x32x32 world-voxel cells, and each chunk's sparse edits are written
// as one custom record in the user's repo. Chunking by absolute voxel (not by
// which ring block held them) keeps a record addressable by location, so any
// client can resolve it onto its own regenerated terrain.
import * as lex from "@atcute/lexicons/validations";
import { versionedRecord } from "@big-mesh-studios/atproto/migration";
import { DEFAULT_WORLD_URL } from "../places/place";
import type { WorldVoxel, VoxelEdit } from "../world/edit-layer";

// `mergeIntoLayer` moved into `edit-layer.ts` with the overlay it operates on,
// but is re-exported here so sync callers keep importing it alongside the
// chunk codec.
export { mergeIntoLayer } from "../world/edit-layer";

/** One side of an edit chunk, in voxels. */
export const EDIT_CHUNK_DIM = 32;
/** The atproto record collection for edit chunks. */
export const EDIT_COLLECTION = "app.bms.voxelscape.edit";

const EditChunkCoordSchema = lex.object({
  x: lex.integer(),
  y: lex.integer(),
  z: lex.integer(),
});
export type EditChunkCoord = lex.InferOutput<typeof EditChunkCoordSchema>;

const EditChunkEditSchema = lex.object({
  x: lex.integer(),
  y: lex.integer(),
  z: lex.integer(),
  id: lex.integer(),
  // Milliseconds since epoch when the edit was made, matching the WebRTC
  // optimistic path's `EditItem`. Absent on a record written before this
  // field existed, whose entries fall back to the record's `createdAt`.
  ts: lex.optional(lex.integer()),
});
/** One edit inside a chunk record: the voxel's new id plus when it was made. */
export type EditChunkEdit = lex.InferOutput<typeof EditChunkEditSchema>;

/**
 * An edit-chunk record's shape before it carried a `version` or a `place` of
 * its own — every world was implicitly the default world back then, since
 * places didn't yet have an identity to belong to.
 */
const EditChunkRecordV0Schema = lex.object({
  $type: lex.literal(EDIT_COLLECTION),
  chunk: EditChunkCoordSchema,
  seed: lex.nullable(lex.integer()),
  place: lex.optional(lex.nullable(lex.genericUriString())),
  createdAt: lex.datetimeString(),
  edits: lex.array(EditChunkEditSchema),
});

const EditChunkRecordV1Schema = lex.object({
  $type: lex.literal(EDIT_COLLECTION),
  version: lex.literal(1),
  chunk: EditChunkCoordSchema,
  seed: lex.nullable(lex.integer()),
  place: lex.genericUriString(),
  createdAt: lex.datetimeString(),
  edits: lex.array(EditChunkEditSchema),
});

/**
 * One edit record, at the shape every record is written as today: a sparse
 * list of voxel ids inside one 32³ chunk of a named place. `place` is always
 * a real, link-shaped address — the default world's own fixed one, or a
 * published place's `at://` address — never absent, so a backlink index can
 * always find every account's edits to it.
 */
export type EditChunkRecord = lex.InferOutput<typeof EditChunkRecordV1Schema>;

/**
 * Every shape this record has ever been written in, and how each becomes the
 * next. A record with no `place` of its own belonged to the default world,
 * since that was the only world there was before places existed.
 */
const editChunkRecordMigration = versionedRecord(
  EditChunkRecordV0Schema,
).upgradesTo(EditChunkRecordV1Schema, (v0): EditChunkRecord => ({
  ...v0,
  version: 1,
  place: v0.place ?? DEFAULT_WORLD_URL,
}));

/**
 * Reads `value` as an edit-chunk record at whichever version it was written,
 * upgraded to the shape every caller wants. Null when it isn't one.
 */
export const parseEditChunkRecord = (value: unknown): EditChunkRecord | null =>
  editChunkRecordMigration.parse(value);

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
  place: string,
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
        version: 1,
        chunk: c,
        seed,
        // Every caller passes either the default world's fixed address or a
        // published place's own `at://` address, both genuinely link-shaped
        // — the schema's stricter type just isn't provable from a plain
        // `string` parameter.
        place: place as EditChunkRecord["place"],
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
export const makeRkey = (place: string, c: EditChunkCoord): string =>
  `e_${hashPlace(place)}_${c.x}_${c.y}_${c.z}`;

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
