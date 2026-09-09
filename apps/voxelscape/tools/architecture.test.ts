// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  areaOfImport,
  edgesOf,
  importsOf,
  mutualPairs,
  readModules,
  unruledEdges,
} from "./architecture";

describe("importsOf", () => {
  it("finds every shape an import comes in", () => {
    const found = importsOf(
      [
        `import { one } from "./one";`,
        `import type { Two } from "../world/two";`,
        `import Three from "three";`,
        `export { four } from "./four";`,
        `const Five = lazy(() => import("./ui/Five"));`,
        `import "./six.css";`,
      ].join("\n"),
      "src/App.tsx",
    );
    // In the order they are written, the lazy one included.
    expect(found).toEqual([
      "./one",
      "../world/two",
      "three",
      "./four",
      "./ui/Five",
      "./six.css",
    ]);
  });

  it("reads a name that only looks like an import as what it is", () => {
    // A string holding the word is not an import, and a comment naming a module
    // is not one either. Nothing here is found by searching the text.
    const found = importsOf(
      [
        `// import { nothing } from "./nothing";`,
        `const line = 'import { nothing } from "./also-nothing"';`,
        `import { real } from "./real";`,
      ].join("\n"),
      "src/thing.ts",
    );
    expect(found).toEqual(["./real"]);
  });
});

describe("areaOfImport", () => {
  it("names the area a relative import points into", () => {
    expect(areaOfImport("player/tools/tool.ts", "../../world/level-data")).toBe(
      "world",
    );
    expect(
      areaOfImport("ui/Console.tsx", "../voxelscape/create-voxelscape"),
    ).toBe("voxelscape");
  });

  it("calls a module beside the areas the shell", () => {
    // `src/commands.ts` and its neighbours are the shell that wires the rest
    // together, and a specifier carries no extension to tell them apart by.
    expect(areaOfImport("ui/Console.tsx", "../commands")).toBe("shell");
    expect(areaOfImport("App.tsx", "./utils")).toBe("shell");
  });

  it("answers nothing for a package or a path outside the sources", () => {
    expect(areaOfImport("world/level-data.ts", "@random-mesh/rmsl/scene")).toBe(
      null,
    );
    expect(
      areaOfImport("world/level-data.ts", "../../e2e/bench/report.ts"),
    ).toBe(null);
  });
});

describe("edgesOf", () => {
  it("counts the modules that make each edge, once each", () => {
    const edges = edgesOf([
      {
        path: "player/one.ts",
        area: "player",
        lines: 1,
        reaches: new Set(["world", "renderers"]),
      },
      {
        path: "player/two.ts",
        area: "player",
        lines: 1,
        reaches: new Set(["world"]),
      },
      { path: "world/three.ts", area: "world", lines: 1, reaches: new Set() },
    ]);
    expect(edges).toEqual([
      { from: "player", to: "renderers", modules: 1 },
      { from: "player", to: "world", modules: 2 },
    ]);
  });
});

describe("mutualPairs", () => {
  it("names two areas that import from each other, once", () => {
    expect(
      mutualPairs([
        { from: "renderers", to: "world", modules: 5 },
        { from: "world", to: "renderers", modules: 5 },
        { from: "player", to: "world", modules: 2 },
      ]),
    ).toEqual([["renderers", "world"]]);
  });
});

describe("the world as it stands", () => {
  it("imports nothing between areas that no rule allows", () => {
    // The rules were seeded from what the world already did, so this passes the
    // day it is written. It earns its keep on the day somebody adds an edge
    // between two areas without saying so.
    const unruled = unruledEdges(edgesOf(readModules()));
    expect(unruled.map((edge) => `${edge.from} → ${edge.to}`)).toEqual([]);
  });

  it("puts every module in an area the drawing knows", () => {
    const modules = readModules();
    expect(modules.length).toBeGreaterThan(50);
    for (const module of modules) {
      expect(module.area).not.toBe("");
      expect(module.lines).toBeGreaterThan(0);
    }
  });
});
