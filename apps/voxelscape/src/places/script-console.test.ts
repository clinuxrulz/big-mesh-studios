// @vitest-environment node
import { describe, expect, it } from "vitest";
import { ScriptConsole } from "./script-console";
import { SAMPLE_PLACE_SCRIPT } from "./sample";
import { MAIN_SCRIPT_FILE } from "./project";

const scriptConsole = (): {
  script: ScriptConsole;
  lines: string[];
} => {
  const lines: string[] = [];
  return {
    lines,
    script: new ScriptConsole({
      heightAt: () => 0,
      report: (line) => lines.push(line),
    }),
  };
};

const loadProject = (script: ScriptConsole, source: string, seed: number) =>
  script.loadProject({ [MAIN_SCRIPT_FILE]: source }, MAIN_SCRIPT_FILE, seed);

describe("a script console", () => {
  it("reports before a script is loaded", async () => {
    const { script } = scriptConsole();
    await expect(script.describe()).resolves.toBe(
      "no script loaded — use /script:demo",
    );
    script.dispose();
  });

  it("loads the sample and runs a whole conversation", async () => {
    const { script, lines } = scriptConsole();
    const loaded = await script.loadSample();
    expect(loaded).toMatch(/sample script loaded — .*Sable.*Rook/);
    expect(loaded).toMatch(/talk with \/script:talk <id> \(sable or rook\)/i);

    const talk = await script.talk("sable");
    expect(talk).toContain("Welcome, traveller.");
    expect(talk).toContain("1. Buy a potion.");
    expect(talk).toContain("2. Goodbye.");

    const declined = await script.choose(2);
    expect(declined).toBe("the conversation is over");
    expect(lines).toContain("Come back when your pockets are full.");

    await expect(script.choose(1)).resolves.toBe(
      "nobody is talking — /script:talk <id> first",
    );
    script.dispose();
  });

  it("keeps the shop sale reachable through option numbers", async () => {
    const { script, lines } = scriptConsole();
    await script.loadSample();
    await script.talk("sable");
    await script.choose(1); // buy a potion
    await script.choose(1); // I'll take a potion
    expect(lines).toContain(
      "Sold! A potion of courage, fresh from the cellar.",
    );
    script.dispose();
  });

  it("loads an arbitrary script and reports where its NPCs stand", async () => {
    const { script } = scriptConsole();
    const line = await loadProject(script, SAMPLE_PLACE_SCRIPT, 99);
    expect(line).toMatch(/script loaded — .*Sable.*Rook/);
    expect(line).toMatch(/sable or rook/);
    script.dispose();
  });

  it("replaces the previous script's NPCs when a new source loads", async () => {
    const { script } = scriptConsole();
    await loadProject(script, SAMPLE_PLACE_SCRIPT, 99);
    expect(script.npcs()).toHaveLength(2);
    await loadProject(
      script,
      `export function bmsTick() {
        engine.dispatch("npc", JSON.stringify({ id: "ghost", x: 1, z: 2 }));
      }`,
      99,
    );
    expect(script.npcs().map((npc) => npc.id)).toEqual(["ghost"]);
    script.dispose();
  });

  it("reports when a loaded script places no NPCs", async () => {
    const { script } = scriptConsole();
    const line = await loadProject(script, "export function bmsTick() {}", 1);
    expect(line).toContain("no NPCs placed yet");
    script.dispose();
  });
});
