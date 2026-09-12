// The "Don't Poop Yourself at School" demo's place script. This file is the
// source a creator would write: it is imported with `?raw` and handed to the
// sandbox as text, never run as part of the world's own bundle. Its
// `declare const engine` is the guest API the interpreter injects. Moving
// props declare a `motion` once; the world samples it against the shared
// clock, so a platform a player rides is where every peer says it is.
declare const engine: {
  dispatch(tag: string, payload: string): void;
  log(line: string): void;
  now(): number;
  endings(): string;
  blocks: Record<string, number>;
};

/** One fact the world hands the script, as the script reads it back. */
interface Event {
  kind: string;
  producer: string;
  item?: string;
  entityId?: string;
  npcId?: string;
  option?: number;
  zoneId?: string;
  timerId?: string;
  cause?: string;
}

// The structure plan is drawn in LOD-0 voxel coordinates (two world units per
// voxel), while zones, checkpoints, props and camera shots speak world units.
// The school is a row of elevated floors over the yard: the classroom lobby
// at the top of row 100, then a staircase climbing east out of it, then pads
// and a restroom floating high enough that any fall ends below the kill
// plane. The course runs from west to east: lobby, stairs, hallway, gym,
// final pads, and the restroom's hallway beyond.
const GROUND = 30;
/** The voxel row whose top is the lobby floor; the player is put down on it. */
const LOBBY_VOXEL = 100;
/** The lobby's feet height, in world units: the top of the lobby voxel row. */
const LOBBY = (LOBBY_VOXEL + 1) * 2;
/** Falling with the feet below this height is fatal, in world units. */
const VOID_Y = 150;

/** The points that count as the school's floors and checkpoint pads. */
const YARD = "yard";
const LOBBY_ZONE = "lobby";
const STAIRS = "stairs";
const HALLWAY = "hallway";
const GYM = "gym";
const FINAL = "final";
const BATHROOM = "bathroom";

const JANITOR = "janitor";
const TEACHER = "teacher";

/** How many beats the bladder meter fills over before the game is lost. */
const BLADDER_MAX = 10;
/** Milliseconds between one bladder beat and the next. */
const BLADDER_STEP_MS = 8_000;

let started = false;
let deaths = 0;
/** How full the bladder meter is; full loses the game. */
let bladder = 0;
/** The item the script last told the world the player is holding. */
let held = "";
const inZone: Record<string, boolean> = {};
const hinted: Record<string, boolean> = {};
const flags: Record<string, boolean> = {};

/**
 * The floors and pads as `[id, minX, minY, minZ, maxX, maxY, maxZ]`, all in
 * world units and covering the walkable surface plus the air over it. The
 * ranges are disjoint after the stairs, so entering the restroom's zone is
 * the win and not something touching the last pad already grants.
 */
const ZONES: Array<[string, number, number, number, number, number, number]> = [
  [YARD, -120, 0, -120, 120, 120, 120],
  [LOBBY_ZONE, -60, 200, -80, 60, 216, -18],
  [STAIRS, -16, 200, -20, 16, 222, 28],
  [HALLWAY, -16, 216, 40, 16, 222, 63],
  [GYM, -16, 216, 64, 16, 222, 87],
  [FINAL, -16, 218, 88, 16, 226, 107],
  [BATHROOM, -22, 218, 108, 22, 228, 138],
];

/** What each checkpoint pad's HUD readout is called. */
const CHECKPOINT_LABELS: Record<string, string> = {
  [LOBBY_ZONE]: "The Lobby",
  [STAIRS]: "The Stairs",
  [HALLWAY]: "The Hallway",
  [GYM]: "The Gym",
  [FINAL]: "The Last Pads",
  [BATHROOM]: "The Restroom",
};

/**
 * Where each checkpoint pad respawns the player, as `[x, z, feetY]`, every
 * spot on a real surface. The lobby is the first checkpoint, so a fall before
 * the first pad returns there.
 */
const CHECKPOINTS: Record<string, [number, number, number]> = {
  [LOBBY_ZONE]: [0, -40, LOBBY],
  [STAIRS]: [0, 16, 218],
  [HALLWAY]: [0, 52, 218],
  [GYM]: [0, 76, 218],
  [FINAL]: [0, 96, 220],
  [BATHROOM]: [0, 120, 222],
};

function dispatch(tag: string, payload: unknown): void {
  engine.dispatch(tag, JSON.stringify(payload));
}

function say(text: string): void {
  dispatch("toast", { player: "", text });
}

function narrate(name: string, text: string): void {
  dispatch("narrate", { player: "", name, text });
}

function hold(item: string): void {
  dispatch("item-hold", { player: "", item });
  held = item;
}

function give(item: string, text: string): void {
  dispatch("item-give", { player: "", item, count: 1 });
  hold(item);
  if (text !== "") {
    say(text);
  }
}

function take(item: string, count: number): void {
  dispatch("item-take", { player: "", item, count });
  if (held === item) {
    hold("");
  }
}

function ending(title: string, text: string): void {
  flags.finished = true;
  dispatch("ending", { player: "", title, text });
}

/** Shows the fullness meter at its current value. */
function showBladder(): void {
  dispatch("hud", {
    player: "",
    id: "bladder",
    kind: "bar",
    label: "Bladder",
    value: bladder,
    max: BLADDER_MAX,
  });
}

/** The bladder fills on its own; full means an accident and an ending. */
function bladderBeat(): void {
  if (flags.finished === true || bladder >= BLADDER_MAX) {
    return;
  }
  bladder += 1;
  showBladder();
  if (bladder >= BLADDER_MAX) {
    ending(
      "Accident",
      "You did not make it. Whatever the teacher was going to say, this is worse.",
    );
    return;
  }
  dispatch("timer", { id: "bladder", afterMs: BLADDER_STEP_MS });
}

/** Shows which pad the player last reached. */
function showCheckpoint(name: string): void {
  dispatch("hud", {
    player: "",
    id: "checkpoint",
    kind: "text",
    label: "Checkpoint",
    text: CHECKPOINT_LABELS[name] ?? name,
  });
}

/** One filled box in LOD-0 voxel coordinates, as the plan speaks it. */
function box(
  minX: number,
  minY: number,
  minZ: number,
  maxX: number,
  maxY: number,
  maxZ: number,
  id: number,
): unknown {
  return { kind: "box", min: [minX, minY, minZ], max: [maxX, maxY, maxZ], id };
}

export function bmsPlan(): string {
  const b = engine.blocks;
  const shapes: unknown[] = [
    // A flat schoolyard over the noise, with the hills and trees razed clear.
    box(-160, 0, -160, 160, GROUND - 1, 160, b.dirt),
    box(-160, GROUND, -160, 160, GROUND, 160, b.grass),
    box(-160, GROUND + 1, -160, 160, 90, 160, 0),
    // The classroom lobby, high above the yard: the course's west end.
    box(-30, LOBBY_VOXEL, -40, 30, LOBBY_VOXEL, -11, b.greystone),
    // The staircase climbing east out of the lobby's far edge: eight one-voxel
    // treads, then a solid pedestal whose top is the first checkpoint, so the
    // ascent is attached and every rise is exactly one step.
    {
      kind: "stairs",
      at: [-7, LOBBY_VOXEL + 1, -11],
      along: "z",
      steps: 8,
      rise: 1,
      run: 2,
      width: 15,
      id: b.greystone,
    },
    box(-7, 101, 4, 7, 108, 12, b.greystone),
    // The pads of the hallway and gym, each a short hop past the last.
    box(-7, 108, 22, 7, 108, 30, b.wood),
    box(-5, 108, 34, 5, 108, 42, b.wood),
    box(-5, 109, 44, 5, 109, 52, b.wood),
    // The restroom floor at the east end of the course.
    box(-8, 110, 54, 8, 110, 67, b.greystone),
  ];
  return JSON.stringify(shapes);
}

/** Places the items, zones, props, and NPCs the school opens with. */
function open(): void {
  dispatch("time", { seconds: 480, speed: 0 });
  dispatch("item-define", {
    id: "soap",
    name: "Soap",
    sprite: "",
    stackable: false,
  });

  for (const [id, minX, minY, minZ, maxX, maxY, maxZ] of ZONES) {
    dispatch("zone", {
      id,
      name: id,
      min: [minX, minY, minZ],
      max: [maxX, maxY, maxZ],
    });
  }

  // A pickup on the lobby floor that makes the jumps a little easier.
  dispatch("prop", {
    id: "soap",
    model: "soap.zip",
    x: -10,
    z: -30,
    y: LOBBY,
    name: "Soap",
    height: 0.4,
    solid: false,
  });
  // The wet floor sign in the middle of the first pad; touching it is fatal.
  dispatch("prop", {
    id: "wet-floor",
    model: "wet-floor.zip",
    x: 4,
    z: 52,
    y: 218,
    name: "Wet Floor",
    height: 1.5,
    solid: false,
    hazard: true,
  });

  // A plank that slides back and forth across the gap between the staircase
  // pedestal and the first pad, carrying whoever stands on it. Its path is an
  // offset from where it sits.
  dispatch("prop", {
    id: "moving-plank",
    model: "platform.zip",
    x: 0,
    z: 26,
    y: 216,
    name: "Moving Plank",
    height: 2,
    solid: true,
    motion: {
      path: [
        [0, 0, 0],
        [0, 0, 14],
      ],
      loop: "pingpong",
      durationMs: 4_000,
      ease: "smooth",
    },
  });
  // A disc between the first and second pads, always turning.
  dispatch("prop", {
    id: "turntable",
    model: "platform.zip",
    x: 0,
    z: 64,
    y: 216,
    name: "Turntable",
    height: 2,
    solid: true,
    motion: {
      path: [[0, 0, 0]],
      loop: "loop",
      durationMs: 1_000,
      spin: { axis: [0, 1, 0], turnsPerSecond: 0.08 },
    },
  });
  // A toilet roll tumbling down the staircase beside the climb, the school's
  // famous hazard. It comes down the slope on its own clock.
  dispatch("prop", {
    id: "toilet-roll",
    model: "toilet-roll.zip",
    x: 2,
    z: 18,
    y: 218,
    name: "Toilet Roll",
    height: 1,
    solid: false,
    motion: {
      path: [
        [0, 0, 0],
        [0, -14, -48],
      ],
      loop: "loop",
      durationMs: 6_000,
      ease: "smooth",
      spin: { axis: [1, 0, 0], degreesPerMeter: 120 },
    },
  });

  dispatch("npc", {
    id: JANITOR,
    x: -20,
    z: -30,
    y: LOBBY,
    name: "Janitor",
    model: "npc-sable.zip",
    yaw: Math.PI / 2,
  });
  dispatch("npc", {
    id: TEACHER,
    x: 0,
    z: 120,
    y: 222,
    name: "Teacher",
    model: "npc-rook.zip",
    yaw: Math.PI,
  });

  // The player spawns on the schoolyard ground; the game begins up in the
  // lobby. Teleport them up before the kill plane is armed.
  dispatch("player-place", { player: "", x: 0, z: -40, y: LOBBY });
  dispatch("void", { y: VOID_Y });
  // The meter fills on its own clock; the player has to reach the restroom
  // before it does.
  showBladder();
  dispatch("timer", { id: "bladder", afterMs: BLADDER_STEP_MS });
  // An opening shot: pull back to show the school, then settle behind the
  // player in the lobby. Control comes back when the last shot ends.
  dispatch("cutscene", {
    player: "",
    shots: [
      {
        at: [-60, 268, -140],
        look: [0, 206, -10],
        durationMs: 0,
        holdMs: 1_200,
      },
      {
        at: [0, 226, -66],
        look: [0, 205, -18],
        durationMs: 3_000,
        holdMs: 600,
        ease: "smooth",
      },
    ],
  });
  narrate(
    "You",
    "My teacher will not give me a hall pass, and the restroom is the far end of the school. I have maybe a minute.",
  );
}

function hintFor(zone: string): void {
  if (zone === LOBBY_ZONE) {
    narrate("You", "The stairs are at the end of the lobby. Do not look down.");
  } else if (zone === STAIRS) {
    narrate(
      "You",
      "Climbing. And look — the toilet paper is coming down. Let it pass.",
    );
  } else if (zone === HALLWAY) {
    narrate("You", "The janitor left the floor wet out here. Mind the sign.");
  } else if (zone === GYM) {
    narrate("You", "The gym keeps a spinning disc under its floor.");
  } else if (zone === FINAL) {
    narrate("You", "The restroom is just past these last pads.");
  }
}

/** Uses the soap: a small jump boost, once. */
function useSoap(): void {
  if (held !== "soap") {
    narrate("You", "There is nothing in my hands.");
    return;
  }
  take("soap", 1);
  dispatch("player-jump", { player: "", multiplier: 1.4 });
  narrate("You", "Slippery hands. Slippery feet. A little more jump.");
}

function used(entityId: string, item: string): void {
  void item;
  if (entityId === "soap") {
    dispatch("prop-remove", { id: "soap" });
    give("soap", "You pocket the soap.");
    return;
  }
  if (entityId === "wet-floor") {
    narrate("You", "That sign is not there to be touched.");
  }
}

function usedItem(item: string): void {
  if (item === "soap") {
    useSoap();
    return;
  }
  narrate("You", "I should not use that here.");
}

function talked(npcId: string): void {
  if (npcId === JANITOR) {
    narrate("Janitor", "Wet floor on the first pad. Watch your step up there.");
    return;
  }
  if (npcId === TEACHER) {
    narrate(
      "Teacher",
      "You made it. Through that door — go. I will cover for you.",
    );
  }
}

/** What entering a zone means: a checkpoint, a hint, a beat, or the ending. */
function entered(zone: string): void {
  if (flags.finished === true) {
    return;
  }
  if (zone === BATHROOM) {
    ending(
      "Relieved",
      "You made it to the restroom in time. Class can wait — the teacher said so.",
    );
    return;
  }
  const spot = CHECKPOINTS[zone];
  if (spot !== undefined) {
    dispatch("player-checkpoint", {
      player: "",
      x: spot[0],
      z: spot[1],
      y: spot[2],
    });
    showCheckpoint(zone);
  }
  // A one-off camera beat when the climb begins: look back down the stairs at
  // the roll tumbling past.
  if (zone === STAIRS && flags.stairBeat !== true) {
    flags.stairBeat = true;
    dispatch("camera", {
      player: "",
      at: [30, 234, -8],
      look: [0, 206, -40],
      durationMs: 2_000,
      holdMs: 600,
      ease: "smooth",
    });
  }
}

/** The world reports the player touched a hazard: that is a death. */
function touched(entityId: string): void {
  if (entityId === "wet-floor") {
    dispatch("player-kill", { player: "", cause: "wet-floor" });
  }
}

/** The player died: count it, and say where they came back to. */
function died(cause: string): void {
  deaths += 1;
  if (cause === "void") {
    narrate("You", "Down past the schoolyard again. Ouch.");
  } else {
    narrate("You", "Down you go. Deaths so far: " + deaths + ".");
  }
}

export function bmsTick(_clockMs: number, eventsJson: string): void {
  if (!started) {
    started = true;
    open();
  }
  const events = JSON.parse(eventsJson) as Event[];
  for (const event of events) {
    if (event.kind === "zone-entered" && event.zoneId !== undefined) {
      inZone[event.zoneId] = true;
      entered(event.zoneId);
      if (hinted[event.zoneId] !== true) {
        hinted[event.zoneId] = true;
        hintFor(event.zoneId);
      }
    } else if (event.kind === "zone-left" && event.zoneId !== undefined) {
      delete inZone[event.zoneId];
    } else if (event.kind === "entity-used" && event.entityId !== undefined) {
      used(event.entityId, event.item ?? "");
    } else if (event.kind === "item-used" && event.item !== undefined) {
      usedItem(event.item);
    } else if (event.kind === "npc-talk" && event.npcId !== undefined) {
      talked(event.npcId);
    } else if (
      event.kind === "player-touched" &&
      event.entityId !== undefined
    ) {
      touched(event.entityId);
    } else if (event.kind === "player-died") {
      died(event.cause ?? "");
    } else if (event.kind === "timer" && event.timerId === "bladder") {
      bladderBeat();
    }
  }
}
