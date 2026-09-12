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
import LATE_TO_SCHOOL_SCRIPT from "./demo-scripts/late-to-school.ts?raw";
import DONT_POOP_SCRIPT from "./demo-scripts/dont-poop-yourself-at-school.ts?raw";

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
 * 4 AM sky, a kitchen with a stove and two plates, a store whose counter the
 * cashier rings up at, and two NPCs to talk to. It is the proof that a place's
 * script can build its world (`bmsPlan`), stand NPCs and rm-stacker props,
 * define and hand out items, set timers, place the player, and end the game.
 */
const GASA4: BuiltinDemo = {
  id: "get-a-snack-at-4-am",
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
      "friedegg.zip",
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
    "friedegg.zip",
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

/**
 * The models the "Late to School" demo wears: its neighborhood characters, the
 * fixtures in its houses, school, and shops, and the items its game hands out.
 */
const LATE_TO_SCHOOL_MODELS = [
  "npc-laugh.zip",
  "npc-alex.zip",
  "npc-james.zip",
  "npc-bully.zip",
  "npc-nerd.zip",
  "npc-homeless.zip",
  "npc-brit.zip",
  "npc-brett.zip",
  "npc-brad.zip",
  "npc-sleepa.zip",
  "npc-champ.zip",
  "npc-teacher.zip",
  "npc-lemonade.zip",
  "npc-pothead.zip",
  "npc-santa.zip",
  "npc-obby.zip",
  "npc-littlebro.zip",
  "npc-anomaly.zip",
  "bed.zip",
  "phone.zip",
  "mirror.zip",
  "bookshelf.zip",
  "counter.zip",
  "fridge.zip",
  "tv.zip",
  "sofa.zip",
  "door.zip",
  "mailbox.zip",
  "lemonade-stand.zip",
  "bus-stop.zip",
  "flower.zip",
  "gate.zip",
  "shelf.zip",
  "vending.zip",
  "slushie-machine.zip",
  "arcade.zip",
  "boarded-machine.zip",
  "dumpster.zip",
  "bench.zip",
  "desk.zip",
  "chair.zip",
  "locker.zip",
  "cafeteria-table.zip",
  "plate.zip",
  "poster.zip",
  "plush.zip",
  "banana.zip",
  "chips.zip",
  "key.zip",
  "matches.zip",
  "slushie.zip",
  "pizza.zip",
  "hotdog.zip",
  "salad.zip",
  "taco.zip",
  "historybook.zip",
  "roaster.zip",
  "hat.zip",
  "lemonade.zip",
  "foodbag.zip",
  "bean.zip",
  "cola.zip",
  "tix.zip",
];

/**
 * The "Late to School" demo: a flat block of four houses, a school, a corner
 * shop, and an arcade under a pinned morning sky, with the neighborhood's
 * characters standing in it and the first few endings reachable. It is the
 * proof that a place's script can build a small town (`bmsPlan`), stand a cast
 * of NPCs, define and hand out items, remember the endings a player has reached
 * across restarts, and end the game.
 */
const LATE_TO_SCHOOL: BuiltinDemo = {
  id: "late-to-school",
  name: "Late to School",
  manifest: {
    name: "Late to School",
    // The history book's page and the Dimensionator code, in one seed.
    seed: 2_546,
    // The player wakes in their bedroom.
    spawn: [-12, 0, 16],
    models: LATE_TO_SCHOOL_MODELS,
  },
  modelFiles: LATE_TO_SCHOOL_MODELS,
  scripts: {
    [MAIN_SCRIPT_FILE]: LATE_TO_SCHOOL_SCRIPT,
  },
};

/**
 * The models the "Don't Poop Yourself at School" demo wears: the lobby pickup,
 * the hazard sign, and the two staff figures.
 */
const DONT_POOP_MODELS = [
  "soap.zip",
  "wet-floor.zip",
  "platform.zip",
  "toilet-roll.zip",
  "npc-sable.zip",
  "npc-rook.zip",
];

/**
 * The "Don't Poop Yourself at School" demo: a classroom lobby lifted high over
 * the schoolyard, a staircase climbing east out of it while a giant toilet
 * roll tumbles back down, pads the moving plank, the spinning disc, and the
 * wet-floor sign carry the player past the gym, and a restroom at the far end
 * ends the run before the bladder meter does. It is the proof that a place's
 * script can set checkpoints, kill and respawn the player, hear a hazard
 * touch, and animate its world.
 */
const DONT_POOP: BuiltinDemo = {
  id: "dont-poop-yourself-at-school",
  name: "Don't Poop Yourself at School",
  manifest: {
    name: "Don't Poop Yourself at School",
    seed: 4_202,
    // The player starts on the yard; the script lifts them to the lobby.
    spawn: [0, 0, 0],
    models: DONT_POOP_MODELS,
  },
  modelFiles: DONT_POOP_MODELS,
  scripts: {
    [MAIN_SCRIPT_FILE]: DONT_POOP_SCRIPT,
  },
};

/** Every built-in demo, in the order a list shows them. */
export const BUILTIN_DEMOS: BuiltinDemo[] = [GASA4, LATE_TO_SCHOOL, DONT_POOP];

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
      // Served from the site's own root, the same folder every other address
      // in this application is built from (see `vite.config.ts`'s `base`).
      const response = await fetch(`${import.meta.env.BASE_URL}models/${file}`);
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
