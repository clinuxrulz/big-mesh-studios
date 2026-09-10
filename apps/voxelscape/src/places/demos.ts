// The place projects this world ships as demonstrations. A built-in demo is a
// working place that is not published anywhere: `/place:demo` reloads into one
// and `App.tsx` opens it straight from here, so a newcomer can walk a scripted
// world without an account or a zip. Each demo's model files live under
// `public/models/` and are read as bytes when the demo opens; its script source
// is a real TypeScript file imported as raw text, so it is written and read the
// way a creator's own script is.
import { MAIN_SCRIPT_FILE, type PlaceProject } from "./project";
import type { PlaceManifest } from "./place";
import GASA4_SCRIPT from "./demo-scripts/gasa4.ts?raw";

/** One built-in demo: the world it names, its scripts, and the models they wear. */
export interface BuiltinDemo {
  id: string;
  name: string;
  /** The manifest fields the world boots from, script list excluded. */
  manifest: Omit<PlaceManifest, "scripts">;
  /** The demo's script files, keyed by manifest-relative path. */
  scripts: Record<string, string>;
  /** Model files under `public/models/` the scripts name, fetched when it opens. */
  modelFiles: string[];
}

/**
 * The "Get a Snack at 4 AM" demo: a flat street of brick houses under a pinned
 * 4 AM sky, a store with a fridge and a vending machine, two NPCs to talk to,
 * and two endings that eating a snack reaches. It is the proof that a place's
 * script can build its world (`bmsPlan`), stand NPCs and rm-stacker props,
 * define and hand out items, and end the game.
 */
const GASA4: BuiltinDemo = {
  id: "gasa4",
  name: "Get a Snack at 4 AM",
  manifest: {
    name: "Get a Snack at 4 AM",
    seed: 4_004,
    // The player wakes in the bedroom.
    spawn: [-14, 0, -12],
    models: [
      "bed.zip",
      "bathtub.zip",
      "sofa.zip",
      "tv.zip",
      "table.zip",
      "counter.zip",
      "stove.zip",
      "fridge.zip",
      "bench.zip",
      "manhole.zip",
      "trash.zip",
      "register.zip",
      "shelf.zip",
      "vending.zip",
      "chips.zip",
      "orange.zip",
      "colgate.zip",
      "cola.zip",
      "egg.zip",
      "juice.zip",
      "milk.zip",
      "tix.zip",
      "robux.zip",
      "plate.zip",
    ],
  },
  modelFiles: [
    "bed.zip",
    "bathtub.zip",
    "sofa.zip",
    "tv.zip",
    "table.zip",
    "counter.zip",
    "stove.zip",
    "fridge.zip",
    "bench.zip",
    "manhole.zip",
    "trash.zip",
    "register.zip",
    "shelf.zip",
    "vending.zip",
    "chips.zip",
    "orange.zip",
    "colgate.zip",
    "cola.zip",
    "egg.zip",
    "juice.zip",
    "milk.zip",
    "tix.zip",
    "robux.zip",
    "plate.zip",
  ],
  scripts: {
    [MAIN_SCRIPT_FILE]: GASA4_SCRIPT,
  },
};

/** Every built-in demo, in the order a list shows them. */
export const BUILTIN_DEMOS: BuiltinDemo[] = [GASA4];

/** The built-in demo with `id`, or null when there is none. */
export const builtinDemo = (id: string): BuiltinDemo | null =>
  BUILTIN_DEMOS.find((demo) => demo.id === id) ?? null;

/**
 * Turns a built-in demo into the project the world boots from, reading the
 * model files it names from the site's `models/` directory. A model that will
 * not load is left out, so a demo still opens without its props rather than
 * failing whole.
 */
export const loadBuiltinDemo = async (
  demo: BuiltinDemo,
): Promise<PlaceProject> => {
  const models: Record<string, Uint8Array> = {};
  for (const file of demo.modelFiles) {
    try {
      const response = await fetch(`./models/${file}`);
      if (response.ok) {
        models[file] = new Uint8Array(await response.arrayBuffer());
      }
    } catch {
      // A demo without one of its models is still a working demo.
    }
  }
  return {
    manifest: { ...demo.manifest, scripts: Object.keys(demo.scripts) },
    scripts: demo.scripts,
    models,
  };
};
