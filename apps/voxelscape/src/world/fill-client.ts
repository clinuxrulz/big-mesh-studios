import {
  applyLevelData,
  blockConfig,
  fillLight,
  type Dim3,
  type WorldBlock,
} from "./level-data";
import type { EditLayer } from "./edit-layer";
import { type FillBatchResult, type FillConfig } from "./fill-worker";
import type { FillMeshBlockResult } from "./fill-mesh-worker";
import type { BlockMeshes } from "../renderers/mesh";
import type { VoxelTileConfig } from "../renderers/atlas";
import type { TerrainConfig } from "./noise";
import { fillStore, type BorderSizes, type FillStoreFn } from "./voxel-store";
import { WorldWorkerPool } from "./worker-pool";

export interface FillClientParams {
  terrain: TerrainConfig;
  /**
   * The blocks a fill result is applied to, indexed the same way as the
   * indices passed to `requestFill`. Shared with the caller, not copied, so
   * a result lands on whatever block currently occupies that slot.
   */
  blocks: WorldBlock[];
  /**
   * Called with a slot's index once its voxel data has been generated and
   * applied. When the fill was a combined one and no edit changed the block,
   * the freshly generated terrain's meshes ride along, so the caller can draw
   * the block without asking for a separately-queued mesh build.
   */
  onBlockChanged: (index: number, meshes?: BlockMeshes) => void;
  /**
   * The world-coordinate edit overlay. After a block's terrain is generated
   * it is re-applied, so edits survive the sphere re-filling a slot when the
   * player scrolls away and back.
   */
  editLayer?: EditLayer;
  customFillStore?: FillStoreFn;
  customFillStoreUrl?: string;
  /**
   * The current atlas tile rectangles, read anew for each batch. When it is
   * supplied, a `requestFill` sends combined fill-and-mesh jobs instead of
   * plain fills, so each worker meshes each block immediately after filling it
   * and the block's geometry arrives with its voxels.
   */
  tileRects?: () => VoxelTileConfig[];
  /**
   * The world's shared worker pool, used by the mesh client too. A caller
   * that hands over a pool pools one set of workers for both jobs; a caller
   * that hands over nothing gets a private pool of `hardwareConcurrency`-1
   * combined workers (or the main-thread fallback).
   */
  pool?: WorldWorkerPool;
  /**
   * Supplies the workers of the pool built when `pool` is omitted. A caller
   * that hands over one worker (or nothing) gets a single worker (or the
   * main-thread fallback) instead.
   */
  createWorker?: () => Worker | undefined;
}

/**
 * How a drain distributes the workload: one batch per worker at a time, of at
 * most this many slots. The worker reports one result per block, so the batch
 * is also the most work a newer scroll can find itself queued behind — a
 * whole entering shell in a single message is what let the player outrun the
 * generation by scrolling while an older shell was still being processed.
 */
const MAX_FILLS_PER_WORKER = 4;

/**
 * Generates blocks' procedural voxel data and derived GPU level layout off
 * the main thread, falling back to generating them synchronously if no worker
 * is available or they all error. A pool of workers shares the load of a
 * scroll's entering shell.
 *
 * Requests are queued, not sent wholesale: each idle worker is handed the
 * nearest few pending slots to the focus point (`requestFill`'s last `focus`),
 * so a scroll that arrives while an earlier shell is still generating has its
 * own nearest cells — the player's among them — taken by the next free worker,
 * instead of waiting behind everything already sent.
 *
 * Each requested slot is tagged with a generation counter. If a slot is
 * requested again before its previous request's result arrives, the stale
 * result is dropped instead of overwriting the newer request's data.
 *
 * When the caller supplies a `tileRects` source, the same worker that fills a
 * block meshes it right after filling, and the block's geometry arrives in
 * the fill result — so a freshly streamed block never sits unmeshed on the
 * main thread waiting for a separately-queued mesh job.
 */
export class FillClient {
  private readonly fillGen: number[];
  /** The level of detail each slot's most recent fill was requested at. */
  private readonly fillLod: number[];
  /** The neighbour-voxel sizes each slot's most recent fill was requested with. */
  private readonly fillBorder: (BorderSizes | undefined)[];
  /** Slots waiting for a worker batch, whatever scroll asked for them. */
  private readonly pendingFills = new Set<number>();
  /** Each pending slot's world-space center, for the nearest-first sort. */
  private readonly pendingCenter = new Map<number, Dim3>();
  /** The level of detail each pending slot will be filled at. */
  private readonly pendingLod = new Map<number, number>();
  /** The neighbour-voxel sizes each pending slot will be filled with. */
  private readonly pendingBorder = new Map<number, BorderSizes>();
  /** The point the nearest-first sort measures distance from, the latest request's. */
  private pendingFocus: Dim3 = [0, 0, 0];
  /** How many fill jobs each worker is owed for the batch it is running. */
  private readonly inFlightCount = new Map<Worker, number>();
  /** Slots with an outstanding worker fill request (for error recovery). */
  private readonly fillInflight = new Set<number>();
  private readonly blocks: WorldBlock[];
  private readonly terrain: TerrainConfig;
  private readonly onBlockChanged: (
    index: number,
    meshes?: BlockMeshes,
  ) => void;
  private readonly customFillStore?: FillStoreFn;
  private readonly customFillStoreUrl?: string;
  private readonly editLayer?: EditLayer;
  private readonly tileRects?: () => VoxelTileConfig[];
  /**
   * The atlas tile list each slot's most recent combined fill was sent with,
   * keyed by slot. Kept so a result can tell whether the meshes it carries
   * were baked against the atlas the renderer uses now; anything else was
   * built for the previous atlas and has to be rebuilt.
   */
  private readonly fillRects = new Map<number, VoxelTileConfig[]>();
  private readonly pool: WorldWorkerPool;
  private warnedWorkerError = false;
  /** Slots waiting to be generated on the main thread, one task each. */
  private readonly pendingSyncFills = new Set<number>();
  /** The level of detail each queued synchronous fill will be generated at. */
  private readonly pendingSyncLods = new Map<number, number>();
  /** The neighbour-voxel sizes each queued synchronous fill will be generated with. */
  private readonly pendingSyncBorder = new Map<number, BorderSizes>();
  private syncFillTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(params: FillClientParams) {
    this.terrain = params.terrain;
    this.blocks = params.blocks;
    this.onBlockChanged = params.onBlockChanged;
    this.customFillStore = params.customFillStore;
    this.customFillStoreUrl = params.customFillStoreUrl;
    this.editLayer = params.editLayer;
    this.tileRects = params.tileRects;
    this.fillGen = new Array(params.blocks.length).fill(0);
    this.fillLod = new Array(params.blocks.length).fill(0);
    this.fillBorder = new Array(params.blocks.length).fill(undefined);

    this.pool =
      params.pool ??
      new WorldWorkerPool(
        params.createWorker === undefined
          ? {}
          : { createWorker: params.createWorker, count: 1 },
      );
    this.pool.onMessage((ev) => {
      this.onWorkerMessage(ev.data as FillBatchResult | FillMeshBlockResult);
    });
    this.pool.onWorkerLost(() => {
      this.onWorkerLost();
    });
    this.pool.onWorkerAdded((worker) => {
      this.sendFillConfig(worker);
      worker.addEventListener("message", (ev) =>
        this.countWorkerResult(worker, ev),
      );
    });
    for (const worker of this.pool.workers) {
      this.sendFillConfig(worker);
      worker.addEventListener("message", (ev) =>
        this.countWorkerResult(worker, ev),
      );
    }
  }

  /** The terrain configuration each pool worker fills with, posted once per worker. */
  private sendFillConfig(worker: Worker): void {
    const fillConfig: FillConfig = {
      terrain: this.terrain,
      customFillStoreUrl: this.customFillStoreUrl,
    };
    worker.postMessage({ type: "config", config: fillConfig });
  }

  private onWorkerMessage(msg: FillBatchResult | FillMeshBlockResult): void {
    if (msg.type === "fillMesh") {
      this.applyMeshedFillResult(msg);
      return;
    }
    if (msg.type !== "fill") {
      return;
    }
    for (let j = 0; j < msg.indices.length; j++) {
      const i = msg.indices[j];
      // The result carries the generation the request it answers was sent
      // under. If the slot has since been requested again (it moved to a
      // different cell while this fill was running), the counter has moved on
      // and this stale fill must be dropped — applying it would paint the
      // old cell's terrain at the new one.
      if (msg.gens[j] !== this.fillGen[i]) {
        continue;
      }
      this.fillInflight.delete(i);
      applyLevelData(this.blocks[i], {
        storeData: msg.storeData[j],
        mightHaveVoxels: msg.mightHaveVoxels[j],
        hasWater: msg.hasWater[j],
        lod: msg.lods[j],
        skyLight: msg.skyLight[j],
        blockLight: msg.blockLight[j],
      });
      // The worker generated and lit the un-edited terrain, so re-lighting is
      // owed only where the overlay changed a voxel of this block (an edit can
      // make a new emitter or open the sky). A pristine block keeps the
      // worker's light, which is exactly the recomputation this pass would
      // otherwise throw away and do again on the main thread.
      if (this.applyEdits(i) > 0) {
        fillLight(this.blocks[i], this.terrain);
      }
      this.onBlockChanged(i);
    }
  }

  /**
   * Applies a combined fill-and-mesh result: adopt the voxels and, when the
   * overlay left the block untouched and the meshes were baked against the
   * atlas the renderer uses now, hand them straight to the caller. A block the
   * overlay edited, or one whose meshes predate the current atlas, carries
   * stale geometry — the worker never saw the edits, and re-lighting can
   * change the brightness its faces were baked at, just as an atlas swap
   * changes each face's texture coordinates — so the meshes are dropped and
   * the block is only reported as changed, which queues a normal mesh rebuild
   * from the current data.
   */
  private applyMeshedFillResult(msg: FillMeshBlockResult): void {
    const i = msg.index;
    if (msg.gen !== this.fillGen[i]) {
      return;
    }
    this.fillInflight.delete(i);
    // The meshes were textured against the tile list the request carried. If
    // the atlas moved on while this job was in the worker (it first loads a
    // fraction of a second after the spawn fill is sent, and can reload), the
    // geometry is stale and must be rebuilt instead of adopted.
    const currentRects = this.tileRects?.() ?? [];
    const meshesMatch = this.fillRects.get(i) === currentRects;
    this.fillRects.delete(i);
    applyLevelData(this.blocks[i], {
      storeData: msg.storeData,
      mightHaveVoxels: msg.mightHaveVoxels,
      hasWater: msg.hasWater,
      lod: msg.lod,
      skyLight: msg.skyLight,
      blockLight: msg.blockLight,
    });
    if (this.applyEdits(i) > 0) {
      fillLight(this.blocks[i], this.terrain);
      this.onBlockChanged(i);
      return;
    }
    if (!meshesMatch) {
      this.onBlockChanged(i);
      return;
    }
    this.onBlockChanged(i, { terrain: msg.terrain, water: msg.water });
  }

  /**
   * Tracks how much a worker still owes, decrementing once per fill result it
   * posts. The worker reports its results one block at a time, so the counter
   * reaching zero is also the "this worker is free for the next batch" signal
   * the drain schedules on.
   */
  private countWorkerResult(worker: Worker, ev: MessageEvent): void {
    const data = ev.data as Partial<{ type: string }>;
    if (data?.type !== "fill" && data?.type !== "fillMesh") {
      return;
    }
    const owed = (this.inFlightCount.get(worker) ?? 0) - 1;
    if (owed <= 0) {
      this.inFlightCount.delete(worker);
    } else {
      this.inFlightCount.set(worker, owed);
    }
    this.drainWorkerFills();
  }

  private onWorkerLost(): void {
    if (!this.warnedWorkerError) {
      this.warnedWorkerError = true;
      console.warn(
        "[fills] worker unavailable; falling back to the remaining workers or synchronous fills",
      );
    }
    for (const i of this.fillInflight) {
      this.syncFillBlock(i, this.fillLod[i], this.fillBorder[i]);
    }
    this.fillInflight.clear();
    this.inFlightCount.clear();
    this.drainWorkerFills();
  }

  /**
   * Generates one slot's voxel data on the calling thread, before returning.
   * For the block that has to exist before anything can be shown: starting a
   * worker and loading its modules costs several times what generating a
   * single block costs, so a block waiting on that start arrives far later
   * than one simply built here.
   *
   * The generation is bumped so any fill still in flight for the slot (from
   * before it moved) is dropped when it lands, instead of painting the old
   * cell's terrain over this fresh synchronous one.
   */
  fillNow(index: number, lod = 0, borderSizes?: BorderSizes): void {
    this.fillGen[index]++;
    this.fillInflight.delete(index);
    this.fillLod[index] = lod;
    this.fillBorder[index] = borderSizes;
    this.syncFillBlock(index, lod, borderSizes);
  }

  /**
   * Requests voxel data for each of these slots, using the worker if it's
   * available or generating it synchronously otherwise. `centers[k]` is the
   * world-space center and `lods[k]` the level of detail at which
   * `indices[k]` should be generated, and `borderSizes[k]` the neighbour
   * voxel sizes its border should cull its seam faces against. `focus` is the
   * point the request's cells are prioritized by distance to (the player at
   * scroll); the nearest cells go out first.
   */
  requestFill(
    indices: number[],
    centers: Dim3[],
    lods: number[],
    borderSizes?: BorderSizes[],
    focus?: Dim3,
  ): void {
    if (this.pool.workers.length === 0) {
      // One block per task rather than one loop over all of them: generating a
      // block takes long enough that a whole window's worth in a single task
      // freezes the page for seconds, with nothing drawn and no loading state
      // shown until the last one is done.
      for (let k = 0; k < indices.length; k++) {
        this.pendingSyncFills.add(indices[k]);
        this.pendingSyncLods.set(indices[k], lods[k]);
        const border = borderSizes?.[k];
        if (border !== undefined) {
          this.pendingSyncBorder.set(indices[k], border);
        }
      }
      this.drainSyncFills();
      return;
    }
    if (focus !== undefined) {
      this.pendingFocus = focus;
    }
    for (let k = 0; k < indices.length; k++) {
      const i = indices[k];
      // Bumping at the request, not at the send: a slot asked for again while
      // an earlier fill for it sits in — or waits for — a worker has moved on,
      // so whatever that older fill later lands must be refused as stale.
      this.fillGen[i]++;
      this.fillLod[i] = lods[k];
      this.fillBorder[i] = borderSizes?.[k];
      this.pendingFills.add(i);
      this.pendingCenter.set(i, centers[k]);
      this.pendingLod.set(i, lods[k]);
      this.pendingBorder.set(i, borderSizes?.[k] ?? <BorderSizes>{});
    }
    this.drainWorkerFills();
  }

  /**
   * Hands the nearest pending slots to the free workers — up to
   * `MAX_FILLS_PER_WORKER` slots each, one batch per worker — so a scroll's
   * own nearest cells are taken by the next free worker instead of queuing
   * behind an entire earlier scroll's shell.
   */
  private drainWorkerFills(): void {
    const workers = this.pool.workers;
    if (workers.length === 0 || this.pendingFills.size === 0) {
      return;
    }
    const sorted = [...this.pendingFills].sort(
      (a, b) => this.distanceSquaredTo(a) - this.distanceSquaredTo(b),
    );
    const combined = this.tileRects !== undefined;
    let offset = 0;
    for (const worker of workers) {
      if ((this.inFlightCount.get(worker) ?? 0) > 0) {
        continue;
      }
      const indices = sorted.slice(offset, offset + MAX_FILLS_PER_WORKER);
      if (indices.length === 0) {
        return;
      }
      offset += indices.length;
      for (const index of indices) {
        this.pendingFills.delete(index);
      }
      const centers = indices.map(
        (i) => this.pendingCenter.get(i) ?? ([0, 0, 0] as Dim3),
      );
      const lods = indices.map((i) => this.pendingLod.get(i) ?? 0);
      const batchBorders = indices.map(
        (i) => this.pendingBorder.get(i) ?? <BorderSizes>{},
      );
      if (combined) {
        this.sendMeshedFillBatch(indices, centers, lods, batchBorders, worker);
      } else {
        this.sendFillBatch(indices, centers, lods, batchBorders, worker);
      }
    }
  }

  private distanceSquaredTo(index: number): number {
    const [bx, by, bz] = this.pendingCenter.get(index) ?? [0, 0, 0];
    const [fx, fy, fz] = this.pendingFocus;
    return (bx - fx) ** 2 + (by - fy) ** 2 + (bz - fz) ** 2;
  }

  private drainSyncFills(): void {
    if (this.syncFillTimer !== undefined) {
      return;
    }
    const next = this.pendingSyncFills.values().next();
    if (next.done === true) {
      return;
    }
    const index = next.value;
    this.pendingSyncFills.delete(index);
    const lod = this.pendingSyncLods.get(index) ?? 0;
    this.pendingSyncLods.delete(index);
    const borderSizes = this.pendingSyncBorder.get(index);
    this.pendingSyncBorder.delete(index);
    this.syncFillTimer = setTimeout(() => {
      this.syncFillTimer = undefined;
      this.syncFillBlock(index, lod, borderSizes);
      this.drainSyncFills();
    }, 0);
  }

  private syncFillBlock(i: number, lod = 0, borderSizes?: BorderSizes): void {
    const block = this.blocks[i];
    // The store's resolution is the fill's: a slot filled at a different
    // level of detail than it was built at has to read its voxels at that
    // LOD's scale before the fill writes into it.
    const { dimensions, voxels, voxelSize } = blockConfig(lod);
    block.store.dims = dimensions;
    block.store.voxels = voxels;
    block.store.scale = voxelSize;
    block.targetLod = lod;
    const fill = this.customFillStore ?? fillStore;
    fill(block.store, block.center, this.terrain, borderSizes);
    this.applyEdits(i);
    fillLight(block, this.terrain);
    this.onBlockChanged(i);
  }

  /**
   * Re-applies the edit overlay to a block's slot, so a refilled slot
   * reflects edits recorded since its last fill.
   *
   * @returns The number of store voxels the overlay wrote, which is how the
   * caller knows whether anything that could change the block's light landed.
   */
  private applyEdits(i: number): number {
    const layer = this.editLayer;
    if (layer === undefined) {
      return 0;
    }
    return layer.applyToBlock(this.blocks[i]);
  }

  /**
   * Marks the batch's slots in flight on this worker, so a result frees the
   * worker for its next batch and a lost worker's restoration knows what it
   * owed. The generations rise with each request, never at the send; `gensOf`
   * simply echoes what they are now.
   */
  private attachBatch(indices: number[], worker: Worker): void {
    for (const i of indices) {
      this.fillInflight.add(i);
    }
    this.inFlightCount.set(
      worker,
      (this.inFlightCount.get(worker) ?? 0) + indices.length,
    );
  }

  private gensOf(indices: number[]): number[] {
    return indices.map((i) => this.fillGen[i]);
  }

  private sendFillBatch(
    indices: number[],
    centers: Dim3[],
    lods: number[],
    borderSizes: BorderSizes[],
    worker: Worker,
  ): void {
    this.attachBatch(indices, worker);
    worker.postMessage({
      type: "fill",
      indices,
      centers,
      lods,
      borderSizes,
      gens: this.gensOf(indices),
    });
  }

  private sendMeshedFillBatch(
    indices: number[],
    centers: Dim3[],
    lods: number[],
    borderSizes: BorderSizes[],
    worker: Worker,
  ): void {
    this.attachBatch(indices, worker);
    const rects = this.tileRects?.() ?? [];
    for (const index of indices) {
      this.fillRects.set(index, rects);
    }
    worker.postMessage({
      type: "fillMesh",
      indices,
      centers,
      lods,
      borderSizes,
      gens: this.gensOf(indices),
      tileRects: rects,
    });
  }

  dispose(): void {
    this.pool.dispose();
  }
}
