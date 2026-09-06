// A place as something a creator works on: the manifest that names the world,
// plus the script files it carries, held together as one project. A place zip
// is the project's single artifact — a draft is saved, an opened place is
// read back, and a publish happens, all through the same manifest + scripts
// shape — so nothing outside this module needs to know how the two relate.
import JSZip from "jszip";
import { readPlaceZip } from "./package";
import {
  PLACE_MANIFEST_FILE,
  PLACE_MIME_TYPE,
  type PlaceManifest,
} from "./place";

/** The script file a freshly created place starts with. */
export const MAIN_SCRIPT_FILE = "main.ts";

/** The source a new place begins editing from, typed the way a place script expects to be. */
export const STARTER_SCRIPT = `// Your place's script. Export a bmsTick function and the world will call it
// each step with the shared clock and the events since the last step. The
// TypeScript types are stripped when the script loads, so the panel's
// squiggles are the whole of the type-check; imports may only reach this
// place's own script files. Run /script:demo for a working sample.
declare const engine: {
  dispatch(tag: string, payload: string): void;
  log(line: string): void;
  now(): number;
};

let started = false;

export function bmsTick(clockMs: number, eventsJson: string): void {
  if (!started) {
    started = true;
    engine.dispatch(
      "npc",
      JSON.stringify({ id: "guide", x: 8, z: 8, name: "Guide" }),
    );
    engine.log("your place started");
  }
  const events = JSON.parse(
    eventsJson,
  ) as Array<{ kind: string; producer: string }>;
  for (const event of events) {
    if (event.kind === "npc-talk") {
      engine.dispatch(
        "toast",
        JSON.stringify({ player: event.producer, text: "Hello, traveller." }),
      );
    }
  }
}
`;

/**
 * One working place: the manifest at the top of its zip and every script file
 * it names, keyed by the manifest-relative path.
 */
export interface PlaceProject {
  manifest: PlaceManifest;
  scripts: Record<string, string>;
}

/** A new place project, seeded and starting from a one-file starter script. */
export const emptyPlaceProject = (seed: number): PlaceProject => ({
  manifest: {
    name: "",
    seed,
    spawn: [0, 0, 0],
    scripts: [MAIN_SCRIPT_FILE],
  },
  scripts: { [MAIN_SCRIPT_FILE]: STARTER_SCRIPT },
});

/** The zip a project is published as: the manifest plus each script file. */
export const writePlaceZip = async (project: PlaceProject): Promise<Blob> => {
  const zip = new JSZip();
  const manifest: PlaceManifest = {
    ...project.manifest,
    // The script list is derived from the file map, so the two can never drift
    // apart in the artifact a reader opens.
    scripts: Object.keys(project.scripts),
  };
  zip.file(PLACE_MANIFEST_FILE, JSON.stringify(manifest));
  for (const [name, source] of Object.entries(project.scripts)) {
    zip.file(name, source);
  }
  const bytes = await zip.generateAsync({ type: "arraybuffer" });
  return new Blob([bytes], { type: PLACE_MIME_TYPE });
};

/**
 * Reads a place zip back into an editable project. The manifest gate is
 * `readPlaceZip`, so a zip with no manifest, a malformed one, or one naming a
 * script it does not carry is refused before any file is read.
 */
export const readPlaceProject = async (zip: Blob): Promise<PlaceProject> => {
  const manifest = await readPlaceZip(zip);
  const loaded = await JSZip.loadAsync(await zip.arrayBuffer());
  const scripts: Record<string, string> = {};
  for (const name of manifest.scripts ?? []) {
    // readPlaceZip has already refused a zip missing a named script, so this
    // file is there to read.
    scripts[name] = await loaded.file(name)!.async("text");
  }
  return { manifest, scripts };
};
