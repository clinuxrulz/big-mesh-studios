# Shrink what every vertex carries

A benchmark of all five scenarios at radius 3 put the frame's remaining cost
in the geometry the world moves rather than in the work it does. The main
thread's median frame is 0.9–1.7 milliseconds of a sixtieth of a second, and
what goes over budget is merging and uploading: of the twenty-one frames that
cost more than a sixtieth of a second across the four moving scenarios,
eighteen held a superchunk merge. The graphics card is now the larger half of
the frame — 6.15 milliseconds sprinting against 1.19 turning, at the same
triangle count — and drawing the same scene at a quarter of the pixels moved
sprinting by 13%, so what the card is spending its time on is not shading.
It is moving geometry: a walk sends 37.7MB to the card, a sprint 117.8MB, and
the graphics allocator grows from 101MB to 147MB over one eight-second walk.

A vertex is 48 bytes: position and normal at twelve each, texture coordinates
at eight, brightness at four, and the occlusion probe's colour at twelve. That
last one is the slot's packed id, and it is identical on every vertex of a
chunk — ADR 0025 gave each slot its own probe mesh drawing its own range, so
the id is already constant for the whole draw call.

## Decision

Carry less on every vertex, in three steps, largest saving for the least
disturbance first.

**The probe's slot id becomes a uniform.** The probe and debug materials read
a `slotColor` material uniform instead of an `occlusionColor` attribute, and
each probe mesh sets it from its slot before it draws. The renderer packs a
material's uniforms per object, immediately after `onBeforeRender`, so one
shared material still serves every probe mesh and the probe scene still
compiles the two programs ADR 0025 established. Twelve of forty-eight bytes
leave the format, and the colour stamp leaves `appendArrays` with them.

**Then the mesher merges coplanar faces.** `buildBlockMesh` emits one quad per
exposed face. Terrain is mostly long flat runs of one material, which is the
case a greedy mesher exists for, and fewer vertices is the only saving that
reaches all four costs at once: bytes uploaded, geometry held, the merge on
the main thread, and the triangles the card draws.

**Then the remaining attributes are packed.** Position becomes three 16-bit
lattice coordinates against a per-superchunk offset, the normal three bits (a
voxel face has six), texture coordinates derive from the face, and brightness
becomes a byte — about twelve bytes where there were forty-eight.

## Considered options

- **Attack the merge path first** — bind the upload budget on the first
  candidate too, or retire a departing member's index range instead of
  re-joining the superchunk whole. Both are worth doing and neither is
  discarded, but they change _when_ bytes move; this changes how many there
  are, which makes those changes smaller.
- **Sixteen-bit indices.** They do not fit: roughly 600,000 triangles across
  ten drawn superchunks puts each well past 65,535 vertices.
- **Shrink the voxels instead.** The world holds 60MB of voxels and light
  against 160–188MB of geometry, and the voxels are already `Uint8Array`.
  There is nothing there to win. _(This stopped being true once the third
  step landed: geometry fell far enough that voxels and light became the
  larger half, and ADR 0036 takes the win this said was not there.)_
- **Drop the probe attribute by giving each slot its own material.** That
  would compile a program per chunk, which is what ADR 0025 went out of its
  way to avoid.

## Consequences

- The probe pass no longer works from geometry alone: a probe mesh drawn
  without its `onBeforeRender` writes whatever slot drew last. The colour is
  seated with the mesh, so anything drawing the occlusion scene by hand has
  to seat it too.
- `VERTEX_UPLOAD_BYTES` falls from 48 to 36, so the upload budget a frame is
  paced against now buys a third more geometry for the same bytes. All three
  steps are taken now, and it stands at 20: the budget buys well over twice
  what it did.
- `MergedArrays` loses its `colors` array, and with it the per-vertex stamp
  every whole rebuild paid for.
- The second and third steps change the mesher's output format, which the
  world workers produce and every material consumes; both are behind this
  decision.

## What the third step actually cost

A vertex is 20 bytes rather than the dozen this forecast, for two reasons this
did not know about.

Position stayed three 32-bit floats. Sixteen-bit lattice coordinates against a
per-superchunk offset are still possible, and would take a vertex to 14, but
they were not needed to get most of the win and they are the one part that
changes what a position means rather than how it is written down.

The rest could not be bit-packed as freely as this imagined, because a buffer
carrying one attribute has to have a stride that is a multiple of four. A
three-bit normal cannot take a buffer of its own, and neither can a one-byte
tile or a one-byte light. What they do instead is share the four lanes of one
`unorm8x4`: a face index, the baked light, the tile, and a byte still spare.
Texture coordinates are two half floats rather than derived from the face,
because a merged quad's coordinates count cells and no longer follow from
which way the face points.

So the shape of the saving is the same and its size is two thirds of the
forecast, with the last six bytes reachable by shrinking position later.
