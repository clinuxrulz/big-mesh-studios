import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Names a file for a harness to write under `e2e/.out`, creating that
 * directory if it is not there yet. `VOXELSCAPE_E2E_OUT` overrides where the
 * directory sits.
 *
 * @param name The file's name within the directory.
 * @returns The absolute path to write to.
 */
export const outPath = (name: string): string => {
  const root =
    process.env.VOXELSCAPE_E2E_OUT ??
    join(dirname(fileURLToPath(import.meta.url)), ".out");
  mkdirSync(root, { recursive: true });
  return join(root, name);
};
