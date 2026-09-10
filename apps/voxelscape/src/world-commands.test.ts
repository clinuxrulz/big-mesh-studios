// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import {
  createCommands,
  type Commander,
  type CommandsParams,
} from "./commands";
import { DEFAULT_LOD_BANDS } from "./world/chunk-sphere";
import type { VoxelWorld } from "./world/create-voxel-world";

/**
 * A world that records what it was asked to become. Only the handful of things
 * the two window commands read are real; a command that reached for anything
 * else would fail here rather than quietly work on a stub.
 */
const worldSpy = () => {
  const reshape = vi.fn();
  const world = {
    reshape,
    blocks: new Array(25),
    chunkRadius: 4,
    chunkRadiusY: 2,
    lodBands: DEFAULT_LOD_BANDS,
    ringRadius: 512,
    voxelBytes: 50 * 1048576,
  } as unknown as VoxelWorld;
  return { world, reshape };
};

/** The console, built with only the part of the world these commands read. */
const windowCommands = (world: VoxelWorld): Commander =>
  createCommands({ world } as unknown as CommandsParams);

describe("/world:radius", () => {
  it("reports the window without changing it", () => {
    const { world, reshape } = worldSpy();
    const said = windowCommands(world).run("/world:radius");
    expect(reshape).not.toHaveBeenCalled();
    expect(said).toContain("radius 4");
    expect(said).toContain("25 blocks");
    expect(said).toContain("512 world units");
  });

  it("takes a radius far wider than the default", () => {
    const { world, reshape } = worldSpy();
    windowCommands(world).run("/world:radius 32");
    expect(reshape).toHaveBeenCalledWith({
      chunkRadius: 32,
      chunkRadiusY: undefined,
    });
  });

  it("resizes to a radius, leaving the vertical one alone", () => {
    const { world, reshape } = worldSpy();
    windowCommands(world).run("/world:radius 5");
    expect(reshape).toHaveBeenCalledWith({
      chunkRadius: 5,
      chunkRadiusY: undefined,
    });
  });

  it("takes a vertical radius of its own", () => {
    const { world, reshape } = worldSpy();
    windowCommands(world).run("/world:radius 5 3");
    expect(reshape).toHaveBeenCalledWith({ chunkRadius: 5, chunkRadiusY: 3 });
  });

  it("refuses a radius that is not a whole number in range", () => {
    for (const bad of ["0", "33", "2.5", "lots", "-1"]) {
      const { world, reshape } = worldSpy();
      const said = windowCommands(world).run(`/world:radius ${bad}`);
      expect(reshape).not.toHaveBeenCalled();
      expect(said).toContain("usage");
    }
  });
});

describe("/world:lod", () => {
  it("reports where the levels of detail reach", () => {
    const { world } = worldSpy();
    const said = windowCommands(world).run("/world:lod");
    expect(said).toContain("full detail to 3 chunks");
    expect(said).toContain("coarser to 4");
  });

  it("moves both bands at once", () => {
    const { world, reshape } = worldSpy();
    windowCommands(world).run("/world:lod 2 5");
    expect(reshape).toHaveBeenCalledWith({ lodBands: { full: 2, coarse: 5 } });
  });

  it("refuses bands that would put the coarser shell nearer than the full one", () => {
    const { world, reshape } = worldSpy();
    const said = windowCommands(world).run("/world:lod 4 2");
    expect(reshape).not.toHaveBeenCalled();
    expect(said).toContain("usage");
  });

  it("refuses a band that is not a whole number", () => {
    const { world, reshape } = worldSpy();
    const said = windowCommands(world).run("/world:lod 1.5 4");
    expect(reshape).not.toHaveBeenCalled();
    expect(said).toContain("usage");
  });
});

describe("what /help lists", () => {
  it("names both window commands with the arguments they take", () => {
    const { world } = worldSpy();
    const listed = windowCommands(world).help();
    const radius = listed.find((c) => c.name === "/world:radius");
    const lod = listed.find((c) => c.name === "/world:lod");
    expect(radius?.args).toBe("<1..32> [yRadius]");
    expect(lod?.args).toBe("<full> <coarse>");
  });
});
