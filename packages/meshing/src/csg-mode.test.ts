import { describe, it, expect } from "vitest";
import { makeOperation } from "@big-mesh-studios/csg";
import { DEFAULT_BUDGET, meshModel } from "./model-mesh";

describe("csg mesh mode", () => {
  it("meshes a box", () => {
    const op = makeOperation(0, { x: 0, y: 0, z: 0 }, { type: "Box", len: { x: 1, y: 1, z: 1 } }, "Add");
    const result = meshModel([op], DEFAULT_BUDGET, "csg");
    console.log("csg result tris", result?.triangles);
    expect(result).toBeDefined();
    expect((result?.triangles ?? 0)).toBeGreaterThan(0);
  });

  it("meshes subtraction", () => {
    const a = makeOperation(0, { x: 0, y: 0, z: 0 }, { type: "Box", len: { x: 2, y: 2, z: 2 } }, "Add");
    const b = makeOperation(1, { x: 0.5, y: 0.5, z: 0.5 }, { type: "Box", len: { x: 1, y: 1, z: 1 } }, "Subtract");
    const result = meshModel([a, b], DEFAULT_BUDGET, "csg");
    console.log("csg sub tris", result?.triangles);
    expect(result).toBeDefined();
    expect((result?.triangles ?? 0)).toBeGreaterThan(0);
  });
});
