// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { FillClient } from "./fill-client";
import { WorldWorkerPool } from "./worker-pool";
import { buildBlockShell } from "./level-data";
import { DEFAULT_TERRAIN } from "./noise";
import type { FillBatchRequest, FillBatchResult } from "./fill-worker";

/**
 * A worker that records what it is sent (with the per-request generations)
 * and hands results back only when told to, so a fill can be made to finish
 * after the slot it was requested for has been moved on. Speaks the pool's
 * listener interface (`addEventListener`) rather than the `onmessage`/
 * `onerror` properties, because a `WorldWorkerPool` shares its workers between
 * the fill and mesh clients.
 */
class FakeFillWorker {
  readonly sent: FillBatchRequest[] = [];
  readonly messageListeners: Array<(ev: MessageEvent) => void> = [];
  readonly errorListeners: Array<(ev: MessageEvent) => void> = [];
  terminated = false;

  addEventListener(
    type: "message" | "error",
    listener: (ev: MessageEvent) => void,
  ): void {
    if (type === "message") {
      this.messageListeners.push(listener);
    } else {
      this.errorListeners.push(listener);
    }
  }

  removeEventListener(
    type: "message" | "error",
    listener: (ev: MessageEvent) => void,
  ): void {
    const listeners =
      type === "message" ? this.messageListeners : this.errorListeners;
    const index = listeners.indexOf(listener);
    if (index >= 0) {
      listeners.splice(index, 1);
    }
  }

  postMessage(request: unknown): void {
    if (
      typeof request === "object" &&
      request !== null &&
      (request as { type?: string }).type === "config"
    ) {
      return;
    }
    this.sent.push(request as FillBatchRequest);
  }

  terminate(): void {
    this.terminated = true;
  }

  /** Fires the worker's error listeners, as the pool's dropped-worker path does. */
  error(): void {
    for (const listener of this.errorListeners) {
      listener({} as MessageEvent);
    }
  }

  /** Delivers a result for the request at `sentIndex`, as the worker would. */
  deliver(sentIndex: number): void {
    const request = this.sent[sentIndex];
    const result: FillBatchResult = {
      type: "fill",
      indices: request.indices,
      gens: request.gens,
      lods: request.lods,
      storeData: request.indices.map(() => new Uint8Array(0)),
      mightHaveVoxels: request.indices.map(() => true),
      hasWater: request.indices.map(() => false),
      skyLight: request.indices.map(() => new Uint8Array(0)),
      blockLight: request.indices.map(() => new Uint8Array(0)),
    };
    for (const listener of this.messageListeners) {
      listener({ data: result } as MessageEvent);
    }
  }
}

describe("FillClient", () => {
  it("drops a fill result for a slot requested again before the fill landed", () => {
    const blocks = [buildBlockShell({ center: [0, 0, 0] })];
    const worker = new FakeFillWorker();
    const changed = vi.fn();
    const client = new FillClient({
      terrain: DEFAULT_TERRAIN,
      blocks,
      onBlockChanged: changed,
      createWorker: () => worker as unknown as Worker | undefined,
    });

    // First a fill for the slot at cell A, then — before it returns — the
    // same slot is re-requested at cell B (the sphere moved it on).
    client.requestFill([0], [[0, 0, 0]], [0]);
    blocks[0].center = [128, 0, 0];
    client.requestFill([0], [[128, 0, 0]], [0]);

    expect(worker.sent).toHaveLength(2);
    expect(worker.sent[0].gens).toEqual([1]);
    expect(worker.sent[1].gens).toEqual([2]);

    // The stale fill for cell A must not be applied to the slot now at B.
    worker.deliver(0);
    expect(changed).not.toHaveBeenCalled();

    // The current fill lands and is applied.
    worker.deliver(1);
    expect(changed).toHaveBeenCalledWith(0);
  });

  it("applies a fill whose result is still current", () => {
    const blocks = [buildBlockShell({ center: [0, 0, 0] })];
    const worker = new FakeFillWorker();
    const changed = vi.fn();
    const client = new FillClient({
      terrain: DEFAULT_TERRAIN,
      blocks,
      onBlockChanged: changed,
      createWorker: () => worker as unknown as Worker | undefined,
    });

    client.requestFill([0], [[0, 0, 0]], [0]);
    worker.deliver(0);
    expect(changed).toHaveBeenCalledWith(0);
  });

  it("sends each slot's requested level of detail to the worker", () => {
    const blocks = [buildBlockShell({ center: [0, 0, 0] })];
    const worker = new FakeFillWorker();
    const client = new FillClient({
      terrain: DEFAULT_TERRAIN,
      blocks,
      onBlockChanged: () => {},
      createWorker: () => worker as unknown as Worker | undefined,
    });

    client.requestFill([0], [[0, 0, 0]], [2]);
    expect(worker.sent[0].lods).toEqual([2]);
  });

  it("sizes the slot's store to the level of detail it fills at", () => {
    const blocks = [buildBlockShell({ center: [0, 0, 0] })];
    const client = new FillClient({
      terrain: DEFAULT_TERRAIN,
      blocks,
      onBlockChanged: () => {},
    });

    client.fillNow(0, 2);
    expect(blocks[0].store.voxels).toEqual([16, 16, 16]);
    expect(blocks[0].store.scale).toBe(8);
  });

  it("drops an in-flight fill for a slot synchronously refilled before it lands", () => {
    const blocks = [buildBlockShell({ center: [0, 0, 0] })];
    const worker = new FakeFillWorker();
    const changed = vi.fn();
    const client = new FillClient({
      terrain: DEFAULT_TERRAIN,
      blocks,
      onBlockChanged: changed,
      createWorker: () => worker as unknown as Worker | undefined,
    });

    client.requestFill([0], [[0, 0, 0]], [0]);
    // The player stepped into this cell, so it is filled on the calling
    // thread — that must invalidate the request already in flight.
    client.fillNow(0);
    expect(changed).toHaveBeenCalledTimes(1); // the synchronous fill

    worker.deliver(0);
    expect(changed).toHaveBeenCalledTimes(1); // the stale fill was dropped
  });

  it("terminates the workers when disposed", () => {
    const worker = new FakeFillWorker();
    const client = new FillClient({
      terrain: DEFAULT_TERRAIN,
      blocks: [buildBlockShell({ center: [0, 0, 0] })],
      onBlockChanged: () => {},
      createWorker: () => worker as unknown as Worker | undefined,
    });
    client.dispose();
    expect(worker.terminated).toBe(true);
  });

  it("ignores a mesh result posted on the same shared pool", () => {
    const worker = new FakeFillWorker();
    const pool = new WorldWorkerPool({
      createWorker: () => worker as unknown as Worker,
      count: 1,
    });
    const changed = vi.fn();
    const client = new FillClient({
      terrain: DEFAULT_TERRAIN,
      blocks: [buildBlockShell({ center: [0, 0, 0] })],
      onBlockChanged: changed,
      pool,
    });

    client.requestFill([0], [[0, 0, 0]], [0]);
    // The shared pool's worker answers the mesh client too; a mesh result must
    // not be mistaken for the fill the fill client is waiting on.
    for (const listener of worker.messageListeners) {
      listener({
        data: {
          type: "mesh",
          id: 0,
          terrain: {
            positions: [],
            normals: [],
            uvs: [],
            brightness: [],
            indices: [],
          },
          water: {
            positions: [],
            normals: [],
            uvs: [],
            brightness: [],
            indices: [],
          },
          data: new Uint8Array(0),
          skyLight: new Uint8Array(0),
          blockLight: new Uint8Array(0),
        },
      } as MessageEvent);
    }
    expect(changed).not.toHaveBeenCalled();

    worker.deliver(0);
    expect(changed).toHaveBeenCalledWith(0);
  });
});
