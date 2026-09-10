// Where a walk trace goes when the world posts one.
//
// The world runs in a browser and the person reading its traces works in this
// repository, so a trace that lands in a downloads folder has to be carried
// across by hand every time. This receives it on the development server
// instead and writes it beside the benchmark's own reports, where it can be
// read without anybody moving anything.
//
// Development only: `configureServer` never runs for a build, so nothing here
// reaches a page that is served rather than developed.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import type { Plugin } from "vite";

const APP_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = join(APP_DIR, "e2e", ".out");

/** The path a trace posted now is written to, named so it sorts by when. */
const traceFile = (name: string): string => {
  const slug =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 40) || "walk";
  return join(OUT_DIR, `walktrace-${slug}-${Date.now()}.json`);
};

/** The most a single trace may be, in bytes; a body past it is refused. */
const MOST_BYTES = 64 * 1024 * 1024;

/**
 * Receives `POST /__walktrace` and writes what it carries into `e2e/.out`,
 * answering with the path it wrote so the world can say where the trace went.
 */
export const walkTraceEndpoint = (): Plugin => ({
  name: "voxelscape-walk-trace",
  configureServer(server) {
    server.middlewares.use("/__walktrace", (request, response, next) => {
      if (request.method !== "POST") {
        next();
        return;
      }
      const chunks: Buffer[] = [];
      let bytes = 0;
      let refused = false;
      request.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > MOST_BYTES) {
          refused = true;
          response.statusCode = 413;
          response.end("walk trace too large");
          request.destroy();
          return;
        }
        chunks.push(chunk);
      });
      request.on("end", () => {
        if (refused) {
          return;
        }
        try {
          const body = Buffer.concat(chunks).toString("utf8");
          const name = (JSON.parse(body) as { name?: string }).name ?? "walk";
          mkdirSync(OUT_DIR, { recursive: true });
          const path = traceFile(name);
          writeFileSync(path, body);
          const shown = relative(APP_DIR, path);
          // Said on the server's own console too, so the path is in the
          // terminal of whoever is going to read the trace.
          server.config.logger.info(`walk trace written to ${shown}`);
          response.setHeader("content-type", "application/json");
          response.end(JSON.stringify({ path: shown }));
        } catch (error) {
          response.statusCode = 400;
          response.end(error instanceof Error ? error.message : "bad trace");
        }
      });
    });
  },
});
