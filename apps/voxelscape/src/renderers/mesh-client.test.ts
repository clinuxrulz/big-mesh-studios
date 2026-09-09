// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { MeshClient } from "./mesh-client";
import { WorldWorkerPool } from "../world/worker-pool";
import { buildBlockShell, type WorldBlock } from "../world/level-data";
import { VOXEL_GRASS } from "../world/voxel-store";
import type { VoxelTileConfig } from "./atlas";
import type { BlockMeshes, MeshBuildRequest, MeshBuildResult } from "./mesh";

const EMPTY_MESHES: BlockMeshes = {
  terrain: {
    positions: [],
    normals: [],
    uvs: [],
    rects: [],
    brightness: [],
    indices: [],
  },
  water: {
    positions: [],
    normals: [],
    uvs: [],
    rects: [],
    brightness: [],
    indices: [],
  },
};

/**
 * A worker that records what it is sent and hands results back only when told
 * to, so a result can be made to arrive after the block it was built from has
 * already changed. Speaks the pool's listener interface (`addEventListener`)
 * rather than the `onmessage`/`onerror` properties, because a `WorldWorkerPool`
 * shares its workers between the fill and mesh clients.
 */
class FakeMeshWorker {
  readonly sent: MeshBuildRequest[] = [];
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

  postMessage(request: MeshBuildRequest): void {
    this.sent.push(request);
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
    const result: MeshBuildResult = {
      type: "mesh",
      id: request.id,
      terrain: {
        positions: [],
        normals: [],
        uvs: [],
        rects: [],
        brightness: [],
        indices: [],
      },
      water: {
        positions: [],
        normals: [],
        uvs: [],
        rects: [],
        brightness: [],
        indices: [],
      },
      // A real worker transfers the input buffers it read back for reuse, so
      // the fake does the same.
      data: request.data,
      skyLight: request.skyLight,
      blockLight: request.blockLight,
    };
    for (const listener of this.messageListeners) {
      listener({ data: result } as MessageEvent);
    }
  }
}

const setup = (
  blockCount: number,
  options: { worker?: FakeMeshWorker | undefined } = {},
) => {
  const blocks: WorldBlock[] = [];
  for (let i = 0; i < blockCount; i++) {
    const block = buildBlockShell({ center: [i * 192, 0, 0] });
    // These tests exercise the message protocol, not what is worth meshing,
    // so put a voxel in each shell to keep it on the worker path.
    block.store.set(0, 0, 0, VOXEL_GRASS);
    blocks.push(block);
  }
  const built: number[] = [];
  const worker = "worker" in options ? options.worker : new FakeMeshWorker();
  const client = new MeshClient({
    blocks,
    onMeshBuilt: (index) => built.push(index),
    createWorker: () => worker as unknown as Worker | undefined,
  });
  return { client, built, worker };
};

describe("MeshClient", () => {
  it("hands queued blocks to the worker and reports what comes back", () => {
    const { client, built, worker } = setup(3);
    client.requestBuild(1);
    expect(built).toEqual([]); // queued, not built yet

    client.drain();
    expect(worker?.sent.map((r) => r.id)).toEqual([1]);
    expect(built).toEqual([]); // sent, still not back

    worker?.deliver(0);
    expect(built).toEqual([1]);
  });

  // The reason every block carries a generation counter: a build reads a copy
  // of the block's voxel data, and by the time it finishes that slot may hold
  // different terrain entirely.
  it("drops a result for data that changed after the request went out", () => {
    const { client, built, worker } = setup(3);
    client.requestBuild(1);
    client.drain();

    client.requestBuild(1); // the block's data changed while the build ran
    worker?.deliver(0);

    expect(built).toEqual([]);
  });

  it("drops a result for a slot invalidated after the request went out", () => {
    const { client, built, worker } = setup(3);
    client.requestBuild(1);
    client.drain();

    // The ring moved this slot elsewhere; nothing is queued, but what is in
    // flight was built for terrain that is no longer there.
    client.invalidate(1);
    worker?.deliver(0);

    expect(built).toEqual([]);
  });

  it("marks a slot stale without queueing it", () => {
    const { client, worker } = setup(3);
    client.invalidate(1);
    client.drain();
    expect(worker?.sent).toEqual([]);
  });

  it("hands over no more than the drain's share at a time", () => {
    const { client, worker } = setup(20);
    for (let index = 0; index < 20; index++) {
      client.requestBuild(index);
    }

    client.drain();
    expect(worker?.sent).toHaveLength(12);
    client.drain();
    expect(worker?.sent).toHaveLength(20);
  });

  it("does not send a second build for a block still in flight", () => {
    const { client, worker } = setup(3);
    client.requestBuild(1);
    client.drain();
    client.requestBuild(1);
    client.drain();

    expect(worker?.sent.map((r) => r.id)).toEqual([1]);
  });

  it("recycles the snapshot buffers the worker returns instead of allocating", () => {
    const { client, worker } = setup(2);
    client.requestBuild(0);
    client.drain();
    const first = worker?.sent[0];
    worker?.deliver(0); // returns the buffers to the pool

    // A second build on another block draws the same buffers back out, so the
    // two sends share the very same underlying ArrayBuffer.
    client.requestBuild(1);
    client.drain();
    const second = worker?.sent[1];

    expect(second?.data.buffer).toBe(first?.data.buffer);
    expect(second?.skyLight.buffer).toBe(first?.skyLight.buffer);
    expect(second?.blockLight.buffer).toBe(first?.blockLight.buffer);
  });

  it("builds on the calling thread when there is no worker", () => {
    const { client, built } = setup(3, { worker: undefined });
    client.requestBuild(1);
    expect(built).toEqual([]);

    client.drain();
    expect(built).toEqual([1]);
  });

  it("falls back to the calling thread once the worker errors, keeping what was in flight", () => {
    const { client, built, worker } = setup(3);
    client.requestBuild(1);
    client.drain();
    expect(built).toEqual([]);

    worker?.error();
    // The build that was in flight is owed and nothing will deliver it, so it
    // goes back on the queue for this thread to build.
    client.drain();
    expect(built).toEqual([1]);
  });

  it("builds one block before returning, without waiting for a drain", () => {
    const { client, built, worker } = setup(3);
    client.buildNow(2);
    expect(built).toEqual([2]);
    expect(worker?.sent).toEqual([]);
  });

  it("takes a block built directly off the queue", () => {
    const { client, built, worker } = setup(3);
    client.requestBuild(2);
    client.buildNow(2);
    client.drain();

    expect(built).toEqual([2]); // built once, not again by the drain
    expect(worker?.sent).toEqual([]);
  });

  it("queues every block when the tiles change", () => {
    const { client, worker } = setup(4);
    client.setTiles([]);
    client.drain();
    expect(worker?.sent.map((r) => r.id)).toEqual([0, 1, 2, 3]);
  });

  it("adopts a mesh built alongside a fill without queueing a rebuild", () => {
    const { client, built, worker } = setup(3);
    client.requestBuild(1); // e.g. queued by a reposition
    client.acceptMesh(1, EMPTY_MESHES);

    expect(built).toEqual([1]);
    // The queued rebuild was already met by the adopted geometry.
    client.drain();
    expect(worker?.sent).toEqual([]);
  });

  it("drops a build still in flight when a fill's mesh is adopted for the slot", () => {
    const { client, built, worker } = setup(3);
    client.requestBuild(1);
    client.drain();

    // The block's fill landed with its geometry before the older build
    // returned; the in-flight result was built from superseded data.
    client.acceptMesh(1, EMPTY_MESHES);
    worker?.deliver(0);

    expect(built).toEqual([1]);
  });

  it("reports the tile rects it was last given", () => {
    const { client } = setup(2);
    const rect: VoxelTileConfig = {
      id: 1,
      top: [0, 0, 4, 4],
      side: [0, 4, 4, 4],
      bottom: [0, 8, 4, 4],
    };
    client.setTiles([rect]);
    expect(client.tileRects).toEqual([rect]);
  });

  it("reports an empty mesh for a chunk whose level holds no surface, without touching a worker", () => {
    // A shell block whose broad grid stays all-zero holds no surface voxels.
    const blocks = [buildBlockShell({ center: [0, 0, 0] })];
    const built: number[] = [];
    const worker = new FakeMeshWorker();
    const client = new MeshClient({
      blocks,
      onMeshBuilt: (index) => built.push(index),
      createWorker: () => worker as unknown as Worker | undefined,
    });
    client.requestBuild(0);
    client.drain();
    expect(worker?.sent).toEqual([]);
    expect(built).toEqual([0]);
  });

  it("terminates the worker when disposed", () => {
    const { client, worker } = setup(2);
    client.dispose();
    expect(worker?.terminated).toBe(true);
  });

  it("warns once when the worker errors", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { worker } = setup(2);
    worker?.error();
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });

  it("splits the drain across a shared pool's workers, round-robin", () => {
    const first = new FakeMeshWorker();
    const second = new FakeMeshWorker();
    let spawned = 0;
    const pool = new WorldWorkerPool({
      createWorker: () => {
        spawned++;
        return (spawned === 1 ? first : second) as unknown as Worker;
      },
      count: 2,
    });
    const blocks: WorldBlock[] = [];
    for (let i = 0; i < 4; i++) {
      const block = buildBlockShell({ center: [i * 192, 0, 0] });
      block.store.set(0, 0, 0, VOXEL_GRASS);
      blocks.push(block);
    }
    const client = new MeshClient({
      blocks,
      onMeshBuilt: () => {},
      pool,
    });
    for (let index = 0; index < 4; index++) {
      client.requestBuild(index);
    }

    client.drain();

    expect(first.sent.map((r) => r.id)).toEqual([0, 2]);
    expect(second.sent.map((r) => r.id)).toEqual([1, 3]);
    client.dispose();
  });

  it("ignores a fill result posted on the same shared pool", () => {
    const worker = new FakeMeshWorker();
    const pool = new WorldWorkerPool({
      createWorker: () => worker as unknown as Worker,
      count: 1,
    });
    const blocks = [buildBlockShell({ center: [0, 0, 0] })];
    blocks[0].store.set(0, 0, 0, VOXEL_GRASS);
    const built: number[] = [];
    const client = new MeshClient({
      blocks,
      onMeshBuilt: (index) => built.push(index),
      pool,
    });
    client.requestBuild(0);
    client.drain();

    // The shared pool's worker answers the fill client too; a fill result must
    // not be mistaken for the build the mesh client is waiting on.
    for (const listener of worker.messageListeners) {
      listener({
        data: {
          type: "fill",
          indices: [0],
          gens: [1],
          lods: [0],
          storeData: [new Uint8Array(0)],
          mightHaveVoxels: [false],
          hasWater: [false],
          skyLight: [new Uint8Array(0)],
          blockLight: [new Uint8Array(0)],
        },
      } as MessageEvent);
    }
    expect(built).toEqual([]);

    worker.deliver(0);
    expect(built).toEqual([0]);
  });
});
