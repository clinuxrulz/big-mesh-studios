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

const run = async (): Promise<{
  host: ScriptHost;
  endings: string[];
  narrations: string[];
}> => {
  const { project, entry } = await gasa4();
  const endings: string[] = [];
  const narrations: string[] = [];
  const host = new ScriptHost({
    seed: project.manifest.seed,
    now: () => 0,
    heightAt: () => 62,
    onTime: () => {},
    onEnding: (_player, state) => {
      if (state !== null) {
        endings.push(state.title);
      }
    },
    onNarrate: (_player, line) => narrations.push(line.text),
  });
  await host.loadProject(project.scripts, entry);
  return { host, endings, narrations };
};

describe("the built-in demos", () => {
  it("lists the GASA4 place with its furniture and items", () => {
    const demo = builtinDemo("gasa4");
    expect(demo?.name).toBe("Get a Snack at 4 AM");
    expect(demo?.manifest.models).toContain("fridge.zip");
    expect(demo?.manifest.models).toContain("bed.zip");
    expect(demo?.manifest.models).toContain("chips.zip");
    expect(BUILTIN_DEMOS).toContain(demo);
  });

  it("loads the GASA4 demo's models as bytes", async () => {
    const { project } = await gasa4();
    expect(Object.keys(project.models)).toContain("fridge.zip");
    expect(Object.keys(project.models)).toContain("plate.zip");
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

  it("opens with Dad and the Cashier standing", async () => {
    const { host } = await run();
    expect(host.npcList.map((npc) => npc.id).sort()).toEqual([
      "cashier",
      "dad",
    ]);
    expect(host.propList.some((prop) => prop.model === "bed.zip")).toBe(true);
    host.dispose();
  });

  it("ends with Sleep when the chips are eaten in the bedroom", async () => {
    const { host, endings } = await run();
    await host.movePlayer("", -14, 62, -12); // the bedroom
    await host.use("chips", ""); // pick them up
    await host.useItem("chips", ""); // eat them there
    await host.use("bed", ""); // go back to sleep
    expect(endings).toEqual(["Sleep"]);
    host.dispose();
  });

  it("ends with Chips when they are eaten where Dad can hear", async () => {
    const { host, endings } = await run();
    await host.movePlayer("", 10, 62, 10); // the kitchen
    await host.use("chips", "");
    await host.useItem("chips", "");
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

  it("ends with Shoplifting when an item is taken without the cash", async () => {
    const { host, endings } = await run();
    await host.use("buy-cola", "");
    expect(endings).toEqual(["Shoplifting"]);
    host.dispose();
  });

  it("sells an item once the player has picked up enough cash", async () => {
    const { host, endings } = await run();
    await host.use("robux1", ""); // $5
    await host.use("buy-cola", ""); // $5 cola
    expect(endings).toEqual([]);
    expect(host.inventory.heldItem()).toMatchObject({ id: "cola" });
    host.dispose();
  });
});
