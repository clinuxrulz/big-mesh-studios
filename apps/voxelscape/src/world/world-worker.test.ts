// @vitest-environment node
import { describe, expect, it } from "vitest";
import { handleWorldMessage } from "./world-worker";
import type { FillConfig } from "./fill-worker";
import type { MeshBuildRequest } from "../renderers/mesh";

const config: FillConfig = {
  terrain: {
    seed: 1,
    frequency: 1,
    amplitude: 0,
    octaves: 1,
    base: 64,
  },
};

describe("world worker protocol", () => {
  it("stores the config from a config message, for later fills", () => {
    const out = handleWorldMessage({ type: "config", config }, undefined);
    expect(out.config).toBe(config);
    // A fill that follows the config is answered, not dropped for lack of one.
    const fill = handleWorldMessage(
      {
        type: "fill",
        indices: [0],
        centers: [[0, 0, 0]],
        lods: [0],
        gens: [1],
      },
      out.config,
    );
    expect(fill.results).toBeDefined();
  });

  it("answers nothing for a message of no known kind", () => {
    expect(handleWorldMessage({ type: "ping" } as never, config)).toEqual({});
  });

  it("answers a mesh request with the block's meshes and its buffers back", () => {
    const request: MeshBuildRequest = {
      type: "mesh",
      id: 7,
      voxels: [2, 2, 2],
      scale: 2,
      data: new Uint8Array(64),
      hasWater: false,
      skyLight: new Uint8Array(64),
      blockLight: new Uint8Array(64),
      tileRects: [],
    };
    const out = handleWorldMessage(request, undefined);
    expect(out.mesh?.result.type).toBe("mesh");
    expect(out.mesh?.result.id).toBe(7);
    // The two surface meshes and the three echoed input buffers travel along.
    expect(out.mesh?.transfers.length).toBeGreaterThanOrEqual(5);
  });
});
