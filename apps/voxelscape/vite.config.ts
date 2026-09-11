import { defineConfig } from "vitest/config";
import solid from "vite-plugin-solid";
import { walkTraceEndpoint } from "./tools/walk-trace-endpoint";

export default defineConfig(({ mode, command }) => ({
  // The folder GitHub Pages serves this application from — read from an
  // environment variable the deploy workflow sets, rather than hard-coded,
  // since it differs between a build and the development server. Every asset
  // this application fetches at runtime (`import.meta.env.BASE_URL`, which
  // Vite sets to this same value) is addressed relative to it, so a fetch
  // cannot miss depending on which of this application's own addresses asked
  // for it. Routing itself does not read this — see `routes.tsx`.
  base: process.env.VOXELSCAPE_BASE_PATH ?? "/",
  server: {
    // Named rather than left to the default, which listens on the version six
    // loopback address alone. A browser resolves `localhost` to the version
    // four one, finds nothing listening there, and refuses the connection.
    host: "127.0.0.1",
  },
  define: {
    // Whether this build carries the perf-probe instrumentation
    // (`src/render/perf-probe.ts`, `src/render/perf.ts`). A raw global
    // rather than an imported value, so esbuild substitutes the literal into
    // every file it transforms and can fold away the branch that builds a
    // real probe or timer, before Rollup ever sees it — an imported
    // binding's value isn't known until bundling, too late for that branch,
    // and everything it alone references, to be dropped. Dev and tests keep
    // it on for free; only a plain `vite build` turns it off, and `--mode
    // bench` (`pnpm build:bench`) turns it back on.
    __PERF__: JSON.stringify(command !== "build" || mode === "bench"),
  },
  build: {
    // Written but not pointed at: the built files carry no `sourceMappingURL`,
    // so a browser never fetches a map, while `pnpm bench --functions` reads
    // them off the disk to give a sampled profile the names its source has.
    sourcemap: "hidden",
    // `--mode bench` carries the perf-probe instrumentation a real build
    // tree-shakes away, so it lands beside `dist` rather than replacing it.
    outDir: mode === "bench" ? "dist-bench" : "dist",
  },
  plugins: [solid({ ssr: false }), walkTraceEndpoint()],
  worker: {
    // Every worker in the app is a module worker (`new Worker(..., { type:
    // "module" })`), and one of them runs the editor's language service, which
    // loads the TypeScript compiler from the CDN with a dynamic import. A
    // module worker needs ES output; the iife default cannot hold a
    // code-splitting dynamic import.
    format: "es",
  },
  test: {
    // Running every test file's worker at once starves them all of CPU on a
    // busy machine, which shows up as unrelated tests missing the default
    // timeout. Half the cores leaves each worker enough of a share, and one
    // retry absorbs a test that still loses that race without hiding a test
    // that is actually wrong — a real failure fails again.
    maxWorkers: "50%",
    retry: 1,
  },
}));
