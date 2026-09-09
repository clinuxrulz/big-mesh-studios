import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The directory the harnesses under `e2e/` write their output to — `e2e/.out`,
 * or wherever `VOXELSCAPE_E2E_OUT` names instead. The directory is created if
 * it is not there yet.
 */
export const outDir = (): string => {
  const root =
    process.env.VOXELSCAPE_E2E_OUT ??
    join(dirname(fileURLToPath(import.meta.url)), ".out");
  mkdirSync(root, { recursive: true });
  return root;
};

/**
 * Names a file for a harness to write in the output directory.
 *
 * @param name The file's name within the directory.
 * @returns The absolute path to write to.
 */
export const outPath = (name: string): string => join(outDir(), name);
