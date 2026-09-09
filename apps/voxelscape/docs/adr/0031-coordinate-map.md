# Integer-coordinate edit overlay key

`EditLayer` (`src/world/edit-layer.ts`) stores its sparse edit overlay in a
`Map` keyed by a `"x,y,z"` string so it can be looked up by absolute world
voxel and re-applied to any block after a ring refill. At 34,000 edits that
key choice became the dominant cost: every `queryRange`/`snapshot` pass had to
`split(",")` and `Number()` each of the 34,000 string keys, and `reapplyEdits`
runs one such full scan per block (125 blocks in the default window), so a
sync merge or a startup load blocked the main thread for ~3 seconds.

## Decision

`EditLayer` is now backed by `CoordinateMap<V>` (`src/world/coordinate-map.ts`),
an open-addressed hash table whose keys live in flat typed arrays: x, y and z
in three `Int32Array` slots per entry, the value in a parallel array, and a
`Uint8Array` bitset marking occupied slots. A lookup takes three integers and
never builds a key, and iteration reads the coordinates straight out of the
typed arrays instead of parsing them back out of a string. `get`, `set`,
`queryRange`, `snapshot`, and `mergeIntoLayer` keep the same signatures, so
the ring, persistence, and atproto sync call them unchanged.

The `reapplyEdits` scan at 34,000 edits fell from ~3.1 s to ~70 ms (a 45×
speedup); the isolated `Map.get`/`merge` paths improved similarly. The scan's
cost is now bounded by the per-block iteration work itself rather than by key
decoding, so the same fix absorbs further growth in edit count.

## Considered options

- **Keep the string-keyed `Map`.** Measured as the bottleneck across every
  path — build, scan, snapshot, merge. Rejected.
- **Pack the three coordinates into one `Map<number>` key.** A JS number holds
  53 integer bits exactly, so three signed axes can only afford ~17 bits each
  (±65,536 voxels) before distinct coordinates collide. Voxel coordinates grow
  without bound as a player walks an infinite world, so a range guard would
  silently corrupt far-flung edits. The three-`Int32Array` table sidesteps the
  packing entirely: each axis keeps its own full signed 32-bit range and the
  hash still folds all three.
- **Keep a `Map` but stop re-parsing keys on iteration.** Eliminates the key
  parse in `queryRange`/`snapshot` but keeps string construction on every
  `get`/`set`; the coordinate map removes both and is a single, uniform
  storage shape.
- **Spatial index (bucket edits by 32³ chunk, or index per surrounding
  block).** Would turn the per-block scan from O(all edits) into O(edits in
  range), which matters at very large counts; it relies on the per-block full
  scan still being the cost, which the 45× fix already reduced below the
  frame budget. Deferred until the profile says the scan is the bottleneck
  again.

## Consequences

- `EditLayer` iteration order is hash-slot order, not insertion order. Nothing
  downstream depended on insertion order (the atproto chunker groups by
  coordinate; persistence and merge are position-independent), so only one
  test's expectation needed relaxing.
- The memory shape is three arrays scaled to a power-of-two slot count, so a
  34,000-edit overlay rests in a 65,536-slot table: 768 KB of `Int32Array`
  keys, ~512 KB of value references, and 64 KB of occupancy — a few MB where
  the string-keyed map leaned on the engine's per-string allocation instead.
- The fix removes the algorithm's string work but not its full-scan shape:
  `reapplyEdits` still reads every edit once per block. If edit counts grow
  past what a per-frame scan tolerates, the spatial index considered above is
  the next step rather than another key change.
