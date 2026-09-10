// The numbers one run is read against another on, and how each is written
// out. They live apart from the tools that do the comparing so that a metric
// added here reaches all of them.
import type { RunContext } from "./report.ts";
import type { RunSummary } from "./summarize.ts";

/** How a value is written out. */
export type Unit = "ms" | "count" | "bytes";

/** One number read out of a run, by the name it is printed under. */
export interface Metric {
  name: string;
  of: (run: RunSummary) => number;
  unit: Unit;
  /**
   * The column this reads, when it reads one. A run measured from a commit
   * that carried no such column has no number here at all, which is not the
   * same as having measured zero.
   */
  needs?: string;
}

/** Whether a run carried what a metric reads, and so has a number for it. */
export const measured = (metric: Metric, run: RunSummary): boolean =>
  metric.needs === undefined || run.recorded.includes(metric.needs);

/** How much longer a phase has to take than nothing at all to be worth comparing. */
const PHASE_FLOOR_MS = 0.005;

/**
 * Below this a value is at the floor of what its unit can measure, and the
 * step from it to anything else is not a share of it that means anything: a
 * phase that took six ten-thousandths of a millisecond and now takes two
 * hundredths has not risen by three thousand per cent in any sense a reader
 * can use, however exactly that is the arithmetic.
 */
const FLOOR: Record<Unit, number> = {
  ms: PHASE_FLOOR_MS,
  bytes: 1024,
  count: 1,
};

/** Whether a value is too near its unit's floor to be divided into. */
export const tooSmallToDivide = (value: number, unit: Unit): boolean =>
  value < FLOOR[unit];

/**
 * The numbers a run paced this way is read on.
 *
 * A run the display paced counts a frame late when it took half again as long
 * as that run's own middle frame, which is the refresh period it was held to.
 * Nothing holds an unlocked run to anything — its middle frame is however long
 * the work took, and a bar set from it would call an ordinary frame late — so
 * a frame there is counted against a sixtieth of a second instead.
 *
 * @param pacing Whether the run's frames waited for the display.
 * @returns The metrics to read the run on, in the order they are printed.
 */
export const metricsFor = (pacing: RunContext["pacing"]): Metric[] => [
  { name: "gap p50", of: (run) => run.gap.median, unit: "ms", needs: "gapMs" },
  { name: "gap p95", of: (run) => run.gap.p95, unit: "ms", needs: "gapMs" },
  { name: "gap p99", of: (run) => run.gap.p99, unit: "ms", needs: "gapMs" },
  { name: "worst frame", of: (run) => run.gap.max, unit: "ms", needs: "gapMs" },
  { name: "main thread", of: (run) => run.mainThread.mean, unit: "ms" },
  { name: "worst main", of: (run) => run.mainThread.max, unit: "ms" },
  {
    name: "gpu draw p50",
    of: (run) => run.gpu.median,
    unit: "ms",
    needs: "gpuMs",
  },
  pacing === "paced"
    ? { name: "dropped frames", of: (run) => run.drops.count, unit: "count" }
    : {
        name: "over budget",
        of: (run) => run.overBudget.count,
        unit: "count",
      },
  {
    name: "render scale",
    of: (run) => run.scale.median,
    unit: "count",
    needs: "scale",
  },
  {
    name: "triangles",
    of: (run) => run.triangles.median,
    unit: "count",
    needs: "triangles",
  },
  {
    name: "fills landed",
    of: (run) => run.counters.fillsLanded,
    unit: "count",
  },
  { name: "merges", of: (run) => run.counters.merges, unit: "count" },
  {
    name: "uploaded",
    of: (run) => run.upload.totalBytes,
    unit: "bytes",
    needs: "uploadBytes",
  },
  {
    name: "biggest upload",
    of: (run) => run.upload.maxFrameBytes,
    unit: "bytes",
    needs: "uploadBytes",
  },
  {
    name: "peak heap",
    of: (run) => run.heap.maxBytes,
    unit: "bytes",
    needs: "heapBytes",
  },
  {
    name: "merged geometry",
    of: (run) => run.resident.mergedGeometryBytes,
    unit: "bytes",
    needs: "mergedGeometryBytes",
  },
  {
    name: "block meshes",
    of: (run) => run.resident.blockGeometryBytes,
    unit: "bytes",
    needs: "blockGeometryBytes",
  },
  {
    name: "outrun frames",
    of: (run) => run.outrun.frames,
    unit: "count",
    needs: "cellReady",
  },
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
    needs: name,
  }));
};

/** Writes `value` the way a reader of its unit expects to see it. */
export const show = (value: number, unit: Unit): string => {
  if (unit === "ms") {
    return `${value.toFixed(2)}ms`;
  }
  if (unit === "bytes") {
    return `${(value / (1024 * 1024)).toFixed(1)}MiB`;
  }
  return value >= 100 ? value.toFixed(0) : value.toFixed(2);
};
