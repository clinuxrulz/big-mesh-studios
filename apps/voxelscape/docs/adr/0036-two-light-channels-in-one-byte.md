# Hold both light channels in one byte a voxel

Every block carries three arrays the same length: its voxels, its sky light and
its block light. At a window radius of four that is 23.9 mebibytes each, 71.6
between them, and it is now the largest thing the world holds in main memory.

It was not the largest until recently. ADR 0033 turned each vertex from 48
bytes into 20, and geometry at rest fell from roughly three times the voxels to
about half of them. That ADR considered shrinking the voxels instead and set it
aside — "the voxels are already `Uint8Array`, there is nothing there to win" —
which was true of the balance it measured and stopped being true the moment it
succeeded.

A light level is 0 to 15. That is four bits in a byte, and the other four hold
nothing.

## Decision

The two channels share one byte a voxel: sky light in the low four bits, block
light in the high four. `LightStore` holds one `data` array instead of two, and
reads and writes a level through `skylightAt`, `blocklightAt`, `setSkylightAt`
and `setBlocklightAt`. Nothing outside `light-store.ts` knows which four bits
are which; a caller handed a channel by name asks `shiftOfChannel` where it
sits, which is what the propagation does once before its loop.

Nothing is lost. Every level that fit before fits now, so this is the same light
in half the space rather than coarser light.

## Considered options

- **Shrink the voxels instead.** There are 25 voxel ids, which is five bits, so
  three bits a voxel are idle. But unpacking them is not free the way this is:
  the light channels are separate arrays that become one, where voxel ids are
  one array that would have to become a bit field, and every read of a voxel —
  the mesher's sweeps, the physics, the fluid simulation — pays for it. Light is
  read in two places.
- **Drop block light to a lower resolution.** Fewer levels would free bits for
  something, but there is nothing to spend them on and the banding would show.
- **Hold the light for a block only while it is being meshed.** The window
  keeps light because a block is re-meshed whenever an edit or a fluid moves
  near it, and regenerating light for a block costs a full flood fill. Trading
  memory for that is the wrong way round on a machine that has memory.

## Consequences

- A window at radius four holds 47.7 mebibytes of voxels and light where it
  held 71.6.
- Every block moves one array between the main thread and its worker instead of
  two, and the workers' spare-array pools hold one set of two rather than one
  set of three — so the saving is larger than the window's own arrays.
- The propagation reads and writes a level through a shift and a mask rather
  than indexing a byte directly. It is the same number of memory touches; the
  arithmetic around them is a shift, an and, and an or.
- `fillBlockLight` cannot clear its channel with `fill(0)` any more, because
  that would take the sky light beside it. `clearBlocklight` masks instead.
- The two channels can no longer be handed about separately. Anything that
  wanted one of them alone — a debug view, a partial upload — now takes the
  byte and masks it.
