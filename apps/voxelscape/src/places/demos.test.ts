// @vitest-environment node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BUILTIN_DEMOS, builtinDemo, loadBuiltinDemo } from "./demos";
import { compilePlacePlan, planRegionAround } from "./plan";
import { ScriptHost } from "./script-host";

/** The bytes of a model under `public/models/`, as the demo loader fetches them. */
const modelBytes = (file: string): ArrayBuffer => {
  const url = new URL(`../../public/models/${file}`, import.meta.url);
  const bytes = readFileSync(fileURLToPath(url));
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
};

/** Answers the loader's `./models/...` fetches from disk. */
const stubModels = (): void => {
  vi.stubGlobal("fetch", async (input: unknown) => {
    const file = String(input).replace("./models/", "");
    return new Response(modelBytes(file));
  });
};

afterEach(() => {
  vi.restoreAllMocks();
});

/** Loads the GASA4 demo and returns its script entry, ready to run. */
const gasa4 = async () => {
  stubModels();
  const project = await loadBuiltinDemo(builtinDemo("gasa4")!);
  return { project, entry: project.manifest.scripts![0] };
};

/** The shared clock the demo's timers run against. */
let clockMs = 0;

const run = async (): Promise<{
  host: ScriptHost;
  endings: string[];
  narrations: string[];
  toasts: string[];
}> => {
  clockMs = 0;
  const { project, entry } = await gasa4();
  const endings: string[] = [];
  const narrations: string[] = [];
  const toasts: string[] = [];
  const host = new ScriptHost({
    seed: project.manifest.seed,
    now: () => clockMs,
    heightAt: () => 62,
    onTime: () => {},
    onToast: (_player, text) => toasts.push(text),
    onEnding: (_player, state) => {
      if (state !== null) {
        endings.push(state.title);
      }
    },
    onNarrate: (_player, line) => narrations.push(line.text),
  });
  await host.loadProject(project.scripts, entry);
  return { host, endings, narrations, toasts };
};

/** Moves the shared clock forward and lets the script's timers fire. */
const advance = async (host: ScriptHost, ms: number): Promise<void> => {
  clockMs += ms;
  await host.pump();
};

/** Uses a prop the way the world does: with whatever the player is holding. */
const useHeld = (host: ScriptHost, id: string): Promise<void> =>
  host.use(id, "", host.inventory.heldItem()?.id ?? "");

describe("the built-in demos", () => {
  it("lists the GASA4 place with its furniture and items", () => {
    const demo = builtinDemo("gasa4");
    expect(demo?.name).toBe("Get a Snack at 4 AM");
    expect(demo?.manifest.models).toContain("fridge.zip");
    expect(demo?.manifest.models).toContain("bed.zip");
    expect(demo?.manifest.models).toContain("chips.zip");
    expect(demo?.manifest.models).toContain("fire.zip");
    expect(demo?.manifest.models).toContain("friedegg.zip");
    expect(BUILTIN_DEMOS).toContain(demo);
  });

  it("loads the GASA4 demo's models as bytes", async () => {
    const { project } = await gasa4();
    expect(Object.keys(project.models)).toContain("fridge.zip");
    expect(Object.keys(project.models)).toContain("plate.zip");
    expect(Object.keys(project.models)).toContain("fire.zip");
    expect(Object.keys(project.models)).toContain("friedegg.zip");
    expect(project.models["fridge.zip"].length).toBeGreaterThan(0);
  });

  it("compiles its house and store", async () => {
    const { project, entry } = await gasa4();
    const plan = await compilePlacePlan({
      files: project.scripts,
      entry,
      seed: project.manifest.seed,
      region: planRegionAround(project.manifest.spawn),
    });
    expect(plan.some((shape) => shape.kind === "road")).toBe(true);
    expect(plan.length).toBeGreaterThan(15);
  });

  it("opens with Dad, the Cashier, and the store counter", async () => {
    const { host } = await run();
    expect(host.npcList.map((npc) => npc.id).sort()).toEqual([
      "cashier",
      "dad",
    ]);
    expect(host.propList.some((prop) => prop.model === "bed.zip")).toBe(true);
    expect(host.prop("store-counter")).toMatchObject({ model: "counter.zip" });
    host.dispose();
  });

  it("ends with Sleep when the chips are eaten in the bedroom", async () => {
    const { host, endings } = await run();
    await host.movePlayer("", -14, 62, -12); // the bedroom
    await host.use("chips", ""); // pick them up
    await host.useItem("chips", ""); // eat them quietly there
    await host.use("bed", ""); // go back to sleep
    expect(endings).toEqual(["Sleep"]);
    host.dispose();
  });

  it("ends with Chips when they are eaten where Dad can hear", async () => {
    const { host, endings } = await run();
    await host.movePlayer("", 10, 62, 10); // the kitchen
    await host.use("chips", "");
    await host.useItem("chips", "");
    // Dad wakes at once and comes into the room.
    expect(host.npc("dad")).toMatchObject({ x: 8, z: 14 });
    await host.use("bed", "");
    expect(endings).toEqual(["Chips"]);
    host.dispose();
  });

  it("ends with Orange when the orange is picked up", async () => {
    const { host, endings } = await run();
    await host.use("orange", "");
    expect(endings).toEqual(["Orange"]);
    host.dispose();
  });

  it("lets the player sit a store good on the counter and buy it", async () => {
    const { host } = await run();
    await host.use("robux-3", ""); // $5
    await host.use("buy-cola", ""); // pick the cola up
    await useHeld(host, "store-counter"); // set it on the counter
    expect(host.prop("counter-item")).toMatchObject({ model: "cola.zip" });
    await host.talk("cashier", "");
    expect(host.dialogFor("")?.prompt).toContain("Bloxy Cola");
    await host.choose("cashier", 0, "");
    expect(host.inventory.heldItem()).toMatchObject({ id: "cola" });
    expect(host.prop("counter-item")).toBeNull();
    host.dispose();
  });

  it("refuses a purchase the player cannot afford", async () => {
    const { host, endings, toasts } = await run();
    await host.use("buy-egg", ""); // no cash yet
    await useHeld(host, "store-counter");
    await host.talk("cashier", "");
    await host.choose("cashier", 0, "");
    expect(toasts).toContain("You do not have enough cash for the Egg.");
    expect(endings).toEqual([]);
    expect(host.inventory.heldItem()).toBeNull();
    host.dispose();
  });

  it("only steals once the player leaves the store with an unpaid good", async () => {
    const { host, endings } = await run();
    await host.movePlayer("", 60, 62, 0); // into the store
    await host.use("buy-cola", "");
    expect(endings).toEqual([]);
    await host.movePlayer("", 30, 62, 0); // out the door
    expect(endings).toEqual(["Shoplifting"]);
    host.dispose();
  });

  it("sits an item on a plate and takes it back off", async () => {
    const { host } = await run();
    await host.use("cola", "");
    await useHeld(host, "plate1");
    expect(host.prop("plate-item-0")).toMatchObject({ model: "cola.zip" });
    expect(host.inventory.count("cola")).toBe(0);
    await useHeld(host, "plate1"); // empty hands take it back
    expect(host.prop("plate-item-0")).toBeNull();
    expect(host.inventory.heldItem()).toMatchObject({ id: "cola" });
    host.dispose();
  });

  it("cooks an egg and plates it with juice for a Perfect Breakfast", async () => {
    const { host, endings } = await run();
    await host.use("buy-egg", "");
    await useHeld(host, "stove");
    expect(host.prop("stove-item")).toMatchObject({ model: "egg.zip" });
    await advance(host, 6_000);
    expect(host.prop("stove-item")).toMatchObject({ model: "friedegg.zip" });
    await useHeld(host, "stove"); // off
    await useHeld(host, "stove"); // take the fried egg
    expect(host.inventory.heldItem()).toMatchObject({ id: "friedegg" });
    await useHeld(host, "plate1");
    await host.use("buy-juice", "");
    await useHeld(host, "plate2");
    expect(endings).toEqual(["Breakfast"]);
    host.dispose();
  });

  it("burns the house down when a non-egg is left on the stove", async () => {
    const { host, endings } = await run();
    await host.movePlayer("", 10, 62, 10); // the kitchen
    await host.use("cola", "");
    await useHeld(host, "stove");
    await advance(host, 5_000);
    expect(host.prop("fire-0")).toMatchObject({ model: "fire.zip" });
    await advance(host, 8_000);
    expect(endings).toContain("Fire");
    host.dispose();
  });

  it("frees the goods once the cashier goes on break", async () => {
    const { host, endings } = await run();
    await advance(host, 120_000);
    expect(host.npc("cashier")).toMatchObject({ x: 50, z: -14 });
    await host.movePlayer("", 60, 62, 0);
    await host.use("buy-cola", "");
    await host.movePlayer("", 30, 62, 0);
    expect(endings).toEqual([]);
    await host.talk("cashier", "");
    expect(host.dialogFor("")?.prompt).toContain("break");
    host.dispose();
  });

  it("scatters enough cash to afford the egg and a breakfast", async () => {
    const { host, toasts } = await run();
    for (let i = 1; i <= 14; i++) {
      await host.use(`tix-${i}`, "");
    }
    for (let i = 1; i <= 10; i++) {
      await host.use(`robux-${i}`, "");
    }
    expect(toasts.at(-1)).toBe("You pocket some Robux. ($64)");
    host.dispose();
  });
});
