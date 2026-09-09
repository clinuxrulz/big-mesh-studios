// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  buildFillMeshResults,
  fillMeshResultTransfers,
  handleFillMeshMessage,
  type FillMeshBatchRequest,
  type FillMeshBlockResult,
} from "./fill-mesh-worker";
import type { FillConfig } from "./fill-worker";
import { buildBlockData } from "./level-data";

const collect = async (
  results: AsyncGenerator<FillMeshBlockResult> | undefined,
): Promise<FillMeshBlockResult[]> => {
  const collected: FillMeshBlockResult[] = [];
  for await (const result of results ?? []) {
    collected.push(result);
  }
  return collected;
};

const config: FillConfig = {
  terrain: {
    seed: 1,
    frequency: 1,
    amplitude: 0,
    octaves: 1,
    base: 64,
  },
};

describe("combined fill-and-mesh worker protocol", () => {
  it("ignores a fillMesh request before a config arrives", () => {
    const out = handleFillMeshMessage(
      {
        type: "fillMesh",
        indices: [0],
        centers: [[0, 0, 0]],
        lods: [0],
        gens: [1],
        tileRects: [],
      },
      undefined,
    );
    expect(out.results).toBeUndefined();
  });

  it("ignores a message that is not a fillMesh request", () => {
    expect(handleFillMeshMessage({ type: "fill" } as never, config)).toEqual(
      {},
    );
  });

  it("yields one combined result per block, in the order requested", async () => {
    const req: FillMeshBatchRequest = {
      type: "fillMesh",
      indices: [3, 7],
      centers: [
        [0, 0, 0],
        [192, 0, 0],
      ],
      lods: [0, 0],
      gens: [11, 22],
      tileRects: [],
    };
    const results = await collect(handleFillMeshMessage(req, config).results);
    expect(results.map((result) => [result.index, result.gen])).toEqual([
      [3, 11],
      [7, 22],
    ]);
    const sync = buildBlockData({ center: [0, 0, 0], terrain: config.terrain });
    expect(results[0].storeData.length).toBe(sync.storeData.length);
  });

  it("meshes the block's generated surface in the same result", async () => {
    const [result] = await collect(
      buildFillMeshResults(
        {
          type: "fillMesh",
          // A block sitting on the flat surface (world y 64, base 64): its
          // volume straddles air and dirt, so the surface has faces to draw —
          // the mesh is built from the very data the result carries.
          indices: [0],
          centers: [[0, 64, 0]],
          lods: [0],
          gens: [1],
          tileRects: [],
        },
        config,
      ),
    );
    expect(result.terrain.indices.length).toBeGreaterThan(0);
    expect(result.water.indices.length).toBe(0);
  });

  it("returns empty meshes for a surface-less block instead of sweeping", async () => {
    const [result] = await collect(
      buildFillMeshResults(
        {
          type: "fillMesh",
          indices: [0],
          centers: [[0, 1_000_000, 0]],
          lods: [0],
          gens: [1],
          tileRects: [],
        },
        config,
      ),
    );
    expect(result.mightHaveVoxels).toBe(false);
    expect(result.hasWater).toBe(false);
    expect(result.terrain.indices.length).toBe(0);
    expect(result.water.indices.length).toBe(0);
  });

  it("lists each buffer once in the transfer list", async () => {
    const [result] = await collect(
      buildFillMeshResults(
        {
          type: "fillMesh",
          indices: [0],
          centers: [[0, 64, 0]],
          lods: [0],
          gens: [1],
          tileRects: [],
        },
        config,
      ),
    );
    const transfers = fillMeshResultTransfers(result);
    // A transfer list naming a buffer twice is refused by the structured clone
    // algorithm, so no buffer may repeat however the meshes share arrays.
    expect(new Set(transfers).size).toBe(transfers.length);
    for (const transfer of transfers) {
      expect(transfer).toBeInstanceOf(ArrayBuffer);
    }
  });
});
