# Own the window's memory by slot, and lend it out

Nothing in this world says who owns a buffer, and the cost of that shows up
everywhere at once.

A fill allocates about 4458KiB and keeps 1767KiB of it. The two stores allocate
842KiB in their constructors — a `VoxelStore`'s 66³ voxels and a `LightStore`'s
two 66³ arrays — which `fill-mesh-worker.ts` overwrites with the arrays the
generator just filled, so three arrays are allocated, zeroed and dropped unread
on every fill. The mesher accumulates its six arrays as plain `number[]`, 237
thousand numbers a block at eight bytes each, and `toTyped` then copies all of
it into typed arrays at four: 1849KiB of intermediate for 925KiB of result. And
the slot the fill is for already held 842KiB of arrays exactly the same shape as
the ones replacing them.

That is 2691KiB of garbage a fill, 126MiB across an eight-second walk and 420MiB
across a sprint, all of it inside the workers where the phone is already asking
for 355 fills and landing 48.

The window's shape is what makes this avoidable. At radius 3 it is 73 slots and
never a different number: `repositionBlock` moves a slot to another cell rather
than making one, so the count follows the radius alone, and every block array is
exactly 66³ bytes whatever the terrain does. The largest thing the world holds
has a constant shape, and nothing exploits that.

The rest of the memory is a spread of unrelated policies. The superchunk
geometry pool is bounded in bytes and hands its overflow back. The merged arrays
double and never shrink. Every landed block's mesh is kept for the life of the
block, for the one case of a superchunk that must be re-joined whole. Light
keeps two bytes per voxel to hold two values of four bits. Each was a reasonable
local answer, and together they are not a strategy.

## Decision

Four rules, and one protocol that makes the second of them safe.

**A fixed count is owned by its slot and allocated once.** The window allocates
its 73 slots' voxels and light when it is built and never reallocates them. A
fill writes into the arrays the slot already has. What the window costs becomes
`slots × bytes-a-slot` — a formula, printable in a report and assertable in a
test, rather than a number that has to be measured to be known.

**Buffers are lent, never copied, and always come back.** Transferring a buffer
through `postMessage` already moves its ownership; this makes that a loop rather
than a one-way street. The fill client lends a set of three arrays with the
request, the worker fills them in place, and the result hands them back. At any
moment a block's data exists once, in one nameable place: held by a slot, or lent
to a worker.

What is lent is never the slot's own set. A transferred buffer leaves this side
detached, and a slot whose arrays were detached would answer nothing while its
fill ran — the flow controller, an edit and the picker all read a slot's voxels
between a request and its result. So the client lends a spare set, and the sets
rotate: the slot adopts what the fill filled, and what the slot was holding
becomes the next lend.

**One representation for each kind of data.** Voxels and light are `Uint8Array`,
with a voxel's skylight and blocklight in one array as two four-bit values
instead of two arrays of bytes. Geometry is typed arrays from the moment the
mesher writes its first vertex, so no conversion pass exists to have a cost.

**Pools are for sizes that vary, slots for sizes that do not, and anything grown
needs a shrink.** A block's arrays never vary, so they are slot-owned and never
pooled. A block's mesh varies with its terrain, so it is pooled against a byte
budget — the shape the geometry pool already has. A superchunk's merged arrays
grow, so they need either a shrink after a full re-join or the per-member
allocator that would replace them.

### What happens when a fill is superseded

This is the part the rules do not answer on their own, and the reason the churn
exists. Allocating fresh is lossy but safe: when the phone asked for 355 fills
and landed 48, the 307 results nobody wanted were simply garbage. Under lending,
a fill whose answer is no longer wanted still holds a slot's only copy of its
arrays, and a slot whose arrays never come back has nothing to draw ever again.

The rotation answers it without a protocol of its own. A result carries its set
home whether anybody wants its terrain or not, so the client takes the set back
on the path where it refuses the result — the generation check — exactly as it
does on the path where it adopts one. No slot is ever without arrays, because no
slot ever gave its own away.

A worker terminated mid-fill takes its lend with it. That costs one set, not one
slot: the pool is short until the next fill allocates a replacement, and the slot
it was filling still holds everything it had.

The world's total is then closed by the window and the fill drain together:

```
slots × bytes-a-slot  +  fills in flight × bytes-a-slot
73 × 842KiB + up to 16 × 842KiB  =  60MiB + up to 13MiB   (as it stands)
73 × 561KiB + up to 16 × 561KiB  =  40MiB + up to  9MiB   (with light packed)
```

Sixteen is the drain's own ceiling — `MAX_FILLS_PER_WORKER` slots for each of
`MAX_WORKERS` workers — and the spare pool is capped at the same number, so a
lend that never comes home cannot make the pool grow instead.

### The check that keeps it

One test fills and re-fills the window several times over and asserts the
resident total comes back to the formula. Every finding behind this decision came
from somebody noticing, and a strategy that is only ever noticed will drift back
into the spread of policies it replaced.

## Considered options

- **Keep allocating fresh.** It is safe against supersession by construction,
  and that safety is worth naming rather than dismissing: it cannot strand a
  slot, because nothing is lent. It costs 126MiB a walk in the workers, and it
  leaves the world's ceiling as something to be measured rather than known.
- **Pool the block arrays instead of giving them to slots.** A pool of 66³
  arrays would cut the same allocation, and it keeps the fill path's shape: ask
  for a buffer, hand it back when done. It also keeps the ceiling open — a pool
  is a policy about how much to keep, where a slot is a statement about how much
  there is — and it leaves the same supersession question to answer, so it is
  the harder half of this decision without the part that closes the formula.
- **`SharedArrayBuffer` instead of transfers.** Shared memory removes the
  ownership question entirely: a worker writes into the slot's array and nothing
  moves. The site sets no cross-origin isolation headers, so it cannot have
  shared memory as it stands, and the change would trade a stranding bug for a
  data race — a fill writing into a slot the main thread is meshing or drawing
  from. Worth revisiting only alongside those headers and a fence discipline.
- **Reclaim a lend on a timeout rather than always returning.** Fewer messages,
  and it needs no cooperation from a worker that has already moved on. It also
  means a slow fill and a lost fill look the same, and the answer to both is to
  take the arrays back from a worker that may still be writing into them.

## Consequences

- The fill request grows the three buffers it lends, transferred out; the result
  already carried the same three home, so no new message kind is needed and the
  worker's protocol keeps the two result kinds it had. What is new is that both
  paths through a result — adopting it and refusing it — hand the set back.
- `VoxelStore` and `LightStore` stop allocating in their constructors and adopt
  the arrays they are handed, which is what `applyLevelData` already does to a
  block. Nothing in the world builds a store without arrays for it.
- `buildBlockMesh` and `buildWaterMesh` write into growable typed arrays, so
  `toTyped` and the `number[] | Float32Array` unions across `MeshArrays` go, and
  `Growable` moves out of `triangle-renderer.ts` to where both sides can reach
  it.
- Light packing changes every read of a light level: the propagation loops in
  the worker and the brightness the mesher bakes per vertex. It halves the light
  a slot holds, and it is the one rule here that costs CPU to save memory.
- The per-block mesh cache is kept for now, because what makes it necessary is
  the full re-join, and retiring a departing member's index range is a separate
  decision. Under the fourth rule it has to justify itself once that lands.
- The formula is only true of the steady state. A radius change reallocates the
  window, which is the one moment the world is allowed to allocate blocks.
- This decides nothing about what a vertex carries. ADR 0033's third step stands
  on its own, and it multiplies with this rather than competing: the same rules
  apply to a 16-byte vertex.
