// A client for Constellation (https://constellation.microcosm.blue), a public
// atproto backlink index: it crawls the firehose recording every at-uri it
// finds inside any record, so asking it "who links to this place" answers
// directly, without walking every account that has ever written an edit
// record and discarding what doesn't match. Used only by `multi:edit` places,
// to find every account's edit chunks for one specific place.
import { Client, ok, simpleFetchHandler } from "@atcute/client";
import type { ActorIdentifier, Did, Nsid, RecordKey } from "@atcute/lexicons";
import {
  createDidDocumentResolver,
  pdsEndpoint,
} from "@big-mesh-studios/atproto/identity";
import { EDIT_COLLECTION, type EditChunkRecord } from "./edits";

const CONSTELLATION_BASE = "https://constellation.microcosm.blue";
/** The path inside an edit-chunk record Constellation indexes as a link. */
const EDIT_PLACE_PATH = ".place";
/** Hits per page, the most Constellation's own API accepts. */
const PAGE_LIMIT = 100;
/** Caps how many accounts' chunks one sync will ever fetch for a single place. */
const MAX_HITS = 500;

/** One matching edit-chunk record Constellation found, resolved enough to fetch. */
interface ConstellationHit {
  did: string;
  collection: string;
  rkey: string;
}

interface GetBacklinksResponse {
  total: number;
  records: ConstellationHit[];
  cursor?: string;
}

/**
 * Every hit in `collection`, at `path`, pointing at `subject` — paginated
 * until Constellation reports no further cursor or `MAX_HITS` is reached.
 */
const getBacklinks = async (
  subject: string,
  collection: string,
  path: string,
): Promise<ConstellationHit[]> => {
  const hits: ConstellationHit[] = [];
  let cursor: string | undefined;
  do {
    const params = new URLSearchParams({
      subject,
      source: `${collection}:${path}`,
      limit: String(PAGE_LIMIT),
    });
    if (cursor !== undefined) {
      params.set("cursor", cursor);
    }
    // A browser's `fetch` cannot set `User-Agent` (a forbidden header), so
    // this goes out unidentified rather than pretending to follow
    // Constellation's own request for one.
    const response = await fetch(
      `${CONSTELLATION_BASE}/xrpc/blue.microcosm.links.getBacklinks?${params.toString()}`,
    );
    if (!response.ok) {
      throw new Error(`constellation error: ${response.status}`);
    }
    const body = (await response.json()) as GetBacklinksResponse;
    hits.push(...body.records);
    cursor = body.cursor;
  } while (cursor !== undefined && hits.length < MAX_HITS);
  return hits;
};

const didDocumentResolver = createDidDocumentResolver();

/** The account's own edit-chunk record at `did`/`collection`/`rkey`, or null if it isn't one. */
const fetchEditRecord = async (
  hit: ConstellationHit,
): Promise<EditChunkRecord | null> => {
  const document = await didDocumentResolver.resolve(
    hit.did as Did<"plc" | "web">,
  );
  const client = new Client({
    handler: simpleFetchHandler({ service: pdsEndpoint(document) }),
  });
  const response = await ok(
    client.get("com.atproto.repo.getRecord", {
      params: {
        repo: hit.did as ActorIdentifier,
        collection: hit.collection as Nsid,
        rkey: hit.rkey as RecordKey,
      },
    }),
  );
  return response.value?.$type === EDIT_COLLECTION
    ? (response.value as EditChunkRecord)
    : null;
};

/**
 * Every other account's edit-chunk records for `place`, for a `multi:edit`
 * sync to merge in alongside the signed-in account's own. `selfRepo`'s hits
 * are skipped, since those are already covered by the self-repo read.
 * Never throws: a Constellation or PDS failure is reported to the console and
 * treated as no remote edits for that sync, so the self-repo half still runs.
 */
export const fetchSharedEditRecords = async (
  place: string,
  selfRepo: string,
): Promise<EditChunkRecord[]> => {
  try {
    const hits = (
      await getBacklinks(place, EDIT_COLLECTION, EDIT_PLACE_PATH)
    ).filter((hit) => hit.did !== selfRepo);
    const fetched = await Promise.all(
      hits.map((hit) =>
        fetchEditRecord(hit).catch((err) => {
          console.warn(
            `[edits] could not fetch a shared edit chunk from ${hit.did}.`,
            err,
          );
          return null;
        }),
      ),
    );
    return fetched.filter(
      (record): record is EditChunkRecord => record !== null,
    );
  } catch (err) {
    console.warn("[edits] constellation discovery failed.", err);
    return [];
  }
};
