# Pool one set of workers for fills and meshes

The world's two heavy per-block jobs each ran their workers on their own:
`FillClient` spawned a pool of fill workers and `MeshClient` spawned a pool of
mesh workers, each sized by `navigator.hardwareConcurrency`. Both pools chose
the same default, so a machine with N cores could boot up to 2·(N−1) world
threads — enough that filling and meshing a scroll's entering shell competed
with each other for the same memory bandwidth twice over, and expensive enough
on small devices that neither job ever actually used its full slice.

## Decision

One `WorldWorkerPool` (`src/world/worker-pool.ts`) owns every world worker
thread, and `createVoxelWorld` constructs exactly one pool
(`hardwareConcurrency − 1` combined workers, capped at four, falling back to
two) and hands it to both clients. Each of those workers runs the combined
`world-worker.ts` module, which answers either kind of message: a `fill`
request yields one result per block, a `mesh` request builds one block's
terrain and water surfaces. Every result carries its kind on a `type` field,
so the two clients sharing one set of `Worker` objects can tell their own
answers apart — the pool attaches them with `addEventListener` rather than the
`onmessage`/`onerror` properties, because two owners cannot each claim those
single slots.

`dispose` is idempotent, so both owners calling it during teardown (the world
disposes the sphere's fill client and the renderer's mesh client in either
order) terminate each worker exactly once. A client built without a shared
pool still gets a private pool of one worker through its `createWorker` knob,
which is what the unit tests exercise — so the construction path is exercised
both ways.

The pool also owns pool-level policy that had nowhere to live before:

- **Resize.** `setCount(n)` pins the pool and retires the newest workers,
  notifying every registered loss handler so a client that owed them work
  requeues it elsewhere; `setAuto()` clears the pin. `setCount(0)` is the
  destroy-all setting that forces every client onto its main-thread fallback,
  which is how a `/world:workers 0` console command was added by reuse.
- **Added workers.** A worker spawned by a later grow-the-pool is announced
  through `onWorkerAdded`, so `FillClient` can hand it its terrain
  configuration without new wiring.
- **Loss.** A worker that errors is dropped and its owners are told, the same
  edge a `MeshClient` that owned its workers had to improvise.

## Considered options

- **Keep two pools, halve each.** The interplay (fill workers idle while mesh
  workers starve and vice versa) is the problem; two smaller pools still split
  the threads. One pool with round-robin entry is simpler and adapts to
  however the load is split at the moment.
- **Shared pool behind a scheduler.** A shared queue with priorities adds a
  third moving part for no measured gain; the callers already drain by bounded
  batches and drop stale results by generation, so the pool stays a dumb
  carrier of threads.
- **One worker, ever.** A single combined worker would be enough for the
  steady-state load and spare the pool complexity entirely, but a scroll's
  entering shell is genuinely parallel work (ADR 0016, 0021) and the console
  override needs somewhere to land.
