// Builds a place zip ready to publish — the same shape `/place:create` or the
// place editor writes — without needing the game or a browser open. Pairs
// with @big-mesh-studios/atproto's pds-cli: build the zip here, then
// `pds-cli upload-blob` and `pds-cli put` publish it.
//
//   node --experimental-transform-types tools/build-place-zip.ts home multi:edit --seed=54321 --out=/tmp/home.zip
import { writeFileSync } from "node:fs";
import { PLACE_MODES, type PlaceMode } from "../src/places/place.ts";
import { emptyPlaceProject, writePlaceZip } from "../src/places/project.ts";

const USAGE = `usage: build-place-zip <name> [mode] [--seed=<n>] [--spawn=x,y,z] [--out=<path>]
modes: ${PLACE_MODES.join(", ")}`;

const isPlaceMode = (value: string | undefined): value is PlaceMode =>
  PLACE_MODES.includes(value as PlaceMode);

const main = async (): Promise<void> => {
  const argv = process.argv.slice(2);
  const positional = argv.filter((arg) => !arg.startsWith("--"));
  const flags: Record<string, string> = {};
  for (const arg of argv.filter((arg) => arg.startsWith("--"))) {
    const eq = arg.indexOf("=");
    flags[arg.slice(2, eq)] = arg.slice(eq + 1);
  }

  const [name, maybeMode] = positional;
  if (name === undefined) {
    throw new Error(USAGE);
  }

  const seed =
    flags.seed !== undefined
      ? Number(flags.seed)
      : Math.floor(Math.random() * 2 ** 31);
  const project = emptyPlaceProject(seed);
  project.manifest.name = name;
  if (isPlaceMode(maybeMode)) {
    project.manifest.mode = maybeMode;
  }
  if (flags.spawn !== undefined) {
    const [x, y, z] = flags.spawn.split(",").map(Number) as [
      number,
      number,
      number,
    ];
    project.manifest.spawn = [x, y, z];
  }

  const zip = await writePlaceZip(project);
  const out = flags.out ?? `${name}.zip`;
  writeFileSync(out, Buffer.from(await zip.arrayBuffer()));
  console.log(
    `wrote ${out} (seed ${seed}${isPlaceMode(maybeMode) ? `, mode ${maybeMode}` : ""})`,
  );
};

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
