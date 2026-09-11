// A generic terminal client for a personal data server: sign in once, the
// same way `ssh` remembers a host key, then run arbitrary commands against
// whichever records and blobs you name — nothing here knows what a
// "place" or a "model" is. Every domain-specific record type either
// application defines is just JSON at this layer.
//
//   pnpm --filter @big-mesh-studios/atproto pds-cli login
//   pds-cli get app.bms.voxelscape.place home
//   pds-cli put app.bms.voxelscape.place home @record.json
//   pds-cli upload-blob ./place.zip
//   pds-cli xrpc get com.atproto.identity.resolveHandle '{"handle":"bigmesh.eurosky.social"}'
//
// The session this signs in with is saved next to @big-mesh-studios/atproto
// (.session.json, gitignored — never the repository), and is reused —
// refreshed as needed — by every later invocation until `logout` removes it.
import { readFileSync, writeFileSync } from "node:fs";
import * as readline from "node:readline/promises";
import { Client, ok, simpleFetchHandler } from "@atcute/client";
import type { Did, Handle } from "@atcute/lexicons";
import {
  createDidDocumentResolver,
  createHandleResolver,
  pdsEndpoint,
} from "./identity.ts";
import { listAllRecords, type AtprotoRepoClient } from "./repo-client.ts";
import {
  clearSession,
  clientFromSession,
  login as passwordLogin,
  requireSession,
  saveSession,
  type SavedSession,
} from "./password-session.ts";

const USAGE = `usage:
  pds-cli login
  pds-cli logout
  pds-cli whoami
  pds-cli get <collection> <rkey> [--repo=<handle-or-did>]
  pds-cli list <collection> [--repo=<handle-or-did>]
  pds-cli put <collection> <rkey> <json|@file>
  pds-cli delete <collection> <rkey>
  pds-cli upload-blob <file> [--type=<mime>]
  pds-cli get-blob <cid> [--repo=<handle-or-did>] [--out=<path>]
  pds-cli xrpc get <nsid> [params json]
  pds-cli xrpc post <nsid> [params json] [input json]

--repo defaults to the signed-in account. Session lives in this package's
own .session.json (gitignored), refreshed automatically; run \`login\` again
once its refresh token itself expires.`;

// --- argument parsing -------------------------------------------------

/** Splits `--key=value` flags out from the positional arguments around them. */
const parseArgs = (
  argv: string[],
): { positional: string[]; flags: Record<string, string> } => {
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  for (const arg of argv) {
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      if (eq === -1) {
        flags[arg.slice(2)] = "true";
      } else {
        flags[arg.slice(2, eq)] = arg.slice(eq + 1);
      }
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags };
};

/** `arg` itself as JSON, or the JSON in the file it names when it starts with `@`. */
const readJsonArg = (arg: string): unknown =>
  JSON.parse(arg.startsWith("@") ? readFileSync(arg.slice(1), "utf8") : arg);

const guessMimeType = (path: string): string => {
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  const known: Record<string, string> = {
    zip: "application/zip",
    json: "application/json",
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    webp: "image/webp",
    txt: "text/plain",
  };
  return known[ext] ?? "application/octet-stream";
};

// --- interactive login prompts -----------------------------------------

const promptLine = async (label: string): Promise<string> => {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    return (await rl.question(label)).trim();
  } finally {
    rl.close();
  }
};

/** Prompts for a line without echoing it, the way a terminal password field does. */
const promptHidden = (label: string): Promise<string> =>
  new Promise((resolve) => {
    process.stdout.write(label);
    const { stdin } = process;
    const wasRaw = stdin.isTTY ? stdin.isRaw : false;
    stdin.setRawMode?.(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    let input = "";
    const onData = (char: string): void => {
      if (char === "\n" || char === "\r" || char === "") {
        stdin.setRawMode?.(wasRaw);
        stdin.pause();
        stdin.removeListener("data", onData);
        process.stdout.write("\n");
        resolve(input);
        return;
      }
      if (char === "") {
        process.stdout.write("\n");
        process.exit(130);
      }
      if (char === "" || char === "\b") {
        input = input.slice(0, -1);
        return;
      }
      input += char;
    };
    stdin.on("data", onData);
  });

const resolveRepo = async (input: string): Promise<string> =>
  input.startsWith("did:")
    ? input
    : await createHandleResolver().resolve(input as Handle);

// --- commands -------------------------------------------------------------

const runLogin = async (): Promise<void> => {
  const handle = await promptLine("handle: ");
  const password = await promptHidden("app password: ");
  const session = await passwordLogin({ handle, password });
  saveSession(session);
  console.log(`signed in as ${session.handle} (${session.did})`);
};

const runLogout = (): void => {
  clearSession();
  console.log("signed out");
};

const runWhoami = async (): Promise<void> => {
  const session = await requireSession();
  console.log(`${session.handle} (${session.did}) on ${session.service}`);
};

const runGet = async (
  client: AtprotoRepoClient,
  repo: string,
  positional: string[],
): Promise<void> => {
  const [collection, rkey] = positional;
  if (collection === undefined || rkey === undefined) {
    throw new Error(USAGE);
  }
  const { value } = await client.getRecord({ repo, collection, rkey });
  console.log(JSON.stringify(value, null, 2));
};

const runList = async (
  client: AtprotoRepoClient,
  repo: string,
  positional: string[],
): Promise<void> => {
  const [collection] = positional;
  if (collection === undefined) {
    throw new Error(USAGE);
  }
  const records = await listAllRecords(client, { repo, collection });
  console.log(
    JSON.stringify(
      records.map(({ uri, value }) => ({
        rkey: uri.slice(uri.lastIndexOf("/") + 1),
        value,
      })),
      null,
      2,
    ),
  );
};

const runPut = async (
  client: AtprotoRepoClient,
  repo: string,
  positional: string[],
): Promise<void> => {
  const [collection, rkey, json] = positional;
  if (collection === undefined || rkey === undefined || json === undefined) {
    throw new Error(USAGE);
  }
  const record = readJsonArg(json) as { [_ in string]: unknown };
  await client.putRecord({ repo, collection, rkey, record });
  console.log(`put at://${repo}/${collection}/${rkey}`);
};

const runDelete = async (
  client: AtprotoRepoClient,
  repo: string,
  positional: string[],
): Promise<void> => {
  const [collection, rkey] = positional;
  if (collection === undefined || rkey === undefined) {
    throw new Error(USAGE);
  }
  await client.deleteRecord({ repo, collection, rkey });
  console.log(`deleted at://${repo}/${collection}/${rkey}`);
};

const runUploadBlob = async (
  session: SavedSession,
  positional: string[],
  flags: Record<string, string>,
): Promise<void> => {
  const [path] = positional;
  if (path === undefined) {
    throw new Error(USAGE);
  }
  const bytes = readFileSync(path);
  const blob = new Blob([bytes], { type: flags.type ?? guessMimeType(path) });
  const ref = await clientFromSession(session).uploadBlob(blob);
  console.log(JSON.stringify(ref, null, 2));
};

const runGetBlob = async (
  session: SavedSession,
  positional: string[],
  flags: Record<string, string>,
): Promise<void> => {
  const [cid] = positional;
  if (cid === undefined) {
    throw new Error(USAGE);
  }
  const did =
    flags.repo !== undefined ? await resolveRepo(flags.repo) : session.did;
  const service = pdsEndpoint(
    await createDidDocumentResolver().resolve(did as Did<"plc" | "web">),
  );
  const response = await ok(
    new Client({ handler: simpleFetchHandler({ service }) }).get(
      "com.atproto.sync.getBlob",
      { params: { did: did as Did, cid }, as: "bytes" },
    ),
  );
  const bytes = response as unknown as Uint8Array;
  if (flags.out !== undefined) {
    writeFileSync(flags.out, bytes);
    console.log(`wrote ${bytes.byteLength} byte(s) to ${flags.out}`);
  } else {
    process.stdout.write(bytes);
  }
};

const runXrpc = async (
  session: SavedSession,
  method: "get" | "post",
  positional: string[],
): Promise<void> => {
  const [nsid, paramsJson, inputJson] = positional;
  if (nsid === undefined) {
    throw new Error(USAGE);
  }
  // Only the fixed set of record/blob calls above stay inside the typed
  // `AtprotoRepoClient` surface; an arbitrary NSID chosen at runtime cannot
  // be checked against it, which is the whole point of this escape hatch.
  const client = new Client({
    handler: (pathname, init) => {
      const headers = new Headers(init.headers);
      headers.set("authorization", `Bearer ${session.accessJwt}`);
      return simpleFetchHandler({ service: session.service })(pathname, {
        ...init,
        headers,
      });
    },
  });
  const params = paramsJson !== undefined ? readJsonArg(paramsJson) : undefined;
  const input = inputJson !== undefined ? readJsonArg(inputJson) : undefined;
  const response =
    method === "get"
      ? await ok((client.get as any)(nsid, { params, as: "json" }))
      : await ok((client.post as any)(nsid, { params, input, as: "json" }));
  console.log(JSON.stringify(response, null, 2));
};

// --- entry point -----------------------------------------------------------

const main = async (): Promise<void> => {
  const [command, ...rest] = process.argv.slice(2);

  if (command === undefined) {
    throw new Error(USAGE);
  }
  if (command === "login") {
    return runLogin();
  }
  if (command === "logout") {
    return runLogout();
  }
  if (command === "whoami") {
    return runWhoami();
  }
  if (command === "xrpc") {
    const [sub, ...xrpcRest] = rest;
    if (sub !== "get" && sub !== "post") {
      throw new Error(USAGE);
    }
    return runXrpc(await requireSession(), sub, xrpcRest);
  }

  const { positional, flags } = parseArgs(rest);
  const session = await requireSession();
  const client = clientFromSession(session);
  const repo =
    flags.repo !== undefined ? await resolveRepo(flags.repo) : session.did;

  switch (command) {
    case "get":
      return runGet(client, repo, positional);
    case "list":
      return runList(client, repo, positional);
    case "put":
      return runPut(client, repo, positional);
    case "delete":
      return runDelete(client, repo, positional);
    case "upload-blob":
      return runUploadBlob(session, positional, flags);
    case "get-blob":
      return runGetBlob(session, positional, flags);
    default:
      throw new Error(USAGE);
  }
};

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
