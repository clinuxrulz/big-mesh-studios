// The mesh half of the world worker's protocol: building a block's surface
// triangle mesh (terrain and water) off the main thread. The main thread sends
// the block's voxel data (including its 1-voxel meshing border, so seam faces
// can be culled against the surrounding world without any neighbour data) and
// gets back both meshes as transferable typed arrays, plus the input buffers
// echoed for the caller to recycle. Pure: the worker entry that runs this
// lives in `world-worker.ts`.
import type { MeshArrays, MeshBuildRequest, MeshBuildResult } from "./mesh";
import { buildBlockMesh, buildWaterMesh, MeshBuilder } from "./mesh";
import { VoxelStore } from "../world/voxel-store";
import { LightStore } from "../world/light-store";

/**
 * The arrays every block this worker builds is accumulated into, one pair for
 * as long as the worker lives. They grow to the largest block the worker meets
 * and then stop growing, and what leaves is copied out of them at its exact
 * length, so nothing here is held by a result.
 */
const scratch = { terrain: new MeshBuilder(), water: new MeshBuilder() };

/**
 * The buffers to move along with a pair of typed meshes: each pair's twelve
 * typed-array buffers, terrain first then water — each buffer once, because a
 * transfer list that names a buffer twice is refused by the structured clone
 * algorithm. Two meshes that share an (e.g. empty) array reuse one entry, and
 * the receiver's typed arrays still point at the same transferred buffer.
 */
export const meshArraysTransfers = (
  terrain: MeshArrays,
  water: MeshArrays,
): Transferable[] => {
  const seen = new Set<Transferable>();
  const transfer: Transferable[] = [];
  for (const mesh of [terrain, water]) {
    const { positions, normals, uvs, tiles, brightness, indices } = mesh as {
      positions: Float32Array;
      normals: Float32Array;
      uvs: Float32Array;
      tiles: Float32Array;
      brightness: Float32Array;
      indices: Uint32Array;
    };
    for (const buffer of [
      positions.buffer,
      normals.buffer,
      uvs.buffer,
      tiles.buffer,
      brightness.buffer,
      indices.buffer,
    ]) {
      if (!seen.has(buffer)) {
        seen.add(buffer);
        transfer.push(buffer);
      }
    }
  }
  return transfer;
};

/**
 * Builds a block's terrain and water meshes from a request. The request's
 * buffers are adopted zero-copy, not copied again: `data` already includes the
 * block's meshing border, and the light channels were transferred alongside.
 */
export const handleMeshMessage = (
  request: MeshBuildRequest,
): MeshBuildResult => {
  const { id, voxels, scale, data, hasWater, skyLight, blockLight, tileRects } =
    request;
  const store = new VoxelStore({
    dims: [voxels[0] * scale, voxels[1] * scale, voxels[2] * scale],
    voxels,
    scale,
    data,
  });
  store.hasWater = hasWater;
  const light = new LightStore(voxels, {
    skylight: skyLight,
    blocklight: blockLight,
  });
  return {
    type: "mesh",
    id,
    terrain: buildBlockMesh(store, tileRects, light, scratch.terrain),
    water: buildWaterMesh(store, light, scratch.water),
    data,
    skyLight,
    blockLight,
  };
};

/**
 * The buffers to move along with a result: the two meshes' ten typed arrays
 * plus the three input buffers echoed back so the caller can recycle them
 * instead of letting them be garbage-collected.
 */
export const meshResultTransfers = (
  result: MeshBuildResult,
): Transferable[] => [
  ...meshArraysTransfers(result.terrain, result.water),
  result.data.buffer,
  result.skyLight.buffer,
  result.blockLight.buffer,
];
