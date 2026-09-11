# Place scripts can set timers and move the local player

A place's rules need two things the effect vocabulary did not carry. A game
about a late-night snack has consequences that arrive on their own: a stove left
on catches fire, an egg cooks, a shopkeeper goes on break, a father wakes and
comes to the room. None of those is a reaction to a fact that just happened, so
none could be expressed with events alone. And a cutscene that puts the player
somewhere facing an arriving character needs the script to place the player, not
only the NPCs and props around them (ADR 0026).

## Timers fire off the shared clock, not a wall clock

A script sets a deadline with a `timer` effect naming the deadline and how long
from now, in milliseconds on the shared clock. The host keeps the pending
deadlines and, when the clock reaches one, authors a `timer` event carrying the
deadline's id, exactly as it authors an `entity-used` or `zone-entered`. The
script folds over that event like any other fact, so a timer is a fact about
time rather than a mutable callback.

The world already calls into the host every frame to report where the player
stands. Pumping the host there lets due timers fire even on a frame with no
player action, and a script that has set no timer costs one map lookup to pump.
The interpreter is stepped only when a deadline actually came due, so a quiet
frame does not run creator code.

Deadlines are kept against `now()`, the shared clock the host is already given,
never against `setTimeout` or `Date.now` directly. Two peers that set the same
deadline from the same facts reach it at the same moment, and the `timer` events
they author carry the same id. Ordering among deadlines that come due together
is by id, so the authored facts do not depend on map iteration order.

## Player placement is a per-player effect, like voice

`player-place` puts the local player's feet somewhere and may turn them;
`player-face` turns them to look at a world point. Both name a player and are
delivered to that player's own client through the same host callback the dialogs
and endings already use, so a script's cutscene is the voice tier: it changes
what one player sees and needs no convergence with anyone else. The trusted
side answers it by setting the avatar's position and heading and re-placing the
camera, the same writes the respawn path already makes.

## Considered options

- **Give the guest `setTimeout` and let it call back into the script.** Rejected:
  ADR 0027 removed timers from the sandbox on purpose, and a callback would make
  rule state a live callback graph rather than a fold over facts.
- **Step the interpreter every frame so a script can compare the clock itself.**
  Rejected: it runs creator code on every frame of every peer for outcomes that
  are rare, and it makes a script's own bookkeeping, not the event log, the
  source of a timer.
- **Have the host schedule with `setTimeout` at the authoring moment.** Rejected
  as the source of truth: the day-night clock can be sped up or pinned, and a
  wall-clock timer would then drift from the game's own time. The shared clock
  is read when the deadline is due.

## Consequences

- `timer` joins the event vocabulary, so the event-log and record validators
  bound its id like every other fact.
- A script's timers live in the host, not the interpreter, so a restart clears
  them with the rest of the host's state, and a timer cannot outlive the script
  that set it.
- Player placement is trusted-side and local. A peer never receives another
  player's placement as a fact, because the effect names one player.
