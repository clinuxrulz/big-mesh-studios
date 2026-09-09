// @vitest-environment node
import { describe, expect, it } from "vitest";
import { PerspectiveCamera } from "@random-mesh/rmsl/scene";
import { scBounds, TriangleRenderer } from "./triangle-renderer";
import { probeColor } from "./occlusion";
import { buildBlockShell, type WorldBlock } from "../world/level-data";
import { VOXEL_GRASS } from "../world/voxel-store";
import type { TileRect } from "./atlas";

/** A block with a floor of grass across one corner, so it has faces to mesh. */
const blockWithFloor = (): WorldBlock => {
  const block = buildBlockShell({ center: [0, 0, 0] });
  for (let x = 0; x < 4; x++) {
    for (let z = 0; z < 4; z++) {
      block.store.set(x, 0, z, VOXEL_GRASS);
    }
  }
  return block;
};

/** A renderer holding these blocks, with a tile for the voxel they are drawn in. */
const rendererFor = (...blocks: WorldBlock[]): TriangleRenderer =>
  rendererForBudget(undefined, ...blocks);

/** As `rendererFor`, but capping each frame's merged upload at `budget` bytes. */
const rendererForBudget = (
  budget: number | undefined,
  ...blocks: WorldBlock[]
): TriangleRenderer => {
  const renderer = new TriangleRenderer({
    blocks,
    waterExtinction: 0.1,
    seaLevel: undefined,
    onBlockMeshed: () => {},
    uploadBytesPerFrame: budget,
  });
  /** The whole atlas as one tile: these tests are about what is drawn, not where from. */
  const whole: TileRect = [0, 0, 1, 1];
  renderer.setTiles(
    [{ id: VOXEL_GRASS, top: whole, side: whole, bottom: whole }],
    {} as never,
  );
  return renderer;
};

/** Runs enough frames for a meshed block to be merged into its superchunk. */
const settle = (renderer: TriangleRenderer): void => {
  const camera = new PerspectiveCamera(60, 1, 0.1, 1000);
  for (let frame = 0; frame < 10; frame++) {
    renderer.tick(0.016, camera);
  }
};

describe("TriangleRenderer", () => {
  it("shows a block it has meshed", () => {
    // The camera at the origin and the block's superchunk contain each other,
    // so the frustum hides nothing: a block with geometry is a block that is
    // drawn. This is the whole of what a player sees of the world, and it
    // went unnoticed once already.
    const renderer = rendererFor(blockWithFloor());

    renderer.repositionBlock(0, [0, 0, 0]);
    renderer.onBlockChanged(0);
    renderer.meshNow(0);
    settle(renderer);

    expect(renderer.triangleCount).toBeGreaterThan(0);
    expect(renderer.terrain.children).toHaveLength(1);
    expect(renderer.terrain.children[0].visible).toBe(true);
  });

  it("unseats a slot's mesh when it is repositioned, so recycled geometry cannot flash", () => {
    // Slot 0 and slot 1 sit in different superchunks. Once slot 0's mesh is
    // seated in its own superchunk, recycling the slot to a cell in slot 1's
    // superchunk drops its old superchunk's geometry pair into the pool — a
    // pair the slot's world mesh still referenced. The mesh must stop drawing
    // (empty range) at the moment of the move, not when the new cell's data
    // arrives, or it shows whatever geometry that pair is next filled with.
    const renderer = rendererFor(blockWithFloor(), blockWithFloor());
    const camera = new PerspectiveCamera(60, 1, 0.1, 1000);
    camera.position.set(0, 0, 0);
    camera.lookAt(512, 0, 0); // face +x so both superchunks stay in the frustum
    const tick = (): void => renderer.tick(0.016, camera);

    renderer.repositionBlock(0, [0, 0, 0]);
    renderer.repositionBlock(1, [256, 0, 0]);
    renderer.onBlockChanged(0);
    renderer.meshNow(0);
    for (let frame = 0; frame < 10; frame++) {
      tick();
    }
    const rendererState = renderer as unknown as {
      scChunkTerrain: Map<number, { drawRange: { count: number } }>;
      slotCenter: Map<number, unknown>;
    };
    expect(
      rendererState.scChunkTerrain.get(0)!.drawRange.count,
    ).toBeGreaterThan(0);

    renderer.repositionBlock(0, [384, 0, 0]);
    expect(rendererState.scChunkTerrain.get(0)!.drawRange.count).toBe(0);
    expect(rendererState.slotCenter.has(0)).toBe(false);

    // The new cell's data lands and is meshed: the slot draws again, seated in
    // its new superchunk.
    renderer.onBlockChanged(0);
    renderer.meshNow(0);
    for (let frame = 0; frame < 10; frame++) {
      tick();
    }
    expect(
      rendererState.scChunkTerrain.get(0)!.drawRange.count,
    ).toBeGreaterThan(0);
    expect(renderer.triangleCount).toBeGreaterThan(0);
  });

  it("draws nothing for a block with no voxels in it", () => {
    const renderer = rendererFor(buildBlockShell({ center: [0, 0, 0] }));

    renderer.repositionBlock(0, [0, 0, 0]);
    renderer.onBlockChanged(0);
    renderer.meshNow(0);
    settle(renderer);

    expect(renderer.triangleCount).toBe(0);
    for (const mesh of renderer.terrain.children) {
      expect(mesh.visible).toBe(false);
    }
  });

  it("hides a superchunk the camera cannot see", () => {
    // Geometry is uploaded and kept, but a superchunk out of the frustum is
    // not drawn; the frame the camera turns onto it shows it without a rebuild.
    const renderer = rendererFor(blockWithFloor());

    renderer.repositionBlock(0, [100000, 0, 0]);
    renderer.onBlockChanged(0);
    renderer.meshNow(0);
    settle(renderer);

    for (const mesh of renderer.terrain.children) {
      expect(mesh.visible).toBe(false);
    }
  });

  it("bounds a superchunk by the box its merged geometry fills", () => {
    // A superchunk's two block centroids sit one BLOCK_WORLD apart, so the
    // merged geometry reaches a block-half before the superchunk's own centre
    // and a block-half plus a superchunk beyond it. A box centred on the
    // superchunk itself misses that far block-half, hiding it while it was
    // still on screen — the vanish this culling took for a frustum bug.
    const cellZero = scBounds("0,0,0");
    expect(cellZero.half).toBe(128);
    expect(cellZero.center).toEqual([64, 64, 64]);
    expect(scBounds("1,-1,2").center).toEqual([320, -192, 576]);
  });

  it("holds a superchunk back until every block of one edit has landed", () => {
    // A voxel on a chunk's boundary belongs to several blocks. Showing the
    // one that no longer draws it, before the ones that still cull a face
    // against it have caught up, is the hole. Here the second block never
    // reports back, so the first stays held.
    const renderer = rendererFor(blockWithFloor(), blockWithFloor());
    const camera = new PerspectiveCamera(60, 1, 0.1, 1000);
    renderer.repositionBlock(0, [0, 0, 0]);

    renderer.onBlocksChanged([0, 1]);
    renderer.meshNow(0);
    renderer.tick(0.016, camera);

    expect(renderer.terrain.children.filter((m) => m.visible)).toHaveLength(0);
  });

  it("defers merging a superchunk the occlusion pass has proved covered", () => {
    // A scroll hands the renderer a lot of chunks whose superchunks sit behind
    // terrain the culler has already seen. Merging and uploading those is the
    // main-thread cost the gate exists to skip: a superchunk whose every
    // content member a query found covered stays dirty, and only merges the
    // frame a later query (or a move that re-exposes it) sees a member again.
    const renderer = rendererFor(blockWithFloor());
    const camera = new PerspectiveCamera(60, 1, 0.1, 1000);
    camera.position.set(0, 0, 0);
    camera.lookAt(512, 0, 0); // face the block so the frustum keeps its cell

    renderer.repositionBlock(0, [512, 0, 0]);
    renderer.onBlockChanged(0);
    renderer.meshNow(0);
    const tick = (): void => renderer.tick(0.016, camera);

    // The last query measured slot 0 and never saw it win a pixel.
    const occlusion = renderer as unknown as {
      lastQueryTested: Set<number>;
      lastVisible: Set<number>;
    };
    occlusion.lastQueryTested = new Set([0]);
    occlusion.lastVisible = new Set();
    for (let frame = 0; frame < 10; frame++) {
      tick();
    }

    // Covered by occlusion, so the merged geometry never reaches the GPU even
    // though the block is meshed and its superchunk is in the frustum.
    expect(renderer.triangleCount).toBe(0);

    // A later query sees it; the next tick merges and shows it.
    occlusion.lastVisible = new Set([0]);
    tick();
    expect(renderer.triangleCount).toBeGreaterThan(0);
  });

  it("gives up holding when a block of the group never comes back", () => {
    // Nothing may be kept off the screen forever. Past the stall backstop
    // whatever has landed is shown, and a straggler uploads on its own.
    const renderer = rendererFor(blockWithFloor(), blockWithFloor());
    const camera = new PerspectiveCamera(60, 1, 0.1, 1000);
    renderer.repositionBlock(0, [0, 0, 0]);

    renderer.onBlocksChanged([0, 1]);
    renderer.meshNow(0);
    for (let frame = 0; frame < 12; frame++) {
      renderer.tick(0.016, camera);
    }

    expect(renderer.terrain.children.filter((m) => m.visible)).toHaveLength(1);
  });

  it("paces in-frustum superchunk uploads across frames within the byte budget", () => {
    // Three blocks in three superchunks, all in the camera's frustum and
    // unmeasured by the occlusion pass: merging and uploading them all on one
    // frame is the stall the budget exists to prevent. A one-byte frame budget
    // leaves each tick enough for the nearest outstanding superchunk alone, so
    // the visible world gains one chunk at a time.
    const renderer = rendererForBudget(
      1,
      blockWithFloor(),
      blockWithFloor(),
      blockWithFloor(),
    );
    const camera = new PerspectiveCamera(60, 1, 0.1, 1000);
    camera.lookAt(1024, 0, 0); // face +x so every superchunk stays in the frustum

    renderer.repositionBlock(0, [0, 0, 0]);
    renderer.repositionBlock(1, [256, 0, 0]);
    renderer.repositionBlock(2, [512, 0, 0]);
    for (const index of [0, 1, 2]) {
      renderer.onBlockChanged(index);
      renderer.meshNow(index);
    }

    const visible = (): number =>
      renderer.terrain.children.filter((mesh) => mesh.visible).length;

    renderer.tick(0.016, camera);
    expect(visible()).toBe(1);
    renderer.tick(0.016, camera);
    expect(visible()).toBe(2);
    renderer.tick(0.016, camera);
    expect(visible()).toBe(3);
    expect(renderer.triangleCount).toBeGreaterThan(0);
  });
});

describe("the occlusion probe's slot id", () => {
  /** Every probe mesh the renderer put in its occlusion scene. */
  const probes = (
    renderer: TriangleRenderer,
  ): { material: unknown; onBeforeRender?: () => void }[] => {
    const inside = renderer as unknown as {
      occlusionScene: { children: { material: unknown }[] };
    };
    return inside.occlusionScene.children;
  };

  /** A renderer with one meshed block, merged into its superchunk. */
  const meshed = (): TriangleRenderer => {
    const renderer = rendererFor(blockWithFloor());
    renderer.repositionBlock(0, [0, 0, 0]);
    renderer.onBlockChanged(0);
    renderer.meshNow(0);
    settle(renderer);
    return renderer;
  };

  it("is painted on by the mesh that draws it, not carried on its vertices", () => {
    const renderer = meshed();
    const [probe] = probes(renderer);
    expect(probe).toBeDefined();
    const material = probe.material as { slotColor: [number, number, number] };
    material.slotColor = [0, 0, 0];
    probe.onBeforeRender?.();
    expect(material.slotColor).toEqual(probeColor(0));
  });

  it("leaves no colour on the merged geometry", () => {
    const renderer = meshed();
    const [probe] = probes(renderer);
    const geometry = (probe as unknown as { geometry: BufferGeometryLike })
      .geometry;
    expect(geometry.getAttribute("occlusionColor")).toBeUndefined();
  });
});

/** As much of a geometry as the test above reads. */
interface BufferGeometryLike {
  getAttribute(name: string): unknown;
}
