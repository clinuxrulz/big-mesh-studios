// One-time recovery for edit-chunk records written before a place carried
// its own identity. Those records were never indexed by Constellation as
// linking anywhere — a `place` of `null` isn't a link at all — so no sync
// path can find them any more; this is a brute-force scan of the signed-in
// account's own edit collection instead, run once by hand rather than kept
// as a standing code path. Matching records are merged (voxel by voxel,
// newest edit wins) and republished under the target place's real address.
// Uses @big-mesh-studios/atproto's pds-cli session — sign in with that
// first.
//
// Deliberately self-contained rather than importing from `../src/atproto/edits.ts`:
// that module re-exports from the world's edit-layer, which pulls in the
// whole terrain-generation tree — none of it needed here, and none of
// those modules' imports carry the explicit `.ts` extensions Node's loader
// (unlike Vite's bundler resolution) requires. The handful of facts this
// script needs from that module — the chunk size, the record shape, the
// key hash — are stable enough to restate directly in a script meant to be
// run once and then deleted, rather than earning a repo-wide import fixup.
//
//   node --experimental-transform-types tools/backfill-home-edits.ts \
//     at://did:plc:.../app.bms.voxelscape.place/home
import {
  clientFromSession,
  requireSession,
} from "@big-mesh-studios/atproto/password-session";
import { listAllRecords } from "@big-mesh-studios/atproto/repo-client";

const EDIT_COLLECTION = "app.bms.voxelscape.edit";
const EDIT_CHUNK_DIM = 32;
const DEFAULT_WORLD_URL =
  "https://big-mesh-studios.github.io/big-mesh-studios/voxelscape/";

interface EditChunkCoord {
  x: number;
  y: number;
  z: number;
}
interface EditChunkEdit {
  x: number;
  y: number;
  z: number;
  id: number;
  ts?: number;
}
interface EditChunkRecord {
  $type: string;
  version?: number;
  chunk: EditChunkCoord;
  seed: number | null;
  place?: string | null;
  createdAt: string;
  edits: EditChunkEdit[];
}

const chunkOf = (x: number, y: number, z: number): EditChunkCoord => ({
  x: Math.floor(x / EDIT_CHUNK_DIM),
  y: Math.floor(y / EDIT_CHUNK_DIM),
  z: Math.floor(z / EDIT_CHUNK_DIM),
});
const chunkLocal = (n: number, chunkOrigin: number): number =>
  n - chunkOrigin * EDIT_CHUNK_DIM;
const chunkKey = (c: EditChunkCoord): string => `${c.x}/${c.y}/${c.z}`;

const hashPlace = (s: string): string => {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(36);
};
const makeRkey = (place: string, c: EditChunkCoord): string =>
  `e_${hashPlace(place)}_${c.x}_${c.y}_${c.z}`;

const USAGE = `usage: backfill-home-edits <target place at:// address> [--seed=<n>]`;

const main = async (): Promise<void> => {
  const argv = process.argv.slice(2);
  const target = argv.find((arg) => !arg.startsWith("--"));
  const seedArg = argv.find((arg) => arg.startsWith("--seed="));
  if (target === undefined) {
    throw new Error(USAGE);
  }
  const seed =
    seedArg !== undefined ? Number(seedArg.slice("--seed=".length)) : 54321;

  const session = await requireSession();
  const client = clientFromSession(session);
  console.log(`scanning ${session.handle}'s edit collection…`);

  const raw = await listAllRecords(client, {
    repo: session.did,
    collection: EDIT_COLLECTION,
  });
  const legacy = raw
    .map(({ value }) => value as EditChunkRecord)
    .filter(
      (record) =>
        record?.$type === EDIT_COLLECTION &&
        (record.place === undefined ||
          record.place === null ||
          record.place === DEFAULT_WORLD_URL),
    );
  console.log(
    `${raw.length} record(s) total, ${legacy.length} still tagged with the default world's old fallback address`,
  );
  if (legacy.length === 0) {
    console.log("nothing to migrate.");
    return;
  }

  // Newest edit per world voxel wins, across every matching record —
  // several old uploads may have touched the same chunk under the old
  // random-rkey scheme, each carrying only part of its edits.
  const merged = new Map<
    string,
    { x: number; y: number; z: number; id: number; ts: number }
  >();
  for (const record of legacy) {
    const fallback = Date.parse(record.createdAt);
    for (const edit of record.edits) {
      const x = record.chunk.x * EDIT_CHUNK_DIM + edit.x;
      const y = record.chunk.y * EDIT_CHUNK_DIM + edit.y;
      const z = record.chunk.z * EDIT_CHUNK_DIM + edit.z;
      const ts = edit.ts ?? fallback;
      const key = `${x}/${y}/${z}`;
      const existing = merged.get(key);
      if (existing === undefined || ts > existing.ts) {
        merged.set(key, { x, y, z, id: edit.id, ts });
      }
    }
  }
  console.log(`${merged.size} distinct voxel(s) after merging`);

  const groups = new Map<string, EditChunkRecord>();
  const createdAt = new Date().toISOString();
  for (const { x, y, z, id, ts } of merged.values()) {
    const c = chunkOf(x, y, z);
    const key = chunkKey(c);
    let group = groups.get(key);
    if (group === undefined) {
      group = {
        $type: EDIT_COLLECTION,
        version: 1,
        chunk: c,
        seed,
        place: target,
        createdAt,
        edits: [],
      };
      groups.set(key, group);
    }
    group.edits.push({
      x: chunkLocal(x, c.x),
      y: chunkLocal(y, c.y),
      z: chunkLocal(z, c.z),
      id,
      ts,
    });
  }

  for (const record of groups.values()) {
    await client.putRecord({
      repo: session.did,
      collection: EDIT_COLLECTION,
      rkey: makeRkey(target, record.chunk),
      record: record as unknown as { [_ in string]: unknown },
    });
  }
  console.log(`republished ${groups.size} chunk record(s) under ${target}`);
};

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
