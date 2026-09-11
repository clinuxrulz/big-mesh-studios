// A client for Constellation (https://constellation.microcosm.blue), a public
// atproto backlink index: it crawls the firehose recording every at-uri it
// finds inside any record, so asking it "who links to this place" answers
// directly. Used for every place with a real address, self included: it
// replaces walking an account's entire edit history and discarding what
// doesn't match this place, with a query already scoped to just this place
// (and, when only self-scoped edits are wanted, just this account within it).
import { Client, ok, simpleFetchHandler } from "@atcute/client";
import type { ActorIdentifier, Did, Nsid, RecordKey } from "@atcute/lexicons";
import {
  createDidDocumentResolver,
  pdsEndpoint,
} from "@big-mesh-studios/atproto/identity";
import {
  EDIT_COLLECTION,
  parseEditChunkRecord,
  type EditChunkRecord,
} from "./edits";

const CONSTELLATION_BASE = "https://constellation.microcosm.blue";
/**
 * The path inside an edit-chunk record Constellation indexes as a link —
 * unqualified, matching Constellation's own convention (`subject.uri`, never
 * `.subject.uri`).
 */
const EDIT_PLACE_PATH = "place";
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
  cursor?: string | null;
}

/**
 * Every hit in `collection`, at `path`, pointing at `subject` — optionally
 * narrowed to just `dids` — paginated until Constellation reports no further
 * cursor or `MAX_HITS` is reached.
 */
const getBacklinks = async (
  subject: string,
  collection: string,
  path: string,
  dids?: string[],
): Promise<ConstellationHit[]> => {
  const hits: ConstellationHit[] = [];
  let cursor: string | undefined;
  do {
    const params = new URLSearchParams({
      subject,
      source: `${collection}:${path}`,
      limit: String(PAGE_LIMIT),
    });
    for (const did of dids ?? []) {
      params.append("did", did);
    }
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
    // Constellation's last page carries a JSON `null` cursor, not an absent
    // field — passing that through as the literal string "null" is what a
    // plain `!== undefined` check here used to do, and Constellation's own
    // parser rejects it as an invalid cursor.
    cursor = body.cursor ?? undefined;
  } while (cursor !== undefined && hits.length < MAX_HITS);
  return hits;
};

const didDocumentResolver = createDidDocumentResolver();

/**
 * The record at `did`/`collection`/`rkey`, read at whichever version it was
 * written and upgraded to the current shape — or null if it isn't an edit
 * chunk at all.
 */
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
  return parseEditChunkRecord(response.value);
};

/**
 * The edit-chunk records for `place` — every account's, or (passing `dids`)
 * only the named accounts' — for a sync to merge into the local overlay.
 * Never throws: a Constellation or PDS failure is reported to the console and
 * treated as no records found, so the rest of a sync still runs.
 */
export const fetchPlaceEditRecords = async (
  place: string,
  dids?: string[],
): Promise<EditChunkRecord[]> => {
  try {
    const hits = await getBacklinks(
      place,
      EDIT_COLLECTION,
      EDIT_PLACE_PATH,
      dids,
    );
    const fetched = await Promise.all(
      hits.map((hit) =>
        fetchEditRecord(hit).catch((err) => {
          console.warn(
            `[edits] could not fetch an edit chunk from ${hit.did}.`,
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
