# Measure the frame from inside the application

Performance was measured from outside, by Playwright scripts that held a key
down and read frame gaps through a `PerformanceObserver`. That vantage point
can see three things: how long a frame took, whether a task ran long, and what
the page has written into the document. It cannot see which part of the frame
took the time, how many blocks are queued for terrain, how many bytes went to
the graphics card, or whether the player is standing on terrain that has not
arrived — and those are the things every performance question about this world
turns out to be about.

It also could not see two problems with its own numbers. Holding `w` walks the
player into the first hillside and stops: a walk measured that way covered
about 18 world units in 30 seconds, so almost every number those scripts
produced described a player standing still. And `AdaptiveResolution` lowers the
render scale until the frame fits its target, so a renderer that got slower
reports the same frame time on a smaller canvas; nothing recorded the scale, so
that trade was invisible.

## Decision

`src/render/perf-probe.ts` holds a `PerfProbe` that records one row a frame —
the gap, the graphics card's own time, the render scale, the queue depths, the
bytes uploaded, the triangle count, the heap, whether the player's cell has
streamed in, and a slice for each phase of the frame — plus a counter for each
kind of work the world asked for and completed. `e2e/bench` arms it, drives the
player, and carries the rows away.

The probe is a module-level value the frame path reports into, rather than an
object handed down through constructors. Measurement crosses every layer of a
frame — the player, the streaming clients, the renderer's merge loop — and a
parameter threaded through all of them would put a benchmark's concern in the
signature of objects that otherwise know nothing about one, the way the
renderer knows nothing about the console.

Three properties make it safe to leave on the frame path:

- **Disarmed it is a branch.** Every method returns on a boolean it reads
  first. Measured over two hundred thousand frames of the full call pattern —
  twelve phase pairs, seventeen gauges and a frame close — that costs 0.05
  microseconds a frame, against a 16,700 microsecond budget at 60 frames a
  second.
- **Armed it allocates nothing.** The rows are one `Float64Array` ring
  allocated when the probe is armed, and the phase slices, counters and gauges
  are fixed arrays beside it. Armed, the same pattern costs 1.17 microseconds
  a frame, or seven thousandths of one percent of the budget. A probe that
  allocated would cause the collection pause it then blamed on the frame.
- **It is armed only by the benchmark.** The bench surface it hangs from is
  built only when the address bar carries `#bench`, the way `#perf` builds the
  statistics line.

The benchmark itself pins what would otherwise differ between two runs of the
same commit: the render scale, so the adaptive scaler cannot absorb a slower
renderer as a smaller canvas; the clock, since the time of day changes what is
drawn; and the weather, which is the world's one genuinely random input. The
terrain, the spawn and the monsters are seeded already.

The player is carried along a route rather than walked into the terrain. A
route is stepped from the frame's own `dt`, so it covers the same ground on a
fast machine and a slow one, and it asks the world to scroll itself — the
frame's own scroll sits behind the gate that holds physics while the player's
cell streams in, and a route that outran the streaming would otherwise never
ask for the cell it was standing in. The routes measured 538 units of a 540
unit sprint, against 18 units the key-press harness managed in nearly four
times as long.

What comes out of a run is a report, not a verdict. Frame times are the
machine's, and two runs minutes apart differ by a few percent; the counts of
work — fills requested and landed, merges, uploads, bytes — repeat exactly
between runs of the same commit, so they are what a change is actually read
against.

## Considered options

- **Keep measuring from outside.** Nothing about a queue depth or a phase
  slice is visible from Playwright, and the two flaws above were invisible to
  the scripts that had them. The parts that genuinely belong outside — running
  the browser, driving the run, writing the report — are still outside.
- **Hand a probe to each object that reports.** It reaches `FillClient`,
  `MeshClient`, `TriangleRenderer`, `ChunkSphere`, the render loop and the
  frame function; every one of their constructors would carry an argument that
  exists for a benchmark, and every test that builds one would have to supply
  it.
- **Sample a profile instead of instrumenting.** Chromium's sampling profiler
  already gives a function-level breakdown, and the benchmark can still take
  one. It cannot attribute time to a phase the code does not name, it says
  nothing about queues, uploads or streaming, and its 200 microsecond sampling
  interval is coarser than most of the phases here.
- **Simulate the frame without a browser.** The existing `e2e/*-sim.ts` scripts
  do exactly this and stay. They cannot time drawing, which is the largest
  single phase in every scenario measured, so they answer a different question
  rather than this one more cheaply.
