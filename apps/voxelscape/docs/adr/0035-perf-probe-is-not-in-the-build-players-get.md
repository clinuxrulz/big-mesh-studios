# Keep the perf probe out of the build players get

[0032](./0032-performance-probe-in-the-app.md) measured what `PerfProbe` and
`GpuTimer` cost a frame while disarmed — 0.05 microseconds, against a 16,700
microsecond budget — and decided that was cheap enough to leave the calls
unconditionally on the hot path. That finding stands; nothing here revisits
it. What it didn't weigh is that `PerfProbe` and `GpuTimer` themselves —
the ring buffer, the phase/counter/field bookkeeping, the WebGL timer-query
extension — are bytes in the bundle a player downloads whether or not either
is ever armed.

## Decision

`__PERF__` is a global `vite.config.ts` substitutes with a literal at build
time (`command !== "build" || mode === "bench"`): on under `pnpm dev` and
`pnpm test`, off for a real `pnpm build`, back on for `pnpm build:bench`
(`--mode bench`). `src/render/perf-flag.d.ts` declares it as ambient so
TypeScript knows the name without an import.

Rather than gate every call site, the constant picks which *implementation*
`probe` and `GpuTimer` are, once, at the bottom of the modules that define
them:

```ts
// perf-probe.ts
export const probe: PerfProbeApi = __PERF__ ? new PerfProbe() : new NoopProbe();

// perf.ts
export const createGpuTimer: (gl: WebGL2RenderingContext) => GpuTimerApi =
  __PERF__ ? (gl) => new GpuTimer(gl) : () => new NoopGpuTimer();
```

`NoopProbe` and `NoopGpuTimer` implement the same public surface
(`PerfProbeApi`, `GpuTimerApi`) with empty methods and static zero/false
fields. Every call site elsewhere in the app — the frame-phase pairs, the
counters, `create-render-loop.ts`'s `render()`/`animate()` — is exactly what
it was before this decision: an unconditional call into `probe` or a timer
built by `createGpuTimer`, matching 0032's "the calls can sit on the frame
path unconditionally" by construction rather than by convention. There is
nothing to remember to wrap, and nothing for a reviewer to check call site by
call site.

Vite substitutes `__PERF__` per file before Rollup bundles, so in a plain
`pnpm build` the ternary and factory each fold to their noop branch during
that file's own transform; `new PerfProbe()` and `new GpuTimer(...)` never
appear, and Rollup drops both classes as unreferenced. `Object.keys(Phase)`
and its two siblings (`PHASE_NAMES`, `FIELD_NAMES`, `COUNTER_NAMES` — used
only by `PerfProbe`, not `NoopProbe`) are marked `/* @__PURE__ */`, since
Rollup won't drop a call it can't prove side-effect-free on its own, and
without that annotation they survived even once nothing else referenced them.
`Phase`, `Counter`, and `Field` themselves — the plain number-constant objects
call sites pass as arguments — stay in every build regardless; they're
call-site arguments, not probe internals, and cheap enough not to be worth
gating.

Two spots stay explicit `if (__PERF__)` checks, because they're genuine
behavior forks rather than instrumentation calls:

- The `window.location.hash.includes("bench")` block in
  `create-voxelscape.ts` that builds `window.__voxelscape` — it hands out
  route-driving and world-internals access well beyond the probe, which has
  no business existing on `window` in a build a player runs.
- `setDebugPerf` (the `/render:perf` command) reports "performance readout
  unavailable in this build" instead of flipping a signal that would show an
  on-screen HUD `GpuTimer` can no longer feed real numbers to.

## Bench build

`e2e/bench` measures the production build, so it needs one where `__PERF__`
is still on. `apps/voxelscape/.env.bench` sets `VITE_PERF=true`, which
nothing above reads directly — instead `vite.config.ts` computes `__PERF__`
from `mode === "bench"`, and `pnpm build:bench` (`vite build --mode bench`)
is what turns that mode on. `pnpm serve:bench` (`vite preview --mode bench`)
serves it, and `e2e/bench/run.ts` calls both instead of the plain
`build`/`serve` scripts. That build's output goes to `dist-bench/` rather
than `dist/` (a mode-dependent `build.outDir`), so a bench build and a real
build can sit side by side without one going stale for the other's sake.

## Considered options

- **Leave it as 0032 left it.** The runtime cost is negligible, as measured,
  but the bundle-size cost is a different question — `PerfProbe` and
  `GpuTimer` are dead weight for a player who will never arm either.
- **Wrap every call site in `if (__PERF__)`.** Achieves the same bundle-size
  cut, but multiplies one decision (is the probe in this build) into thirty
  or so call sites across six files, each one a chance to forget a wrap and
  quietly leak bytes back in — which is exactly what happened while building
  this, more than once, before the probe/timer themselves were changed to
  decide it in one place instead.
- **Point `pnpm bench` at a plain `pnpm build`** and accept that benchmarking
  needs `VITE_PERF=true` passed by hand each time. Rejected because it's easy
  to forget, and a bench run against a probe-less build wouldn't fail
  loudly — `window.__voxelscape` would simply never appear, and the harness
  already has to wait out a timeout to notice a commit too old to carry it.
