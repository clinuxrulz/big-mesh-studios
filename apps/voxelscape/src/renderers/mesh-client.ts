import type { VoxelTileConfig } from "./atlas";
import type { WorldBlock } from "../world/level-data";
import { WorldWorkerPool } from "../world/worker-pool";
import { Counter, probe } from "../render/perf-probe";
import {
  buildBlockMesh,
  buildWaterMesh,
  emptyMesh,
  type BlockMeshes,
  type MeshArrays,
  type MeshBuildRequest,
  type MeshBuildResult,
} from "./mesh";

/**
 * How many block meshes to hand the workers per drain, in total; the workers
 * do the heavy lifting, so the main thread only pays for wrapping the requests.
 */
const MAX_BUILDS_PER_DRAIN = 12;

/**
 * Cap on pooled snapshot buffers, in buffers (not blocks): the pool never holds
 * more than this many `Uint8Array`s, so a scroll's burst of rebuilds cannot
 * grow main-thread memory without bound once the cap is reached and buffers
 * are handed back to the garbage collector instead.
 */
const MAX_BUFFER_POOL_SOURCES = 2 * MAX_BUILDS_PER_DRAIN;

/** The geometry of a chunk that holds no surface: nothing to draw. */
const EMPTY_MESH: MeshArrays = emptyMesh();

export interface MeshClientParams {
  /**
   * The blocks a build reads voxel data from, indexed the same way as every
   * index passed in and reported back. Shared with the caller, not copied, so
   * a build reads whatever block occupies that slot at the time it runs.
   */
  blocks: WorldBlock[];
  /**
   * Called with a block's freshly built geometry, from the workers and from
   * the main-thread fallback alike. Results for data that has since been
   * replaced never reach it.
   */
  onMeshBuilt: (index: number, terrain: MeshArrays, water: MeshArrays) => void;
  /** How many builds one `drain` hands the workers, in total. Defaults to twelve. */
  buildsPerDrain?: number;
  /**
   * The world's shared worker pool, used by the fill client too. A caller
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
 * Turns blocks' voxel data into triangle geometry off the main thread,
 * falling back to building on the calling thread if the worker is unavailable
 * or errors.
 *
 * Each block carries a generation counter, bumped whenever its data or the
 * tiles change. A result is applied only if the generation it was requested
 * at is still current, so a build that finishes after the data it read has
 * been replaced is dropped rather than drawn.
 */
export class MeshClient {
  private readonly blocks: WorldBlock[];
  private readonly onMeshBuilt: (
    index: number,
    terrain: MeshArrays,
    water: MeshArrays,
  ) => void;
  private readonly buildsPerDrain: number;

  /** How many times each block's mesh has been invalidated. */
  private readonly generation: number[];
  /** Blocks whose mesh no longer matches their data, waiting to be built. */
  private readonly pending = new Set<number>();
  /** The generation each block's outstanding worker request was made at. */
  private readonly inFlight = new Map<number, number>();
  /**
   * Recycled snapshot buffers returned by the mesh workers, sized per level of
   * detail. A `send` draws from here instead of allocating, so a scroll's
   * burst of rebuilds reuses main-thread buffers rather than churning the
   * garbage collector.
   */
  private readonly bufferPool: Uint8Array[] = [];
  /**
   * The face tile rectangles baked into each vertex's texture coordinates,
   * empty until the atlas is read. A mesh built while it is empty is textured
   * from nothing, which is why `setTiles` invalidates every block.
   */
  private readonly tilesById = new Map<number, VoxelTileConfig>();
  /**
   * The tile list that `tileRects` hands out. Replaced wholesale on `setTiles`
   * so its identity marks the atlas generation a combined mesh was baked for.
   */
  private rects: VoxelTileConfig[] = [];
  private readonly pool: WorldWorkerPool;
  private warnedWorkerError = false;
  private nextWorker = 0;

  constructor(params: MeshClientParams) {
    this.blocks = params.blocks;
    this.onMeshBuilt = params.onMeshBuilt;
    this.buildsPerDrain = params.buildsPerDrain ?? MAX_BUILDS_PER_DRAIN;
    this.generation = new Array(params.blocks.length).fill(0);

    this.pool =
      params.pool ??
      new WorldWorkerPool(
        params.createWorker === undefined
          ? {}
          : { createWorker: params.createWorker, count: 1 },
      );
    this.pool.onMessage((ev) => {
      this.onWorkerMessage(ev.data as MeshBuildResult);
    });
    this.pool.onWorkerLost(() => {
      this.onWorkerLost();
    });
  }

  private onWorkerMessage(msg: MeshBuildResult): void {
    if (msg.type !== "mesh") {
      return;
    }
    const requestedAt = this.inFlight.get(msg.id);
    if (requestedAt === undefined) {
      return;
    }
    this.inFlight.delete(msg.id);
    // The block changed after this request was sent, so the built geometry is
    // stale and dropped — but the snapshot buffers it was built from are still
    // disposable copies, so they go back to the pool either way.
    if (requestedAt !== this.generation[msg.id]) {
      this.releaseBuffer(msg.data);
      this.releaseBuffer(msg.light);
      return;
    }
    probe.count(Counter.meshesLanded);
    this.onMeshBuilt(msg.id, msg.terrain, msg.water);
    this.releaseBuffer(msg.data);
    this.releaseBuffer(msg.light);
  }

  private onWorkerLost(): void {
    if (!this.warnedWorkerError) {
      this.warnedWorkerError = true;
      console.warn(
        "[meshes] worker unavailable; falling back to the remaining workers or the main thread",
      );
    }
    // The builds the lost worker had in flight are owed and will not be
    // delivered; put them back on the queue for a live worker or the main
    // thread to redo.
    for (const index of this.inFlight.keys()) {
      this.pending.add(index);
    }
    this.inFlight.clear();
  }

  /**
   * Marks a block's mesh stale without asking for a new one, so a build
   * already in flight for it is dropped when it lands. For a slot that has
   * moved and has no data yet to build from.
   */
  invalidate(index: number): void {
    this.generation[index]++;
  }

  /** Marks a block's mesh stale and queues a rebuild from its current data. */
  requestBuild(index: number): void {
    this.generation[index]++;
    this.pending.add(index);
  }

  /**
   * Adopts a mesh a worker built alongside a block's fill, and drops any
   * rebuild the block is queued for: its geometry is already current, so
   * nothing is left for a drain to send. The generation is bumped so a build
   * still in flight for the slot (from before its data was replaced) is
   * dropped as stale when it lands.
   */
  acceptMesh(index: number, meshes: BlockMeshes): void {
    this.generation[index]++;
    this.pending.delete(index);
    this.onMeshBuilt(index, meshes.terrain, meshes.water);
  }

  /**
   * Builds one block's mesh on the calling thread, before returning, and
   * takes it off the queue. For the block that has to be on screen before the
   * player is let in: starting the worker and loading its modules costs
   * several times what building a single mesh costs, so a mesh that waits for
   * that start arrives seconds after one built here.
   */
  buildNow(index: number): void {
    this.pending.delete(index);
    this.buildOnThisThread([index]);
  }

  /**
   * Hands the next few queued blocks to the workers, or builds every queued
   * block here if there isn't one. Called once a frame.
   */
  drain(): void {
    if (this.pool.workers.length === 0) {
      const queued = [...this.pending];
      this.pending.clear();
      this.buildOnThisThread(queued);
      return;
    }
    let sent = 0;
    for (const index of this.pending) {
      if (this.inFlight.has(index)) {
        continue;
      }
      if (!this.hasSurfaceData(index)) {
        // A chunk whose derived level is empty (fully buried rock or upper
        // air) can never expose a face, so don't round-trip it through a
        // worker's full-volume sweep.
        this.pending.delete(index);
        this.onMeshBuilt(index, EMPTY_MESH, EMPTY_MESH);
        continue;
      }
      this.send(index);
      this.pending.delete(index);
      if (++sent >= this.buildsPerDrain) {
        break;
      }
    }
  }

  /**
   * Replaces the tile rectangles and queues every block, because each one's
   * texture coordinates are baked into the geometry it was built with. The
   * rect list is swapped for a fresh array, never mutated in place, so a
   * caller holding the previous array can tell the atlas changed.
   */
  setTiles(voxelTiles: VoxelTileConfig[]): void {
    this.tilesById.clear();
    for (const tile of voxelTiles) {
      this.tilesById.set(tile.id, tile);
    }
    this.rects = [...this.tilesById.values()];
    for (let index = 0; index < this.blocks.length; index++) {
      this.requestBuild(index);
    }
  }

  /**
   * The atlas's current tile rectangles, for a combined fill's mesh to bake.
   * The same array is returned until the tiles change, so a combined fill can
   * tell whether a result's mesh was built against the current atlas by
   * comparing references.
   */
  get tileRects(): VoxelTileConfig[] {
    return this.rects;
  }

  /** Blocks queued for a geometry rebuild that no worker has started yet. */
  get pendingCount(): number {
    return this.pending.size;
  }

  /** Blocks a worker is building geometry for right now. */
  get inFlightCount(): number {
    return this.inFlight.size;
  }

  private buildOnThisThread(indices: number[]): void {
    const tiles = [...this.tilesById.values()];
    probe.count(Counter.meshesRequested, indices.length);
    probe.count(Counter.meshesLanded, indices.length);
    for (const index of indices) {
      if (!this.hasSurfaceData(index)) {
        this.onMeshBuilt(index, EMPTY_MESH, EMPTY_MESH);
        continue;
      }
      const store = this.blocks[index].store;
      const light = this.blocks[index].light;
      this.onMeshBuilt(
        index,
        buildBlockMesh(store, tiles, light),
        buildWaterMesh(store, light),
      );
    }
  }

  /**
   * Whether the block holds anything at all to mesh. A slot whose voxels are
   * all air has no face to build, and asking the worker for one costs a round
   * trip to be told nothing. A block that holds only water (a poured pool, an
   * open-ocean slab) has no terrain but still needs its water surface built,
   * so the water flag counts too.
   */
  private hasSurfaceData(index: number): boolean {
    return (
      this.blocks[index].store.mightHaveVoxels ||
      this.blocks[index].store.hasWater
    );
  }

  private send(index: number): void {
    this.generation[index]++;
    this.inFlight.set(index, this.generation[index]);
    probe.count(Counter.meshesRequested);
    const store = this.blocks[index].store;
    const light = this.blocks[index].light;
    const data = this.acquireBuffer(store.data.byteLength);
    data.set(store.data);
    const lightData = this.acquireBuffer(light.data.byteLength);
    lightData.set(light.data);
    const request: MeshBuildRequest = {
      type: "mesh",
      id: index,
      voxels: store.voxels,
      scale: store.scale,
      data,
      hasWater: store.hasWater,
      light: lightData,
      tileRects: [...this.tilesById.values()],
    };
    const worker =
      this.pool.workers[this.nextWorker % this.pool.workers.length];
    this.nextWorker++;
    worker?.postMessage(request, [request.data.buffer, request.light.buffer]);
  }

  /**
   * Returns a snapshot buffer of exactly `size` bytes: a pooled one when the
   * pool holds one of that size, a fresh allocation otherwise.
   */
  private acquireBuffer(size: number): Uint8Array {
    const i = this.bufferPool.findIndex((buf) => buf.byteLength === size);
    if (i >= 0) {
      return this.bufferPool.splice(i, 1)[0];
    }
    return new Uint8Array(size);
  }

  /**
   * Returns a consumed snapshot buffer to the pool, unless the pool is already
   * at its cap, in which case the buffer is left for the garbage collector.
   */
  private releaseBuffer(buf: Uint8Array): void {
    if (this.bufferPool.length < MAX_BUFFER_POOL_SOURCES) {
      this.bufferPool.push(buf);
    }
  }

  dispose(): void {
    this.pool.dispose();
  }
}
