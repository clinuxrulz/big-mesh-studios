// A non-interactive sign-in for scripts and command-line tools: atproto's
// plain identifier/password session (`com.atproto.server.createSession`),
// the same "app password" scheme the reference clients offer as an
// alternative to browser sign-in. There is no popup to open and no redirect
// to land, so this is what a tool run from a terminal authenticates with
// instead of the OAuth flow the browser applications use.
//
// A session obtained this way is meant to be kept, not re-created every
// time: `login` is the one call that ever needs the password, and its result
// is plain, JSON-serializable data a caller can write to disk and hand back
// to `refresh` or `clientFromSession` on a later run. The refresh token
// rotates on every use, so whatever calls `refresh` has to persist the
// session it returns before the one it was given stops working.
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client, ok, simpleFetchHandler } from "@atcute/client";
import type { Did, Handle } from "@atcute/lexicons";
import {
  createDidDocumentResolver,
  createHandleResolver,
  pdsEndpoint,
} from "./identity.ts";
import {
  createAtprotoRepoClient,
  type AtprotoBlobClient,
  type AtprotoRepoClient,
} from "./repo-client.ts";

/** Everything a later run needs to act as the signed-in account, with no password in sight. */
export interface SavedSession {
  service: string;
  did: string;
  handle: string;
  accessJwt: string;
  refreshJwt: string;
}

const resolveServiceFor = async (did: string): Promise<string> =>
  pdsEndpoint(
    await createDidDocumentResolver().resolve(did as Did<"plc" | "web">),
  );

/**
 * Signs in with a handle and an app password. Resolves the account's own
 * server first, since a session can only be created on the server that
 * holds the account.
 *
 * @throws When the handle does not resolve, or the server refuses the
 * identifier/password pair.
 */
export const login = async (params: {
  handle: string;
  password: string;
}): Promise<SavedSession> => {
  const ownDid = await createHandleResolver().resolve(params.handle as Handle);
  const service = await resolveServiceFor(ownDid);
  const session = await ok(
    new Client({ handler: simpleFetchHandler({ service }) }).post(
      "com.atproto.server.createSession",
      { input: { identifier: params.handle, password: params.password } },
    ),
  );
  return {
    service,
    did: session.did,
    handle: params.handle,
    accessJwt: session.accessJwt,
    refreshJwt: session.refreshJwt,
  };
};

/**
 * Mints a fresh access token from a saved session's refresh token. The
 * session this returns replaces `saved` wherever it was stored — the
 * refresh token that made it is now spent, and using it again fails.
 *
 * @throws When the refresh token has expired or was already used elsewhere,
 * which only signing in again (`login`) recovers from.
 */
export const refresh = async (saved: SavedSession): Promise<SavedSession> => {
  const session = await ok(
    new Client({
      handler: (pathname, init) => {
        const headers = new Headers(init.headers);
        headers.set("authorization", `Bearer ${saved.refreshJwt}`);
        return simpleFetchHandler({ service: saved.service })(pathname, {
          ...init,
          headers,
        });
      },
    }).post("com.atproto.server.refreshSession"),
  );
  return {
    ...saved,
    accessJwt: session.accessJwt,
    refreshJwt: session.refreshJwt,
  };
};

/** Reads and writes records and blobs as `saved`'s account, using its current access token. */
export const clientFromSession = (
  saved: SavedSession,
): AtprotoRepoClient & AtprotoBlobClient => {
  const authed = new Client({
    handler: (pathname, init) => {
      const headers = new Headers(init.headers);
      headers.set("authorization", `Bearer ${saved.accessJwt}`);
      return simpleFetchHandler({ service: saved.service })(pathname, {
        ...init,
        headers,
      });
    },
  });
  return createAtprotoRepoClient({
    client: authed,
    selfDid: saved.did,
    resolveService: resolveServiceFor,
  });
};

// --- saving a session between runs, one at a time -------------------------
//
// Every command-line tool that signs in shares this one saved session, next
// to this package (.session.json, gitignored) rather than a database — a
// second `login` (a different account, or the same one refreshed) simply
// replaces it. A tool that needs more than one account signed in at once
// asks the person running it to switch between them.

/** This package's own root, wherever it was checked out — not the shell's cwd. */
const PACKAGE_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const SESSION_FILE = join(PACKAGE_DIR, ".session.json");

/** The session last saved by `login` or `requireSession`, or null before any has been. */
export const loadSession = (): SavedSession | null =>
  existsSync(SESSION_FILE)
    ? (JSON.parse(readFileSync(SESSION_FILE, "utf8")) as SavedSession)
    : null;

export const saveSession = (session: SavedSession): void => {
  writeFileSync(SESSION_FILE, JSON.stringify(session, null, 2), {
    mode: 0o600,
  });
};

/** Removes the saved session, if there is one. */
export const clearSession = (): void => {
  rmSync(SESSION_FILE, { force: true });
};

/**
 * The saved session, refreshed and re-saved — never the copy that was on
 * disk, since its refresh token is now spent.
 *
 * @throws When nothing is saved, or the refresh token itself has expired —
 * both recovered from only by signing in again.
 */
export const requireSession = async (): Promise<SavedSession> => {
  const saved = loadSession();
  if (saved === null) {
    throw new Error("not signed in — sign in with pds-cli login first");
  }
  const fresh = await refresh(saved);
  saveSession(fresh);
  return fresh;
};
