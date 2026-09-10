// @vitest-environment node
import { describe, expect, it } from "vitest";
import { EMISSIVE_LEVEL, LightStore, MAX_LIGHT } from "./light-store";
import { fillBlockLight } from "./block-light";
import { VOXEL_AIR, VOXEL_DIRT, VOXEL_LAVA, VoxelStore } from "./voxel-store";

const smallStore = (): VoxelStore =>
  new VoxelStore({
    dims: [8, 8, 8],
    voxels: [8, 8, 8],
    scale: 2,
  });

describe("LightStore", () => {
  it("adopts the light it is handed instead of allocating channels to overwrite", () => {
    // The worker lights a slot into the arrays it was given and hands them
    // back; a store allocating its own here would zero two volumes nobody
    // reads.
    const store = smallStore();
    const data = new Uint8Array(store.data.length);
    const light = new LightStore(store.voxels, data);
    light.setSkylightAt(0, MAX_LIGHT);
    expect(light.data).toBe(data);
    expect(light.skylightAt(0)).toBe(MAX_LIGHT);
    // The channels share a byte, so writing one must leave the other alone.
    expect(light.blocklightAt(0)).toBe(0);
  });

  it("allocates its own channels when it is handed none", () => {
    const store = smallStore();
    const light = new LightStore(store.voxels);
    expect(light.data.length).toBe(store.data.length);
  });
});

describe("fillBlockLight", () => {
  it("seeds an emissive voxel at its listed level", () => {
    const store = smallStore();
    store.set(4, 4, 4, VOXEL_LAVA);
    const light = new LightStore(store.voxels);
    fillBlockLight(store, light);
    expect(light.blocklightAt(light.paddedIndex(4, 4, 4))).toBe(
      EMISSIVE_LEVEL[VOXEL_LAVA],
    );
  });

  it("spreads a diamond that decays with distance through the air", () => {
    const store = smallStore();
    store.set(4, 4, 4, VOXEL_LAVA);
    const light = new LightStore(store.voxels);
    fillBlockLight(store, light);
    const near = light.blocklightAt(light.paddedIndex(5, 4, 4));
    const far = light.blocklightAt(light.paddedIndex(7, 4, 4));
    expect(near).toBeGreaterThan(far);
    expect(far).toBeGreaterThan(0);
  });

  it("does not shine through solid rock", () => {
    const store = smallStore();
    store.set(4, 4, 4, VOXEL_LAVA);
    store.set(5, 4, 4, VOXEL_DIRT);
    store.set(6, 4, 4, VOXEL_AIR);
    const light = new LightStore(store.voxels);
    fillBlockLight(store, light);
    expect(light.blocklightAt(light.paddedIndex(5, 4, 4))).toBeLessThan(
      MAX_LIGHT,
    );
  });

  it("clears the channel before refilling so removed emitters go dark", () => {
    const store = smallStore();
    store.set(4, 4, 4, VOXEL_LAVA);
    const light = new LightStore(store.voxels);
    fillBlockLight(store, light);
    store.set(4, 4, 4, VOXEL_AIR);
    fillBlockLight(store, light);
    expect(light.blocklightAt(light.paddedIndex(4, 4, 4))).toBe(0);
  });
});
