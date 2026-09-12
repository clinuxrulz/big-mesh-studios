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

// The structure plan is drawn in LOD-0 voxel coordinates, so `GROUND` is a
// voxel row: the schoolyard's walkable surface sits at world y 60, the player's
// feet at 62. The obby itself is built high above it, so a fall runs past the
// kill plane before it ever reaches the ground.
const GROUND = 30;
/** The voxel row whose top is the lobby floor; the player is put down on it. */
const LOBBY_VOXEL = 100;
/** The lobby's feet height, in world units: the top of the lobby voxel row. */
const LOBBY = (LOBBY_VOXEL + 1) * 2;
/** Falling with the feet below this height is fatal, in world units. */
const VOID_Y = 150;

/** The points that count as the school's rooms and checkpoint pads. */
const YARD = "yard";
const LOBBY_ZONE = "lobby";
const STAIRS = "stairs";
const PLATFORM_ONE = "platform-one";
const PLATFORM_TWO = "platform-two";
const PLATFORM_THREE = "platform-three";
const OFFICE = "office";

const JANITOR = "janitor";
const PRINCIPAL = "principal";

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

/** The rooms and pads as `[id, minX, minZ, maxX, maxZ, minY, maxY]`, in world units. */
const ZONES: Array<[string, number, number, number, number, number, number]> = [
  [YARD, -120, -120, 120, 120, 0, 120],
  [LOBBY_ZONE, -30, -10, 30, 30, LOBBY, LOBBY + 12],
  [STAIRS, -10, -30, 10, -14, 218, 230],
  [PLATFORM_ONE, -8, -4, 8, 8, 220, 232],
  [PLATFORM_TWO, -8, 14, 8, 26, 222, 234],
  [PLATFORM_THREE, -8, 32, 8, 44, 224, 236],
  [OFFICE, -12, 50, 12, 66, 226, 238],
];

/**
 * Where each checkpoint pad respawns the player, as `[x, z, feetY]`. The lobby
 * is the first checkpoint, so a fall before the first pad returns there.
 */
const CHECKPOINTS: Record<string, [number, number, number]> = {
  [LOBBY_ZONE]: [0, 10, LOBBY],
  [STAIRS]: [0, -22, 218],
  [PLATFORM_ONE]: [0, 2, 220],
  [PLATFORM_TWO]: [0, 20, 222],
  [PLATFORM_THREE]: [0, 38, 224],
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
      "You did not make it. Whatever the principal was going to say, this is worse.",
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
    text: name,
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
    // The lobby floor, high enough that a fall from the obby is fatal.
    box(-30, LOBBY_VOXEL, -10, 30, LOBBY_VOXEL, 30, b.greystone),
    // The staircase climbing out of the lobby to the first checkpoint.
    {
      kind: "stairs",
      at: [-5, LOBBY_VOXEL + 1, -30],
      along: "z",
      steps: 8,
      rise: 1,
      run: 2,
      width: 10,
      id: b.greystone,
    },
    box(-10, 108, -30, 10, 108, -14, b.greystone),
    // The floating pads, each a short jump past the last.
    box(-8, 109, -4, 8, 109, 8, b.wood),
    box(-8, 110, 14, 8, 110, 26, b.wood),
    box(-8, 111, 32, 8, 111, 44, b.wood),
    // The principal's office at the end of the course.
    box(-12, 112, 50, 12, 112, 66, b.greystone),
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

  for (const [id, minX, minZ, maxX, maxZ, minY, maxY] of ZONES) {
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
    x: -12,
    z: 10,
    y: LOBBY,
    name: "Soap",
    height: 0.4,
    solid: false,
  });
  // The wet floor sign on the second pad: touching it is fatal.
  dispatch("prop", {
    id: "wet-floor",
    model: "wet-floor.zip",
    x: 0,
    z: 20,
    y: 222,
    name: "Wet Floor",
    height: 1.5,
    solid: false,
    hazard: true,
  });

  // A plank that slides back and forth across the first gap, carrying whoever
  // stands on it. Its path is an offset from where it sits.
  dispatch("prop", {
    id: "moving-plank",
    model: "platform.zip",
    x: 0,
    z: -9,
    y: 218,
    name: "Moving Plank",
    height: 2,
    solid: true,
    motion: {
      path: [
        [0, 0, 0],
        [0, 0, 10],
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
    z: 12,
    y: 218,
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
  // A toilet roll tumbling down the stairs beside the climb.
  dispatch("prop", {
    id: "toilet-roll",
    model: "toilet-roll.zip",
    x: 2,
    z: -16,
    y: 218,
    name: "Toilet Roll",
    height: 1,
    solid: false,
    motion: {
      path: [
        [0, 0, 0],
        [0, -16, -14],
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
    z: 10,
    y: LOBBY,
    name: "Janitor",
    model: "npc-sable.zip",
    yaw: Math.PI / 2,
  });
  dispatch("npc", {
    id: PRINCIPAL,
    x: 0,
    z: 62,
    y: 226,
    name: "Principal",
    model: "npc-rook.zip",
    yaw: Math.PI,
  });

  // The player spawns on the schoolyard ground; the game begins up in the
  // lobby. Teleport them up before the kill plane is armed.
  dispatch("player-place", { player: "", x: 0, z: 10, y: LOBBY });
  dispatch("void", { y: VOID_Y });
  // The meter fills on its own clock; the player has to reach the office
  // before it does.
  showBladder();
  dispatch("timer", { id: "bladder", afterMs: BLADDER_STEP_MS });
  // An opening shot: pull back to show the school, then settle behind the
  // player in the lobby. Control comes back when the last shot ends.
  dispatch("cutscene", {
    player: "",
    shots: [
      { at: [-60, 250, -60], look: [0, 202, 10], durationMs: 0, holdMs: 1_200 },
      {
        at: [0, 226, -40],
        look: [0, 204, 0],
        durationMs: 3_000,
        holdMs: 600,
        ease: "smooth",
      },
    ],
  });
  narrate(
    "You",
    "First day at school. I really, really need the bathroom — the principal's office is the only one that is not out of order.",
  );
}

function hintFor(zone: string): void {
  if (zone === LOBBY_ZONE) {
    narrate("You", "The stairs are through the doors. Do not look down.");
  } else if (zone === STAIRS) {
    narrate(
      "You",
      "Climbing. One slip and it is the schoolyard from very high.",
    );
  } else if (zone === PLATFORM_ONE) {
    narrate("You", "Almost there. Mind the wet floor sign.");
  } else if (zone === PLATFORM_TWO) {
    narrate("You", "The office is just past the last pad.");
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
    narrate("Janitor", "Wet floor. Watch your step up there.");
    return;
  }
  if (npcId === PRINCIPAL) {
    narrate("Principal", "You made it. The bathroom is down the hall.");
  }
}

/** What entering a zone means: a checkpoint, a hint, a beat, or the ending. */
function entered(zone: string): void {
  if (flags.finished === true) {
    return;
  }
  if (zone === OFFICE) {
    ending(
      "Relieved",
      "You made it to the principal's office with your dignity intact. Class begins in five minutes.",
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
  // A one-off camera beat when the climb first begins: look down the stairs
  // at the roll tumbling past.
  if (zone === STAIRS && flags.stairBeat !== true) {
    flags.stairBeat = true;
    dispatch("camera", {
      player: "",
      at: [18, 232, -34],
      look: [0, 210, -22],
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
    narrate("You", "The schoolyard, from the top of the stairs. Ouch.");
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
