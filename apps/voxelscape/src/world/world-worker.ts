// Web worker that both generates a block's procedural voxel data (fill) and
// builds its surface triangle mesh, so one thread answers the world's two
// heavy per-block jobs instead of them splitting across two pools. The main
// thread sends a fill configuration once, then `fill` requests carrying the
// centres of the blocks it wants and `mesh` requests carrying a block's voxel
// data. Each block of a fill is posted back on its own as it is generated;
// each mesh is posted back as one result. Every result carries its kind on a
// `type` field, so the fill and mesh clients sharing this worker can tell
// their own answers apart.
import {
  fillResultTransfers,
  handleFillMessage,
  type FillBatchResult,
  type FillConfig,
  type FillWorkerMessage,
} from "./fill-worker";
import type { MeshBuildResult, MeshBuildRequest } from "../renderers/mesh";
import {
  handleMeshMessage,
  meshResultTransfers,
} from "../renderers/mesh-worker";

/** Every message a world worker accepts, each identified by its `type`. */
export type WorldWorkerMessage = FillWorkerMessage | MeshBuildRequest;

/** What handling one message produces: a stored config, fill results, a mesh, or nothing. */
export type WorldWorkerOutput = {
  config?: FillConfig;
  results?: AsyncGenerator<FillBatchResult>;
  mesh?: { result: MeshBuildResult; transfers: Transferable[] };
};

/**
 * Pure message handler: returns the config to store for a `config` message, a
 * result per block for a `fill` message, a single result for a `mesh` message,
 * or neither for anything else (an unknown message, or a `fill` message
 * received before a configuration).
 */
export const handleWorldMessage = (
  msg: WorldWorkerMessage,
  config: FillConfig | undefined,
): WorldWorkerOutput => {
  if (msg.type === "config" || msg.type === "fill") {
    return handleFillMessage(msg, config);
  }
  if (msg.type === "mesh") {
    const result = handleMeshMessage(msg);
    return { mesh: { result, transfers: meshResultTransfers(result) } };
  }
  return {};
};

/**
 * The TypeScript DOM types define `self` as `Window`, whose `postMessage`
 * needs a target origin; in a dedicated worker the global is a
 * `DedicatedWorkerGlobalScope`. Guarded so importing this module in Node.js
 * (for the protocol tests) doesn't evaluate `self`.
 */
const workerSelf =
  typeof self !== "undefined"
    ? (self as unknown as {
        onmessage: ((ev: MessageEvent) => void) | null;
        postMessage: (
          message: FillBatchResult | MeshBuildResult,
          transfer: Transferable[],
        ) => void;
      })
    : undefined;

let config: FillConfig | undefined;

if (workerSelf !== undefined) {
  workerSelf.onmessage = async (ev) => {
    const msg = ev.data as WorldWorkerMessage;
    const out = handleWorldMessage(msg, config);
    if (out.config !== undefined) {
      config = out.config;
      return;
    }
    for await (const result of out.results ?? []) {
      workerSelf.postMessage(result, fillResultTransfers(result));
    }
    if (out.mesh !== undefined) {
      workerSelf.postMessage(out.mesh.result, out.mesh.transfers);
    }
  };
}
