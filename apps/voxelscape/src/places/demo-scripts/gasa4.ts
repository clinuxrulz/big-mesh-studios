// The "Get a Snack at 4 AM" demo's place script. This file is the source a
// creator would write: it is imported with `?raw` and handed to the sandbox as
// text, never run as part of the world's own bundle. Its `declare const engine`
// is the guest API the interpreter injects.
declare const engine: {
  dispatch(tag: string, payload: string): void;
  log(line: string): void;
  now(): number;
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
}

// The walkable surface (grass, floors and paths) is the voxel at world y = 60,
// so the player's feet rest at 62 and the walls start at 62. All furniture and
// items are placed in world units.
const GROUND = 30;
const FLOOR = 62;

const BEDROOM = "bedroom";
const BATHROOM = "bathroom";
const LIVING = "living";
const KITCHEN = "kitchen";
const STORE = "store";

const DAD = "dad";
const CASHIER = "cashier";

let started = false;
let cash = 0;
let chipsEaten = false;
/** Whether the chips were opened somewhere Dad could hear them. */
let chipsLoud = false;
let sodas = 0;
let fridgeUsed = false;
let plateA: string | null = null;
let plateB: string | null = null;
const inZone: Record<string, boolean> = {};
const hinted: Record<string, boolean> = {};

/**
 * The rooms as `[id, minX, minZ, maxX, maxZ]` in world units, in the order the
 * script declares their zones. The first the player stands in is their room.
 */
const ROOMS: Array<[string, number, number, number, number]> = [
  [BEDROOM, -28, -24, 0, 0],
  [BATHROOM, -28, 0, 0, 24],
  [LIVING, 0, -24, 28, 0],
  [KITCHEN, 0, 0, 28, 24],
  [STORE, 52, -16, 72, 16],
];

/** The house and store: floor, walls, doorways, and a wood roof. */
function walls(): unknown[] {
  const b = engine.blocks;
  const w = (
    id: number,
    minX: number,
    minZ: number,
    maxX: number,
    maxZ: number,
  ): unknown => ({
    kind: "box",
    min: [minX, GROUND + 1, minZ],
    max: [maxX, GROUND + 3, maxZ],
    id,
  });
  return [
    // house shell in red brick, front door on the east wall
    w(b.brick, -14, -12, -14, 12),
    w(b.brick, -14, 12, 14, 12),
    w(b.brick, -14, -12, 14, -12),
    w(b.brick, 14, -12, 14, -8),
    w(b.brick, 14, -5, 14, 12),
    // interior cross in a lighter stone, a doorway on each arm
    w(b.greystone, 0, -12, 0, -7),
    w(b.greystone, 0, -5, 0, 5),
    w(b.greystone, 0, 7, 0, 12),
    w(b.greystone, -14, 0, -7, 0),
    w(b.greystone, -5, 0, 5, 0),
    w(b.greystone, 7, 0, 14, 0),
    // store shell in grey stone, door on the west wall
    w(b.greystone, 26, -8, 26, -7),
    w(b.greystone, 26, -5, 26, 8),
    w(b.greystone, 36, -8, 36, 8),
    w(b.greystone, 26, -8, 36, -8),
    w(b.greystone, 26, 8, 36, 8),
  ];
}

export function bmsPlan(): string {
  const b = engine.blocks;
  const shapes: unknown[] = [
    { kind: "box", min: [-80, 0, -80], max: [80, GROUND - 1, 80], id: b.dirt },
    {
      kind: "box",
      min: [-80, GROUND, -80],
      max: [80, GROUND, 80],
      id: b.grass,
    },
    // raze whatever the terrain raised over the neighbourhood
    { kind: "box", min: [-80, GROUND + 1, -80], max: [80, 160, 80], id: 0 },
    // floors and the path from the house to the store
    {
      kind: "box",
      min: [-14, GROUND, -12],
      max: [14, GROUND, 12],
      id: b.ice,
    },
    {
      kind: "box",
      min: [26, GROUND, -8],
      max: [36, GROUND, 8],
      id: b.greystone,
    },
    {
      kind: "road",
      from: [14, GROUND, -6],
      to: [26, GROUND, -6],
      width: 5,
      id: b.greystone,
    },
    ...walls(),
    // roofs
    {
      kind: "box",
      min: [-14, GROUND + 4, -12],
      max: [14, GROUND + 4, 12],
      id: b.wood,
    },
    {
      kind: "box",
      min: [26, GROUND + 4, -8],
      max: [36, GROUND + 4, 8],
      id: b.wood,
    },
  ];
  return JSON.stringify(shapes);
}

function dispatch(tag: string, payload: unknown): void {
  engine.dispatch(tag, JSON.stringify(payload));
}

function say(text: string): void {
  dispatch("toast", { player: "", text });
}

function narrate(name: string, text: string): void {
  dispatch("narrate", { player: "", name, text });
}

function give(item: string, text: string): void {
  dispatch("item-give", { player: "", item, count: 1 });
  dispatch("item-hold", { player: "", item });
  if (text !== "") {
    say(text);
  }
}

function ending(title: string, text: string): void {
  dispatch("ending", { player: "", title, text });
}

function room(): string {
  for (const [id] of ROOMS) {
    if (inZone[id]) {
      return id;
    }
  }
  return "outside";
}

/** The furniture and fixtures: solid props the player walks around and onto. */
const FURNITURE: Array<[string, string, number, number, number]> = [
  ["bed", "bed.zip", -22, -14, 0.5],
  ["bathtub", "bathtub.zip", -22, 14, 1],
  ["sofa", "sofa.zip", 20, -20, 1.2],
  ["tv", "tv.zip", 26, -20, 1.2],
  ["table", "table.zip", 20, -8, 1],
  ["counter", "counter.zip", 20, 6, 1.5],
  ["stove", "stove.zip", 12, 20, 1.5],
  ["fridge", "fridge.zip", 26, 20, 3],
  ["table", "table.zip", 8, 10, 1],
  ["bench", "bench.zip", 44, 12, 0.8],
  ["vending", "vending.zip", 48, -12, 3.5],
  ["manhole", "manhole.zip", 30, -12, 0.2],
  ["trash", "trash.zip", 46, -8, 1.2],
  ["register", "register.zip", 62, 6, 1],
  ["shelf", "shelf.zip", 68, -6, 3],
];

/** Small things lying about: pickups and the plates, none of them solid. */
const PICKUPS: Array<[string, string, number, number, number, number]> = [
  ["chips", "chips.zip", 21, 6, 63.5, 0.6],
  ["orange", "orange.zip", 8, 10, 63, 0.4],
  ["colgate", "colgate.zip", -22, 8, FLOOR, 0.6],
  ["cola", "cola.zip", 24, 18, FLOOR, 0.7],
  ["tix1", "tix.zip", -10, -20, FLOOR, 0.3],
  ["tix2", "tix.zip", 10, 16, FLOOR, 0.3],
  ["tix3", "tix.zip", 38, -2, FLOOR, 0.3],
  ["robux1", "robux.zip", 24, -4, FLOOR, 0.3],
  ["robux2", "robux.zip", 42, -10, FLOOR, 0.3],
  ["plate1", "plate.zip", 18, 6, 63.5, 0.15],
  ["plate2", "plate.zip", 20, 6, 63.5, 0.15],
  ["buy-cola", "cola.zip", 66, -6, FLOOR, 0.7],
  ["buy-egg", "egg.zip", 66, -4, FLOOR, 0.4],
  ["buy-juice", "juice.zip", 66, -2, FLOOR, 0.7],
  ["buy-milk", "milk.zip", 66, 0, FLOOR, 0.7],
];

function open(): void {
  dispatch("time", { seconds: 900, speed: 0 });
  for (const item of [
    ["chips", "Chips"],
    ["orange", "Orange"],
    ["colgate", "Colgate"],
    ["cola", "Bloxy Cola"],
    ["egg", "Egg"],
    ["juice", "Orange Juice"],
    ["milk", "Milk"],
  ]) {
    dispatch("item-define", {
      id: item[0],
      name: item[1],
      sprite: "",
      stackable: true,
    });
  }
  for (const [id, minX, minZ, maxX, maxZ] of ROOMS) {
    dispatch("zone", {
      id,
      name: id,
      min: [minX, FLOOR, minZ],
      max: [maxX, FLOOR + 12, maxZ],
    });
  }
  for (const [id, model, x, z, height] of FURNITURE) {
    // Every fixture stands on the floor: grounded by `heightAt` it would land
    // on the roof once the house is built, which is what a restart showed.
    dispatch("prop", {
      id,
      model,
      x,
      z,
      y: FLOOR,
      name: id,
      height,
      solid: true,
    });
  }
  for (const [id, model, x, z, y, height] of PICKUPS) {
    dispatch("prop", { id, model, x, z, y, name: id, height, solid: false });
  }
  dispatch("npc", {
    id: DAD,
    x: -20,
    z: 16,
    y: FLOOR,
    name: "Father Figure",
    model: "npc-sable.zip",
  });
  dispatch("npc", {
    id: CASHIER,
    x: 60,
    z: 0,
    y: FLOOR,
    name: "Cashier",
    model: "npc-rook.zip",
  });
}

function hintFor(zone: string): void {
  if (zone === BEDROOM) {
    narrate(
      "You",
      "It is 4 AM and I am starving. Find a snack... and try not to wake Dad.",
    );
  } else if (zone === BATHROOM) {
    narrate("You", "Dad is asleep in the bathtub. Keep it down.");
  } else if (zone === KITCHEN) {
    narrate(
      "You",
      "The kitchen. There are chips on the counter and an orange on the table.",
    );
  } else if (zone === LIVING) {
    narrate("You", "The front door is open. The store is down the path.");
  } else if (zone === STORE) {
    narrate(
      "Cashier",
      "Welcome to a generic convenience store. We are open 24 hours.",
    );
  }
}

function buy(item: string, price: number, propId: string, label: string): void {
  if (cash >= price) {
    cash -= price;
    dispatch("item-give", { player: "", item, count: 1 });
    dispatch("item-hold", { player: "", item });
    dispatch("prop-remove", { id: propId });
    say("You buy the " + label + ". (-$" + price + ", $" + cash + " left)");
  } else {
    ending("Shoplifting", "You should buy the item first.");
  }
}

function placeOnPlate(slot: number, held: string): void {
  if (held === "") {
    narrate("You", "There is nothing in my hands to put on the plate.");
    return;
  }
  dispatch("item-take", { player: "", item: held, count: 1 });
  dispatch("item-hold", { player: "", item: "" });
  if (slot === 0) {
    plateA = held;
  } else {
    plateB = held;
  }
  if (plateA === null || plateB === null) {
    say("You set the " + held + " on the plate.");
    return;
  }
  const pair = [plateA, plateB].sort().join("+");
  if (pair === "egg+juice") {
    ending(
      "Breakfast",
      "Perfect Breakfast. Egg and orange juice, the balanced meal.",
    );
  } else if (pair === "chips+cola") {
    ending("Breakfast", "Epic Breakfast. Chips and a soda.");
  } else {
    ending("Breakfast", "Breakfast? ...It is food, at least.");
  }
}

function used(entityId: string, held: string): void {
  if (entityId === "bed") {
    if (chipsLoud) {
      ending(
        "Chips",
        'Dad got mad. "You woke me up. I could hear you eating those chips!"',
      );
    } else if (chipsEaten) {
      ending("Sleep", "you succesfully went to sleep :)");
    } else {
      narrate("You", "I am not tired yet. I need a snack first.");
    }
    return;
  }
  if (entityId === "fridge") {
    if (fridgeUsed) {
      say("The fridge is empty now.");
    } else {
      fridgeUsed = true;
      give("cola", "You take a bloxy cola from the fridge.");
    }
    return;
  }
  if (entityId === "chips") {
    dispatch("prop-remove", { id: "chips" });
    give("chips", "You pick up the bag of chips.");
    return;
  }
  if (entityId === "orange") {
    narrate("You", "This isn't an ordinary orange...");
    ending("Orange", "uh oh.");
    return;
  }
  if (entityId === "colgate") {
    dispatch("prop-remove", { id: "colgate" });
    give("colgate", "You take the colgate.");
    return;
  }
  if (entityId === "cola") {
    dispatch("prop-remove", { id: "cola" });
    give("cola", "You take the bloxy cola.");
    return;
  }
  if (entityId === "tix1" || entityId === "tix2" || entityId === "tix3") {
    dispatch("prop-remove", { id: entityId });
    cash += 1;
    say("You pocket a Tix. ($" + cash + ")");
    return;
  }
  if (entityId === "robux1" || entityId === "robux2") {
    dispatch("prop-remove", { id: entityId });
    cash += 5;
    say("You pocket some Robux. ($" + cash + ")");
    return;
  }
  if (entityId === "buy-cola") {
    buy("cola", 5, entityId, "bloxy cola");
  } else if (entityId === "buy-egg") {
    buy("egg", 25, entityId, "egg");
  } else if (entityId === "buy-juice") {
    buy("juice", 30, entityId, "orange juice");
  } else if (entityId === "buy-milk") {
    buy("milk", 30, entityId, "milk");
  } else if (entityId === "plate1") {
    placeOnPlate(0, held);
  } else if (entityId === "plate2") {
    placeOnPlate(1, held);
  } else if (entityId === "vending") {
    if (held === "cola") {
      dispatch("item-take", { player: "", item: "cola", count: 1 });
      dispatch("item-hold", { player: "", item: "" });
      sodas += 1;
      say("The machine gurgles happily. (" + sodas + "/8)");
    } else {
      say('The broken machine has a sign taped to it: "feed me sodas".');
    }
  } else if (entityId === "manhole") {
    narrate("You", "Someone is down there. Not tonight.");
  } else if (entityId === "trash") {
    narrate("You", "A magic trash can. Nothing in here.");
  }
}

function usedItem(item: string): void {
  if (item === "chips") {
    dispatch("item-take", { player: "", item, count: 1 });
    dispatch("item-hold", { player: "", item: "" });
    chipsEaten = true;
    const where = room();
    if (where === BATHROOM) {
      ending(
        "Chips",
        'Dad woke up. "Did you really try to eat loudly in the room I\'m sleeping in?"',
      );
      return;
    }
    if (where === BEDROOM || where === "outside") {
      chipsLoud = false;
      narrate("You", "Not bad. I should get back to sleep.");
    } else {
      chipsLoud = true;
      narrate("You", "...those chips were really loud.");
    }
    return;
  }
  if (item === "colgate") {
    ending("Toothpaste", "You consumed the colgate. Do not do that.");
    return;
  }
  if (item === "cola") {
    narrate("You", "Cold, sweet, and full of regret.");
  }
}

function talked(npcId: string, player: string): void {
  if (npcId === DAD) {
    ending("Wake up Dad", '"no."');
    return;
  }
  dispatch("dialog", {
    player,
    npcId: CASHIER,
    prompt: "welcome to 'a generic convenience store'. we are open 24 hours.",
    options: ["Where is the food?", "Just looking."],
  });
}

function chose(npcId: string, option: number, player: string): void {
  if (npcId !== CASHIER) {
    return;
  }
  if (option === 0) {
    dispatch("dialog", {
      player,
      npcId: CASHIER,
      prompt: "Shelves are on the right. Leave the money on the counter.",
      options: ["Thanks.", "I might not pay."],
    });
  } else {
    dispatch("dialog-close", { player, npcId: CASHIER });
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
      talked(event.npcId, event.producer);
    } else if (
      event.kind === "npc-choose" &&
      event.npcId !== undefined &&
      event.option !== undefined
    ) {
      chose(event.npcId, event.option, event.producer);
    }
  }
}
