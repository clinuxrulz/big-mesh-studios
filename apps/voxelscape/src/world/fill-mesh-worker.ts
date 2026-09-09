// The combined fill-and-mesh job of the world worker: generate a block's
// procedural voxel data and immediately build its surface meshes from that
// data, all in one worker-runnable sequence. A scroll's entering shell streams
// in as these jobs rather than as separate fill and mesh messages, so a block
// can never sit "filled but not meshed": its geometry leaves the worker in the
// same message as its voxels, and nothing queues on the main thread waiting
// for a separate mesh request to be sent. Pure: the worker entry that runs
// this lives in `world-worker.ts`.
import {
  BLOCK_WORLD,
  buildBlockData,
  blockConfig,
  type Dim3,
} from "./level-data";
import type { BorderSizes } from "./voxel-store";
import { VoxelStore } from "./voxel-store";
import { LightStore } from "./light-store";
import {
  buildBlockMesh,
  buildWaterMesh,
  emptyMesh,
  MeshBuilder,
  type MeshArrays,
} from "../renderers/mesh";
import type { VoxelTileConfig } from "../renderers/atlas";
import { meshArraysTransfers } from "../renderers/mesh-worker";
import { customFillStoreOf, type FillConfig } from "./fill-worker";

export interface FillMeshBatchRequest {
  type: "fillMesh";
  indices: number[];
  centers: Dim3[];
  /** One level of detail per block, the resolution its voxels are generated at. */
  lods: number[];
  /**
   * One neighbour-voxel-size map per block, so a block's border culls its seam
   * faces against a neighbour built at a different level of detail.
   */
  borderSizes?: BorderSizes[];
  /**
   * One generation per block, echoing the counter the main thread bumped
   * when it sent this request; carried back on the result so a stale result
   * is dropped rather than painted over newer terrain.
   */
  gens: number[];
  /** The atlas's current tile rectangles, baked into each vertex's texture coordinates. */
  tileRects: VoxelTileConfig[];
}

export interface FillMeshBlockResult {
  /** The kind of result; the fill client ignores every other kind a shared worker posts. */
  type: "fillMesh";
  index: number;
  gen: number;
  lod: number;
  storeData: Uint8Array;
  /** Whether the block is worth meshing; see `VoxelStore.mightHaveVoxels`. */
  mightHaveVoxels: boolean;
  /** Whether the block holds water; see `VoxelStore.hasWater`. */
  hasWater: boolean;
  skyLight: Uint8Array;
  blockLight: Uint8Array;
  /** The terrain surface, built from the generated voxels and light. */
  terrain: MeshArrays;
  /** The water surface, likewise. */
  water: MeshArrays;
}

/**
 * The arrays every block this worker builds is accumulated into, one pair for as
 * long as the worker lives, the same way the mesh-only path keeps its own.
 */
const scratch = { terrain: new MeshBuilder(), water: new MeshBuilder() };

/**
 * Builds one combined result per block in a `fillMesh` request, in request
 * order. Each block is generated, then its meshes are built from the exact
 * arrays its result carries, so the main thread adopts one consistent
 * snapshot. A block whose fill reports no surface voxels and no water skips
 * the volume sweep an empty build would cost.
 */
export async function* buildFillMeshResults(
  req: FillMeshBatchRequest,
  cfg: FillConfig,
): AsyncGenerator<FillMeshBlockResult> {
  const customFillStore = await customFillStoreOf(cfg);
  for (let i = 0; i < req.centers.length; i++) {
    const data = buildBlockData({
      center: req.centers[i],
      lod: req.lods[i],
      terrain: cfg.terrain,
      customFillStore,
      borderSizes: req.borderSizes?.[i],
    });
    let terrain: MeshArrays = emptyMesh();
    let water: MeshArrays = emptyMesh();
    if (data.mightHaveVoxels || data.hasWater) {
      const { voxels, voxelSize } = blockConfig(req.lods[i]);
      const store = new VoxelStore({
        dims: BLOCK_WORLD,
        voxels,
        scale: voxelSize,
        data: data.storeData,
      });
      store.mightHaveVoxels = data.mightHaveVoxels;
      store.hasWater = data.hasWater;
      const light = new LightStore(voxels, {
        skylight: data.skyLight,
        blocklight: data.blockLight,
      });
      terrain = buildBlockMesh(store, req.tileRects, light, scratch.terrain);
      water = buildWaterMesh(store, light, scratch.water);
    }
    yield {
      type: "fillMesh",
      index: req.indices[i],
      gen: req.gens[i],
      lod: req.lods[i],
      storeData: data.storeData,
      mightHaveVoxels: data.mightHaveVoxels,
      hasWater: data.hasWater,
      skyLight: data.skyLight,
      blockLight: data.blockLight,
      terrain,
      water,
    };
  }
}

/**
 * The buffers to move along with a combined result: the result owns every one
 * of them — the three voxel/light arrays plus the two meshes' ten typed
 * arrays.
 */
export const fillMeshResultTransfers = (
  result: FillMeshBlockResult,
): Transferable[] => [
  result.storeData.buffer,
  result.skyLight.buffer,
  result.blockLight.buffer,
  ...meshArraysTransfers(result.terrain, result.water),
];

/**
 * Pure message handler: a result per block for a `fillMesh` message, or
 * nothing for any other message (an unknown kind, or one sent before a
 * configuration arrived).
 */
export const handleFillMeshMessage = (
  msg: FillMeshBatchRequest,
  config: FillConfig | undefined,
): { results?: AsyncGenerator<FillMeshBlockResult> } => {
  if (msg.type !== "fillMesh" || config === undefined) {
    return {};
  }
  return { results: buildFillMeshResults(msg, config) };
};
