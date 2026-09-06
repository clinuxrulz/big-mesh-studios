// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import { bundlePlaceProject } from "./bundle";

afterEach(() => {
  // The bundle hands its entry's bmsTick to the global; the tests are not the app.
  delete (globalThis as Record<string, unknown>).bmsTick;
});

/** Evaluates the bundle in Node, returning the entry's bmsTick as the sandbox would see it. */
const runBundle = (output: string): (() => void) => {
  new Function(output)();
  const fn = (globalThis as Record<string, unknown>).bmsTick;
  if (typeof fn !== "function") {
    throw new Error("bundle installed no bmsTick global");
  }
  return fn as () => void;
};

const MAIN_TS = `
interface Npc {
  id: string;
  pos: [number, number];
}

const npcs: Array<Npc> = [{ id: "guide", pos: [8, 8] }];

export function bmsTick(clockMs: number, eventsJson: string): void {
  const first = npcs[0];
  engine.dispatch("npc", JSON.stringify({ id: first.id, x: first.pos[0], z: first.pos[1] }));
  engine.log(String(clockMs));
}
`;

describe("the place script bundler", () => {
  it("strips TypeScript and hands the entry's bmsTick to the global", async () => {
    const output = await bundlePlaceProject({ "main.ts": MAIN_TS }, "main.ts");
    expect(output).not.toContain(": number");
    expect(output).not.toContain("interface");
    expect(runBundle(output)).toBeTypeOf("function");
  });

  it("produces identical output for identical input", async () => {
    const first = await bundlePlaceProject({ "main.ts": MAIN_TS }, "main.ts");
    const second = await bundlePlaceProject({ "main.ts": MAIN_TS }, "main.ts");
    expect(second).toBe(first);
  });

  it("bundles multiple project files and resolves imports between them", async () => {
    const files = {
      "main.ts": `
        import { hello } from "./greeting";
        export function bmsTick(clockMs: number, eventsJson: string): void {
          engine.log(hello);
        }
      `,
      "greeting.ts": `
        export const hello: string = "hello from the helper";
      `,
    };
    const output = await bundlePlaceProject(files, "main.ts");
    expect(output).toContain("hello from the helper");
    const tick = runBundle(output);
    expect(tick).toBeTypeOf("function");
  });

  it("resolves a .js-ending specifier to the sibling .ts file it names", async () => {
    const files = {
      "main.ts": `import { n } from "./helper.js"; export function bmsTick() {}`,
      "helper.ts": `export const n: number = 3;`,
    };
    await expect(bundlePlaceProject(files, "main.ts")).resolves.toContain(
      "n = 3",
    );
  });

  it("keeps each module's top-level names to its own scope", async () => {
    const files = {
      "main.ts": `
        import { value as other } from "./other";
        var value = 1;
        export function bmsTick(): void { engine.log(String(other + value)); }
      `,
      "other.ts": `var value = 40; export { value };`,
    };
    expect(runBundle(await bundlePlaceProject(files, "main.ts"))).toBeTypeOf(
      "function",
    );
  });

  it("does not require a type-only import to resolve", async () => {
    const files = {
      "main.ts": `
        import type { Missing } from "./missing";
        const probe: Missing | undefined = undefined;
        export function bmsTick(): void { engine.log("ok"); }
      `,
    };
    await expect(bundlePlaceProject(files, "main.ts")).resolves.toContain("ok");
  });

  it("rejects an import no project file answers", async () => {
    const files = {
      "main.ts": `import { nope } from "./nope"; export function bmsTick() {}`,
    };
    await expect(bundlePlaceProject(files, "main.ts")).rejects.toThrow(
      'imports "./nope" — imports may only come from this place\'s own script files',
    );
  });

  it("rejects a bare or network specifier", async () => {
    const files = {
      "main.ts": `import fs from "fs"; export function bmsTick() {}`,
    };
    await expect(bundlePlaceProject(files, "main.ts")).rejects.toThrow(
      /imports may only come from this place's own script files/,
    );
  });

  it("rejects an entry the project does not carry", async () => {
    await expect(
      bundlePlaceProject({ "main.ts": MAIN_TS }, "ghost.ts"),
    ).rejects.toThrow(
      'the entry script "ghost.ts" is not a file of this project',
    );
  });

  it("reports a TypeScript syntax error at its file, line and column", async () => {
    const files = {
      "main.ts": `const n: = 3;`,
    };
    await expect(bundlePlaceProject(files, "main.ts")).rejects.toThrow(
      /^main\.ts:1:\d+ — TS/,
    );
  });
});
