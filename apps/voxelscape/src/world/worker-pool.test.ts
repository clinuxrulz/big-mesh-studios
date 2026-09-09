// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { WorldWorkerPool, workerCount } from "./worker-pool";

/**
 * A worker the pool can drive without threads: it records what it is handed,
 * lets tests fire its message and error events, and remembers whether it was
 * terminated. Speaks `addEventListener`/`removeEventListener`, which is the
 * interface a shared pool relies on instead of the `onmessage`/`onerror`
 * properties.
 */
class FakeWorker {
  readonly messageListeners: Array<(ev: MessageEvent) => void> = [];
  readonly errorListeners: Array<(ev: MessageEvent) => void> = [];
  readonly posted: unknown[] = [];
  terminated = false;

  addEventListener(
    type: "message" | "error",
    listener: (ev: MessageEvent) => void,
  ): void {
    (type === "message" ? this.messageListeners : this.errorListeners).push(
      listener,
    );
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

  postMessage(message: unknown): void {
    this.posted.push(message);
  }

  terminate(): void {
    this.terminated = true;
  }

  /** Delivers a message as this worker would. */
  fireMessage(data: unknown): void {
    for (const listener of this.messageListeners) {
      listener({ data } as MessageEvent);
    }
  }

  /** Fires this worker's error event, as a crash would. */
  fireError(): void {
    for (const listener of this.errorListeners) {
      listener({} as MessageEvent);
    }
  }
}

/** A factory that hands out distinct fakes in creation order. */
const makeFactory = (created: FakeWorker[]) => {
  return () => {
    const worker = new FakeWorker();
    created.push(worker);
    return worker as unknown as Worker;
  };
};

describe("WorldWorkerPool", () => {
  it("spawns one worker per configured count, in creation order", () => {
    const created: FakeWorker[] = [];
    const pool = new WorldWorkerPool({
      createWorker: makeFactory(created),
      count: 3,
    });
    expect(pool.workers).toHaveLength(3);
    expect(created).toHaveLength(3);
    expect(pool.available).toBe(true);
  });

  it("runs the automatic core-based count when none is given", () => {
    const created: FakeWorker[] = [];
    const pool = new WorldWorkerPool({ createWorker: makeFactory(created) });
    expect(pool.workers).toHaveLength(workerCount());
    expect(created).toHaveLength(workerCount());
  });

  it("routes every worker's messages to each registered handler", () => {
    const created: FakeWorker[] = [];
    const pool = new WorldWorkerPool({
      createWorker: makeFactory(created),
      count: 2,
    });
    const onMessage = vi.fn();
    pool.onMessage(onMessage);

    created[0].fireMessage("a");
    created[1].fireMessage("b");

    expect(onMessage).toHaveBeenCalledTimes(2);
    expect(onMessage.mock.calls[0][0].data).toBe("a");
    expect(onMessage.mock.calls[1][0].data).toBe("b");
  });

  it("drops a failed worker and tells every loss handler it is gone", () => {
    const first = new FakeWorker();
    const second = new FakeWorker();
    let spawned = 0;
    const pool = new WorldWorkerPool({
      createWorker: () =>
        (spawned++ === 0 ? first : second) as unknown as Worker,
      count: 2,
    });
    const lost = vi.fn();
    pool.onWorkerLost(lost);

    first.fireError();

    expect(pool.workers).toEqual([second]);
    expect(pool.available).toBe(true);
    expect(lost).toHaveBeenCalledWith(first);
  });

  it("retires the newest workers when shrunk and announces the ones a later grow adds", () => {
    const first = new FakeWorker();
    const second = new FakeWorker();
    const third = new FakeWorker();
    const made = [first, second, third];
    let spawned = 0;
    const pool = new WorldWorkerPool({
      createWorker: () => made[spawned++] as unknown as Worker,
      count: 3,
    });
    const lost = vi.fn();
    const added = vi.fn();
    pool.onWorkerLost(lost);
    pool.onWorkerAdded(added);

    pool.setCount(1);
    expect(pool.workers).toEqual([first]);
    expect(lost).toHaveBeenCalledTimes(2);
    expect(lost.mock.calls.map((call) => call[0])).toEqual([third, second]);
    expect(added).not.toHaveBeenCalled();

    const fourth = new FakeWorker();
    const fifth = new FakeWorker();
    made.push(fourth, fifth);
    pool.setCount(3);
    expect(pool.workers).toEqual([first, fourth, fifth]);
    expect(added).toHaveBeenCalledTimes(2);
  });

  it("keeps registered handlers attached to the workers a resize spawns later", () => {
    const created: FakeWorker[] = [];
    const pool = new WorldWorkerPool({
      createWorker: makeFactory(created),
      count: 1,
    });
    const onMessage = vi.fn();
    pool.onMessage(onMessage);

    pool.setCount(0);
    pool.setCount(1);

    const newcomer = created[1];
    newcomer.fireMessage("late");
    expect(onMessage).toHaveBeenCalledTimes(1);
  });

  it("returns to the automatic count when the size pin is cleared", () => {
    const created: FakeWorker[] = [];
    const pool = new WorldWorkerPool({
      createWorker: makeFactory(created),
      count: 2,
    });

    pool.setCount(0);
    expect(pool.workers).toHaveLength(0);
    expect(pool.available).toBe(false);

    pool.setAuto();
    expect(pool.workers).toHaveLength(workerCount());
  });

  it("terminates every worker on dispose, once, and tolerates a second dispose", () => {
    const created: FakeWorker[] = [];
    const pool = new WorldWorkerPool({
      createWorker: makeFactory(created),
      count: 2,
    });

    pool.dispose();
    expect(created.every((worker) => worker.terminated)).toBe(true);
    expect(pool.workers).toHaveLength(0);

    pool.dispose();
    expect(created.every((worker) => worker.terminated)).toBe(true);
  });
});
