// CPU-side per-voxel light, held in step with a `VoxelStore`. One `LightStore`
// per block carries two channels of 0..15 values, `skylight` (sunlight from
// above) and `blocklight` (the spread of emissive voxels), each laid out in
// the same padded buffer as the store's voxels so the mesh builders read a
// corner's light across the meshing border exactly as they read its voxel.
import type { Dim3 } from "./level-data";
import {
  paddedVoxelCount,
  VOXEL_LAVA,
  VOXEL_LAVA_LEVEL_1,
  VOXEL_LAVA_LEVEL_7,
  VOXEL_LAVA_FALLING,
  VOXEL_EMBER,
  VOXEL_PADDING,
  type VoxelStore,
} from "./voxel-store";

/** The highest light level; light falls off by one per propagated voxel. */
export const MAX_LIGHT = 15;

/**
 * Light levels per voxel id for the emissive blocks that seed block light.
 * Lava and fire embers both shine at full strength; a place can lower an
 * ember's light by re-lighting the block around an edited copy, or this table
 * can grow torches and glowstone as their ids land.
 */
export const EMISSIVE_LEVEL: Record<number, number> = (() => {
  const levels: Record<number, number> = {
    [VOXEL_LAVA]: MAX_LIGHT,
    [VOXEL_EMBER]: MAX_LIGHT,
  };
  for (let id = VOXEL_LAVA_LEVEL_1; id <= VOXEL_LAVA_LEVEL_7; id++) {
    levels[id] = MAX_LIGHT;
  }
  levels[VOXEL_LAVA_FALLING] = MAX_LIGHT;
  return levels;
})();

/**
 * The rendered strength of the highest light level, so a light level `l`
 * renders as `l / MAX_LIGHT` at full energy. Kept as a named value so the
 * mesher and the tests normalize light the same way.
 */
export const LIGHT_TO_UNIT = (level: number): number => level * (1 / MAX_LIGHT);

/**
 * A block's two light channels, `skylight` and `blocklight`, sized and padded
 * exactly like the `VoxelStore` they shadow. The same world-coordinate terrain
 * that generates the voxel border seeds the sky border, so a seam face reads
 * its neighbour's light level from its own copy. Values are indices into the
 * 16-step light ramp from 0 (no light) to `MAX_LIGHT`.
 */
export class LightStore {
  /** One 0..15 value per padded voxel, a full byte each for simplicity. */
  skylight: Uint8Array;
  blocklight: Uint8Array;
  readonly padding: number = VOXEL_PADDING;

  /**
   * @param voxels The interior volume this shadows, border excluded.
   * @param channels Light to adopt, border included. A store built without it
   *   allocates its own, which is what the window does once for each of its
   *   slots; a worker that has just lit a slot hands the arrays it wrote.
   */
  constructor(
    public voxels: Dim3,
    channels?: { skylight: Uint8Array; blocklight: Uint8Array },
  ) {
    const size = paddedVoxelCount(voxels, this.padding);
    this.skylight = channels?.skylight ?? new Uint8Array(size);
    this.blocklight = channels?.blocklight ?? new Uint8Array(size);
  }

  /** The flat index of a signed voxel, border included. */
  paddedIndex(x: number, y: number, z: number): number {
    const [nx, ny] = this.voxels;
    const p = this.padding;
    return ((z + p) * (ny + 2 * p) + (y + p)) * (nx + 2 * p) + (x + p);
  }
}

/** A light channel acted on as one value; `skylight` or `blocklight`. */
export type LightChannel = "skylight" | "blocklight";

/**
 * Builds a `LightStore` sized to shadow `store`, adopting the store's dims and
 * padding. The two arrays are returned empty (all zeros) until a fill ends them.
 */
export const emptyLightStore = (store: VoxelStore): LightStore =>
  new LightStore(store.voxels);
