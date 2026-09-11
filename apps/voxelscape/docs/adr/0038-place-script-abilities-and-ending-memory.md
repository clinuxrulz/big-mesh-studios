# Place scripts can scale movement, set off blasts, and remember endings

Three more things a place's rules needed that the effect vocabulary did not
carry. A game about getting somewhere on time changes how the player moves: a
sleepy stumble, a speed boost, a jump the player did not have before. A story
with a bomb, a burning building, or a monkey takeover needs a blast the script
can set off. And a game built around collecting endings cannot hold that
collection in the script, because a restart builds the interpreter fresh.

## Movement is scaled, not set

`player-speed` and `player-jump` each carry a multiplier applied to the
player's default move speed and jump speed, not an absolute value. A script
that doubles the walk speed and later restores it multiplies by two and then by
one; it never needs to know the world's own number, which `/player:speed`
already lets the player change. A multiplier below one is how a script makes the
player crawl, and one above one is how it makes them sprint. Both are bounded
above so a hostile script cannot fling the player across the world.

The effect names one player and is delivered to that player's own client, the
same voice tier the placement and facing effects use. The trusted side writes
the number onto that avatar's `config`; the owning objects stay ignorant that a
console or a script exists.

## An explosion is a world effect like a fire

`explosion` names a point and a radius, and the host records it and reports it
through the same callback shape a scripted fire uses. It is scenery the script
lights rather than a player edit, so it is neither persisted nor synced, and a
restart clears it. The renderer draws each blast as a short radial particle
burst and drops it when the burst ends; the host keeps each record only long
enough for a renderer to notice it.

The blast damages nothing on its own. What an explosion means to a game — a
death, a chase, an ending — stays in the script's rules, where it is a fact the
same as any other, rather than being a second source of damage beside the
monsters' and the sword's.

## The ending collection lives beside the script, not in it

A restart builds a fresh interpreter, so nothing the script held survives it.
The collection a game gates on is therefore kept outside the script, in the
page's own storage, keyed by the place's seed and entry file so two places never
share one. The host reads it back into the interpreter as `engine.endings()`,
and the trusted side records each ending title as the script reaches it.

This is local, per-client state, like `/player:speed`: it is not replicated, and
two peers of the same place do not agree on it. That is the right shape for it,
because the ending a script reports is already the voice tier — a thing shown to
one player — and a place's game is a single player's progress, not a shared
world fact.

## Considered options

- **Give the player an absolute speed instead of a multiplier.** Rejected: it
  makes the script duplicate the world's default, and a script and
  `/player:speed` would then overwrite each other rather than compose.
- **Make an explosion damage everything in its radius.** Rejected: damage is
  already split between the monsters' attacks and the sword, and a third source
  would have to reconcile with both; a game that wants the blast to kill the
  player can say so with its own rules.
- **Persist the ending collection on the shared edit layer or an atproto
  record.** Rejected: it would make one player's collection a world fact every
  peer converges on, and a restart would then have to replay it as replicated
  state rather than simply reading the local page's storage.
- **Keep the collection in the script and never restart.** Rejected: the world
  already restarts a place by building a fresh interpreter, and changing that to
  preserve script state would leak one run's NPCs and dialogs into the next.

## Consequences

- `player-speed`, `player-jump`, and `explosion` join the effect vocabulary, so
  the effect validator bounds each like every other tag.
- `engine.endings()` joins the interpreter's host surface, returning a JSON
  array of the titles the place has reached.
- The world's storage is read once when a place boots and written as endings
  arrive; a page whose storage is absent or full still plays, and simply forgets
  between runs.
