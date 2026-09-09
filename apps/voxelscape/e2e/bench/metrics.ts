// The numbers one run is read against another on, and how each is written
// out. They live apart from the tools that do the comparing so that a metric
// added here reaches all of them.
import type { RunSummary } from "./summarize.ts";

/** How a value is written out. */
export type Unit = "ms" | "count" | "bytes";

/** One number read out of a run, by the name it is printed under. */
export interface Metric {
  name: string;
  of: (run: RunSummary) => number;
  unit: Unit;
}

/** How much longer a phase has to take than nothing at all to be worth comparing. */
const PHASE_FLOOR_MS = 0.005;

export const METRICS: Metric[] = [
  { name: "gap p50", of: (run) => run.gap.median, unit: "ms" },
  { name: "gap p95", of: (run) => run.gap.p95, unit: "ms" },
  { name: "gap p99", of: (run) => run.gap.p99, unit: "ms" },
  { name: "worst frame", of: (run) => run.gap.max, unit: "ms" },
  { name: "main thread", of: (run) => run.mainThread.mean, unit: "ms" },
  { name: "worst main", of: (run) => run.mainThread.max, unit: "ms" },
  { name: "gpu draw p50", of: (run) => run.gpu.median, unit: "ms" },
  { name: "dropped frames", of: (run) => run.drops.count, unit: "count" },
  { name: "render scale", of: (run) => run.scale.median, unit: "count" },
  { name: "triangles", of: (run) => run.triangles.median, unit: "count" },
  {
    name: "fills landed",
    of: (run) => run.counters.fillsLanded,
    unit: "count",
  },
  { name: "merges", of: (run) => run.counters.merges, unit: "count" },
  { name: "uploaded", of: (run) => run.upload.totalBytes, unit: "bytes" },
  {
    name: "biggest upload",
    of: (run) => run.upload.maxFrameBytes,
    unit: "bytes",
  },
  { name: "peak heap", of: (run) => run.heap.maxBytes, unit: "bytes" },
  { name: "outrun frames", of: (run) => run.outrun.frames, unit: "count" },
];

/**
 * A metric for the main-thread milliseconds each phase took, for every phase
 * any of `runs` spent more than a moment in. The phases a run records depend
 * on what it did, so they are read off the runs in hand rather than listed.
 *
 * @param runs Every run being compared, from both sides of the comparison.
 * @returns One metric per phase, in the order the phases are named.
 */
export const phaseMetrics = (runs: RunSummary[]): Metric[] => {
  const names = new Set<string>();
  for (const run of runs) {
    for (const [name, phase] of Object.entries(run.phases)) {
      if (phase.mean > PHASE_FLOOR_MS) {
        names.add(name);
      }
    }
  }
  return [...names].map((name) => ({
    name,
    of: (run: RunSummary) => run.phases[name]?.mean ?? 0,
    unit: "ms" as const,
  }));
};

/** Writes `value` the way a reader of its unit expects to see it. */
export const show = (value: number, unit: Unit): string => {
  if (unit === "ms") {
    return `${value.toFixed(2)}ms`;
  }
  if (unit === "bytes") {
    return `${(value / (1024 * 1024)).toFixed(1)}MB`;
  }
  return value >= 100 ? value.toFixed(0) : value.toFixed(2);
};
