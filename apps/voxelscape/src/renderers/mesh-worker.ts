// The mesh half of the world worker's protocol: building a block's surface
// triangle mesh (terrain and water) off the main thread. The main thread sends
// the block's voxel data (including its 1-voxel meshing border, so seam faces
// can be culled against the surrounding world without any neighbour data) and
// gets back both meshes as transferable typed arrays, plus the input buffers
// echoed for the caller to recycle. Pure: the worker entry that runs this
// lives in `world-worker.ts`.
import type { MeshArrays, MeshBuildRequest, MeshBuildResult } from "./mesh";
import { buildBlockMesh, buildWaterMesh } from "./mesh";
import { VoxelStore } from "../world/voxel-store";
import { LightStore } from "../world/light-store";

const toTyped = (m: MeshArrays): MeshArrays => ({
  positions:
    m.positions instanceof Float32Array
      ? m.positions
      : new Float32Array(m.positions),
  normals:
    m.normals instanceof Float32Array ? m.normals : new Float32Array(m.normals),
  uvs: m.uvs instanceof Float32Array ? m.uvs : new Float32Array(m.uvs),
  brightness:
    m.brightness instanceof Float32Array
      ? m.brightness
      : new Float32Array(m.brightness),
  indices:
    m.indices instanceof Uint32Array ? m.indices : new Uint32Array(m.indices),
});

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
  });
  store.data = data;
  store.hasWater = hasWater;
  const light = new LightStore(voxels);
  light.skylight = skyLight;
  light.blocklight = blockLight;
  return {
    type: "mesh",
    id,
    terrain: toTyped(buildBlockMesh(store, tileRects, light)),
    water: toTyped(buildWaterMesh(store, light)),
    data,
    skyLight,
    blockLight,
  };
};

/**
 * The buffers to move along with a result: both meshes' ten typed arrays plus
 * the three input buffers echoed back so the caller can recycle them instead
 * of letting them be garbage-collected.
 */
export const meshResultTransfers = (
  result: MeshBuildResult,
): Transferable[] => {
  const transfer: Transferable[] = [];
  for (const mesh of [result.terrain, result.water]) {
    const { positions, normals, uvs, brightness, indices } = mesh as {
      positions: Float32Array;
      normals: Float32Array;
      uvs: Float32Array;
      brightness: Float32Array;
      indices: Uint32Array;
    };
    transfer.push(
      positions.buffer,
      normals.buffer,
      uvs.buffer,
      brightness.buffer,
      indices.buffer,
    );
  }
  transfer.push(
    result.data.buffer,
    result.skyLight.buffer,
    result.blockLight.buffer,
  );
  return transfer;
};
