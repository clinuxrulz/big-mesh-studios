import {
  applyLevelData,
  blockConfig,
  fillLight,
  type Dim3,
  type WorldBlock,
} from "./level-data";
import type { EditLayer } from "./edit-layer";
import { type FillBatchResult, type FillConfig } from "./fill-worker";
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
  /** Called with a slot's index once its voxel data has been generated and applied. */
  onBlockChanged: (index: number) => void;
  /**
   * The world-coordinate edit overlay. After a block's terrain is generated
   * it is re-applied, so edits survive the sphere re-filling a slot when the
   * player scrolls away and back.
   */
  editLayer?: EditLayer;
  customFillStore?: FillStoreFn;
  customFillStoreUrl?: string;
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
 * Generates blocks' procedural voxel data and derived GPU level layout off
 * the main thread, falling back to generating them synchronously if no worker
 * is available or they all error. A pool of workers shares the load of a
 * scroll's entering shell.
 *
 * Each requested slot is tagged with a generation counter. If a slot is
 * requested again before its previous request's result arrives, the stale
 * result is dropped instead of overwriting the newer request's data.
 */
export class FillClient {
  private readonly fillGen: number[];
  /** The level of detail each slot's most recent fill was requested at. */
  private readonly fillLod: number[];
  /** The neighbour-voxel sizes each slot's most recent fill was requested with. */
  private readonly fillBorder: (BorderSizes | undefined)[];
  /** Slots with an outstanding worker fill request (for error recovery). */
  private readonly fillInflight = new Set<number>();
  private readonly blocks: WorldBlock[];
  private readonly terrain: TerrainConfig;
  private readonly onBlockChanged: (index: number) => void;
  private readonly customFillStore?: FillStoreFn;
  private readonly customFillStoreUrl?: string;
  private readonly editLayer?: EditLayer;
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
      this.onWorkerMessage(ev.data as FillBatchResult);
    });
    this.pool.onWorkerLost(() => {
      this.onWorkerLost();
    });
    this.pool.onWorkerAdded((worker) => {
      this.sendFillConfig(worker);
    });
    for (const worker of this.pool.workers) {
      this.sendFillConfig(worker);
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

  private onWorkerMessage(msg: FillBatchResult): void {
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
   * voxel sizes its border should cull its seam faces against.
   */
  requestFill(
    indices: number[],
    centers: Dim3[],
    lods: number[],
    borderSizes?: BorderSizes[],
  ): void {
    if (this.pool.workers.length > 0) {
      // Split the batch across the pool, round-robin, so a scroll's entering
      // shell generates on several threads at once.
      const batches: Array<{
        indices: number[];
        centers: Dim3[];
        lods: number[];
        borderSizes: BorderSizes[];
      }> = this.pool.workers.map(() => ({
        indices: [],
        centers: [],
        lods: [],
        borderSizes: [],
      }));
      for (let k = 0; k < indices.length; k++) {
        batches[k % batches.length].indices.push(indices[k]);
        batches[k % batches.length].centers.push(centers[k]);
        batches[k % batches.length].lods.push(lods[k]);
        batches[k % batches.length].borderSizes.push(borderSizes?.[k] ?? {});
      }
      for (let w = 0; w < this.pool.workers.length; w++) {
        const batch = batches[w];
        if (batch.indices.length > 0) {
          this.sendFillBatch(
            batch.indices,
            batch.centers,
            batch.lods,
            batch.borderSizes,
            this.pool.workers[w],
          );
        }
      }
      return;
    }
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

  private sendFillBatch(
    indices: number[],
    centers: Dim3[],
    lods: number[],
    borderSizes: BorderSizes[],
    worker: Worker,
  ): void {
    const gens: number[] = [];
    for (let k = 0; k < indices.length; k++) {
      const i = indices[k];
      this.fillGen[i]++;
      gens.push(this.fillGen[i]);
      this.fillLod[i] = lods[k];
      this.fillBorder[i] = borderSizes[k];
      this.fillInflight.add(i);
    }
    worker.postMessage({
      type: "fill",
      indices,
      centers,
      lods,
      borderSizes,
      gens,
    });
  }

  dispose(): void {
    this.pool.dispose();
  }
}
