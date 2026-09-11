# Keep block light out of the day-night term

The terrain shader lit every surface as `albedo * lighting * brightness`, where
`brightness` was the single baked value `max(skylight, blocklight)` and `lighting`
was the day-night sun, moon, and ambient. That made emitters dim with the time of
day. A lava pool in a cave glowed at noon because the ambient term was large, but
the same pool in a room at 4am — the gasa4 demo pins `time` to 900s, deep night —
was multiplied down to near black. Block light is not sunlight, and the fire the
demo lights could not be seen to light the room for the same reason. The demo was
not at fault; the shading model was.

The `packed` vertex lane had one spare byte, left there by the smaller-vertex work
(ADR 0033). We spent it: `x` is the face, `y` the sky light, `z` the tile, and `w`
the block light. `SlicePlane`/`MergedRectangle` carry both channels and only merge
faces that are flat in both. The terrain fragment now shades
`max(lighting * sky, block)`: during the day the sun term dominates and the picture
is what it was, while at night block light wins outright. Water, which never took
the day-night term, reads `max(sky, block)` and is unchanged.

## Considered options

- **Raise the night ambient until emitters are visible.** Rejected: it brightens
  everything, not only what a torch reaches, and washes out the dark 4am look the
  demo exists for.
- **Floor `lighting` on block-lit vertices.** Rejected: once the channels are
  merged into one byte the shader cannot tell which vertices those are.
- **Add block light in a separate emissive pass or texture.** Rejected: it needs
  another attribute or draw, and the spare lane was already waiting for exactly
  this.

## Consequences

- `faceBrightness` returns both channels, the mesher writes both lanes, and
  `pushPacked` takes a block brightness beside the sky one.
- The merged-rectangle key includes block light, so two faces alike in sky but
  different in block no longer merge — a small geometry cost only where emitters
  actually reach.
- Sky light remains the channel the day-night term scales; block light is the
  emitters' own and is the same at every hour.
