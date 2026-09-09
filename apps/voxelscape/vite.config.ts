import { defineConfig } from "vitest/config";
import solid from "vite-plugin-solid";

export default defineConfig({
  base: "./",
  server: {
    // Named rather than left to the default, which listens on the version six
    // loopback address alone. A browser resolves `localhost` to the version
    // four one, finds nothing listening there, and refuses the connection.
    host: "127.0.0.1",
  },
  plugins: [solid({ ssr: false })],
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
});
