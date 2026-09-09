import type { RunSummary } from "./summarize.ts";

/** Everything about a run that decides whether its numbers can be compared with another's. */
export interface RunContext {
  /** The commit the build came from. */
  commit: string;
  /** Whether the working tree had uncommitted changes when the build was made. */
  dirty: boolean;
  /** When the run finished, as an ISO 8601 timestamp. */
  finishedAt: string;
  /** The graphics card the browser reported drawing on. */
  graphicsCard: string;
  /** Processor threads the machine reports. */
  cores: number;
  /** The page size the run was measured at. */
  viewport: { width: number; height: number };
  /** The chunk window's horizontal radius, and how many blocks that is. */
  chunkRadius: number;
  blockCount: number;
  /** The render scale the run pinned, so the adaptive scaler could not absorb a regression. */
  pinnedScale: number;
  /** How the world's worker pool was sized. */
  workers: string;
}

/** One scenario's measurements, one entry per repeat. */
export interface ScenarioReport {
  name: string;
  description: string;
  /** World units the route should have covered, for checking that it did. */
  expectedUnits: number;
  repeats: RunSummary[];
}

/** A whole run: the conditions it was measured under, and every scenario in it. */
export interface BenchReport {
  context: RunContext;
  scenarios: ScenarioReport[];
}

const ms = (value: number): string => `${value.toFixed(1)}ms`;
const micro = (value: number): string => `${value.toFixed(2)}ms`;
const megabytes = (bytes: number): string =>
  `${(bytes / (1024 * 1024)).toFixed(1)}MB`;

/** The repeat a scenario reports as its result: the one with the middle 95th-percentile gap. */
export const representative = (repeats: RunSummary[]): RunSummary => {
  const ordered = [...repeats].sort((a, b) => a.gap.p95 - b.gap.p95);
  return ordered[Math.floor(ordered.length / 2)];
};

/**
 * The phases worth printing, costliest first, as a mean and the worst single
 * frame. The worst frame rather than a percentile because a phase that stalls
 * four frames out of five hundred is exactly the jank worth chasing, and the
 * 99th percentile of five hundred frames steps straight over it. The
 * mean rather than the median because a browser that is not cross-origin
 * isolated rounds its clock to a tenth of a millisecond: a phase that truly
 * costs 30 microseconds reads as zero on most frames and as a tenth on the
 * rest, and only the average of many frames recovers what it actually cost.
 */
const busyPhases = (run: RunSummary): [string, number, number][] =>
  Object.entries(run.phases)
    .map(([name, spread]): [string, number, number] => [
      name,
      spread.mean,
      spread.max,
    ])
    .filter(([, mean, max]) => mean > 0.005 || max > 0.05)
    .sort((a, b) => b[1] - a[1]);

/** Writes one scenario's numbers as the lines a reader scans down. */
export const formatScenario = (scenario: ScenarioReport): string => {
  const run = representative(scenario.repeats);
  const lines: string[] = [];
  lines.push(`${scenario.name} — ${scenario.description}`);
  lines.push(
    `  frames   ${run.frames} in ${(run.durationMs / 1000).toFixed(1)}s · ` +
      `gap p50 ${ms(run.gap.median)} p95 ${ms(run.gap.p95)} p99 ${ms(run.gap.p99)} max ${ms(run.gap.max)}`,
  );
  lines.push(
    `  dropped  ${run.drops.count} frames (${(run.drops.share * 100).toFixed(1)}%), ` +
      `longest run ${run.drops.longestRun}, over ${ms(run.drops.thresholdMs)}`,
  );
  const gpu =
    run.gpu.count === 0
      ? "gpu timing unsupported by this browser"
      : `gpu p50 ${micro(run.gpu.median)} p99 ${micro(run.gpu.p99)}`;
  lines.push(
    `  drawing  ${gpu} · ` +
      `scale ${run.scale.median.toFixed(3)}x (lowest ${run.scale.min.toFixed(3)}x) · ` +
      `${Math.round(run.triangles.median).toLocaleString()} triangles`,
  );
  const phases = busyPhases(run)
    .map(([name, mean, max]) => `${name} ${micro(mean)}/${micro(max)}`)
    .join(" · ");
  lines.push(
    `  phases   ${phases === "" ? "none measurable" : phases}  (mean/worst)`,
  );
  lines.push(
    `  world    fills ${run.counters.fillsRequested}→${run.counters.fillsLanded} · ` +
      `meshes ${run.counters.meshesRequested}→${run.counters.meshesLanded} ` +
      `(${run.counters.meshesFromFill} arrived with their fill) · ` +
      `${run.counters.scrolls} scrolls streaming ${run.counters.blocksStreamed} blocks · ` +
      `${run.counters.merges} merges, ${run.counters.uploads} uploads`,
  );
  lines.push(
    `  queues   fill ${run.queues.fillPending}/${run.queues.fillInFlight} · ` +
      `mesh ${run.queues.meshPending}/${run.queues.meshInFlight} · ` +
      `${run.queues.dirtySuperchunks} dirty superchunks (deepest reached)`,
  );
  lines.push(
    `  upload   ${megabytes(run.upload.totalBytes)} over ${run.upload.framesWithUpload} frames, ` +
      `most ${megabytes(run.upload.maxFrameBytes)} in one`,
  );
  lines.push(
    `  memory   heap ${megabytes(run.heap.startBytes)} → ${megabytes(run.heap.endBytes)} ` +
      `(peak ${megabytes(run.heap.maxBytes)})`,
  );
  lines.push(
    run.outrun.frames === 0
      ? "  streaming the player never stood on terrain that had not arrived"
      : `  streaming the player outran it for ${run.outrun.frames} frames ` +
          `(${(run.outrun.share * 100).toFixed(1)}%), longest ${run.outrun.longestRun} in a row`,
  );
  lines.push(
    `  travelled ${run.travel.pathUnits.toFixed(0)} units along the path, ` +
      `${run.travel.straightUnits.toFixed(0)} end to end, of ${scenario.expectedUnits.toFixed(0)} asked for`,
  );
  if (scenario.repeats.length > 1) {
    const tails = scenario.repeats
      .map((repeat) => ms(repeat.gap.p95))
      .join(", ");
    lines.push(`  repeats  95th-percentile gap per run: ${tails}`);
  }
  if (run.wrapped) {
    lines.push(
      "  note     the run outlasted the probe's ring; its earliest frames were dropped",
    );
  }
  return lines.join("\n");
};

/** Writes the whole report: the conditions first, then every scenario. */
export const formatReport = (report: BenchReport): string => {
  const { context } = report;
  const head = [
    `commit ${context.commit}${context.dirty ? " (working tree dirty)" : ""} · ${context.finishedAt}`,
    `${context.graphicsCard} · ${context.cores} threads · ` +
      `${context.viewport.width}x${context.viewport.height} · ` +
      `radius ${context.chunkRadius} (${context.blockCount} blocks) · ` +
      `scale pinned at ${context.pinnedScale} · ${context.workers}`,
  ].join("\n");
  return [head, "", ...report.scenarios.map(formatScenario)].join("\n\n");
};
