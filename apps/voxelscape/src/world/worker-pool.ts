/**
 * How many world workers one pool runs at most. A small pool is enough to
 * parallelize a scroll's entering shell and a meshing burst; beyond four, more
 * threads mostly compete for the same memory bandwidth rather than adding
 * throughput.
 */
export const MAX_WORKERS = 4;

/** The most a console override may ask for, so a mistyped number cannot swamp the machine. */
const MAX_WORKER_OVERRIDE = 8;

/**
 * How many combined world workers to run: enough to fill and mesh a scroll's
 * entering shell on several threads at once, one fewer than the machine's core
 * count so the main thread always has a core of its own for the render loop.
 * A machine without a reported core count gets two.
 */
export const workerCount = (): number => {
  if (
    typeof navigator === "undefined" ||
    typeof navigator.hardwareConcurrency !== "number"
  ) {
    return 2;
  }
  return Math.max(0, Math.min(MAX_WORKERS, navigator.hardwareConcurrency - 1));
};

export interface WorldWorkerPoolParams {
  /**
   * Supplies the workers the pool runs. Defaults to `workerCount()` module
   * workers that fill and mesh; a caller that hands over one worker (or
   * nothing) gets a single worker (or the main-thread fallback) instead.
   */
  createWorker?: () => Worker | undefined;
  /** How many workers to run, instead of the automatic count. */
  count?: number;
}

/**
 * The world's worker threads, shared by the fill and mesh clients so every
 * worker can answer either kind of request and the total never exceeds the
 * machine's core count. Both clients register their message and loss handlers
 * on the same `Worker` objects, so the pool attaches them with
 * `addEventListener` rather than the single `onmessage`/`onerror` properties.
 *
 * A worker that fails — an error, or a console-driven shrink — is removed from
 * the pool and every registered loss handler is told it is gone, so the client
 * that owed it work can requeue that work elsewhere. Workers added by a
 * later resize are announced through the added handlers so the fill client can
 * hand a freshly spawned worker its terrain configuration.
 */
export class WorldWorkerPool {
  /** The live workers, failed ones removed. */
  private readonly _workers: Worker[] = [];
  private readonly messageHandlers: Array<(ev: MessageEvent) => void> = [];
  private readonly lostHandlers: Array<(worker: Worker) => void> = [];
  private readonly addedHandlers: Array<(worker: Worker) => void> = [];
  private readonly createWorker: (() => Worker | undefined) | undefined;
  /** The console-pinned size, or `undefined` for the automatic one. */
  private requestedCount: number | undefined;
  private disposed = false;

  constructor(params: WorldWorkerPoolParams = {}) {
    this.createWorker = params.createWorker;
    this.requestedCount = params.count;
    const count = params.count ?? workerCount();
    for (let i = 0; i < count; i++) {
      if (this.spawnOne() === undefined) {
        break;
      }
    }
  }

  /** The live workers, in spawn order; empty after every one of them fails. */
  get workers(): readonly Worker[] {
    return this._workers;
  }

  /** Whether any worker remains to take requests. */
  get available(): boolean {
    return this._workers.length > 0;
  }

  /**
   * Registers a handler for every message every worker posts, current workers
   * and workers spawned by a later resize alike.
   */
  onMessage(handler: (ev: MessageEvent) => void): void {
    this.messageHandlers.push(handler);
    for (const worker of this._workers) {
      worker.addEventListener("message", handler);
    }
  }

  /**
   * Registers a handler for a worker leaving the pool, whether an error killed
   * it or a resize retired it. Either way the worker will not deliver its
   * outstanding results, and the handler is the owner of that work.
   */
  onWorkerLost(handler: (worker: Worker) => void): void {
    this.lostHandlers.push(handler);
  }

  /** Registers a handler for a worker a resize added after construction. */
  onWorkerAdded(handler: (worker: Worker) => void): void {
    this.addedHandlers.push(handler);
  }

  /**
   * Pins the worker count to `count` and resizes the pool to match. Shrinking
   * retires the newest workers; their owners are told they are gone so work
   * they had in flight is requeued elsewhere before they are terminated.
   */
  setCount(count: number): void {
    this.requestedCount = Math.min(MAX_WORKER_OVERRIDE, Math.max(0, count));
    this.ensure(this.requestedCount);
  }

  /** Clears the pinned count and resizes the pool to the automatic one. */
  setAuto(): void {
    this.requestedCount = undefined;
    this.ensure(workerCount());
  }

  /** How the pool is sized and what it runs, for a console command to report. */
  describe(): string {
    const automatic = workerCount();
    const running = this._workers.length;
    const pinned = this.requestedCount;
    const sizing =
      pinned === undefined
        ? `auto (${automatic})`
        : `fixed at ${pinned} (auto: ${automatic})`;
    return `world workers: ${running} running, ${sizing}`;
  }

  /** Terminates every worker, once. Both world clients call this on dispose. */
  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    for (const worker of this._workers) {
      worker.terminate();
    }
    this._workers.length = 0;
  }

  private ensure(count: number): void {
    while (this._workers.length > count) {
      const worker = this._workers.pop();
      if (worker !== undefined) {
        worker.terminate();
        for (const handler of this.lostHandlers) {
          handler(worker);
        }
      }
    }
    while (this._workers.length < count) {
      if (this.spawnOne() === undefined) {
        break;
      }
    }
  }

  /** Spawns one worker and wires it to every registered handler. */
  private spawnOne(): Worker | undefined {
    let worker: Worker | undefined;
    try {
      worker =
        this.createWorker === undefined
          ? new Worker(new URL("./world-worker.ts", import.meta.url), {
              type: "module",
            })
          : this.createWorker();
    } catch {
      worker = undefined;
    }
    if (worker === undefined) {
      return undefined;
    }
    for (const handler of this.messageHandlers) {
      worker.addEventListener("message", handler);
    }
    worker.addEventListener("error", () => this.drop(worker));
    this._workers.push(worker);
    for (const handler of this.addedHandlers) {
      handler(worker);
    }
    return worker;
  }

  /** Removes a failed worker and tells every loss handler it is gone. */
  private drop(worker: Worker): void {
    const index = this._workers.indexOf(worker);
    if (index >= 0) {
      this._workers.splice(index, 1);
    }
    for (const handler of this.lostHandlers) {
      handler(worker);
    }
  }
}
