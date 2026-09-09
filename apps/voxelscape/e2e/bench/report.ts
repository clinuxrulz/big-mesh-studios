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
  /** Whether the scaler was left free to move it instead. */
  adaptiveResolution: boolean;
  /** How the world's worker pool was sized. */
  workers: string;
  /** The machine the run stood in for, and how far its processor was slowed. */
  profile: string;
  cpuThrottle: number;
  /**
   * Whether the display's refresh rate was holding frames back. Paced answers
   * "does it keep up"; unlocked answers "what does a frame actually cost",
   * because nothing is waiting for the display.
   */
  pacing: "paced" | "unlocked";
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

/** A sixtieth of a second: the frame a run is asked to fit inside. */
const FRAME_BUDGET_MS = 1000 / 60;

/** Writes one scenario's numbers as the lines a reader scans down. */
export const formatScenario = (
  scenario: ScenarioReport,
  pacing: RunContext["pacing"] = "paced",
): string => {
  const run = representative(scenario.repeats);
  const lines: string[] = [];
  lines.push(`${scenario.name} — ${scenario.description}`);
  lines.push("  measured on this machine, under this profile:");
  lines.push(
    `  frames   ${run.frames} in ${(run.durationMs / 1000).toFixed(1)}s · ` +
      `gap p50 ${ms(run.gap.median)} p95 ${ms(run.gap.p95)} p99 ${ms(run.gap.p99)} max ${ms(run.gap.max)}`,
  );
  lines.push(
    `  budget   main thread ${ms(run.mainThread.median)} a frame, ` +
      `worst ${ms(run.mainThread.max)} — ` +
      `${((run.mainThread.median / FRAME_BUDGET_MS) * 100).toFixed(0)}% of a sixtieth of a second, ` +
      `worst frame ${((run.mainThread.max / FRAME_BUDGET_MS) * 100).toFixed(0)}%`,
  );
  // With the display pacing the frames, a drop is a frame that missed a
  // refresh; without it, every frame arrives as soon as it is drawn and the
  // question is instead how many cost more than a sixtieth of a second.
  const late = pacing === "paced" ? run.drops : run.overBudget;
  lines.push(
    `  ${pacing === "paced" ? "dropped " : "overspent"} ${late.count} frames ` +
      `(${(late.share * 100).toFixed(1)}%), ` +
      `longest run ${late.longestRun}, over ${ms(late.thresholdMs)}`,
  );
  const gpu =
    run.gpu.count === 0
      ? "gpu timing unsupported by this browser"
      : `gpu draw p50 ${micro(run.gpu.median)} p99 ${micro(run.gpu.p99)}` +
        (run.gpuOcclusion.count === 0
          ? ""
          : `, occlusion pass p50 ${micro(run.gpuOcclusion.median)} p99 ${micro(run.gpuOcclusion.p99)}`);
  lines.push(
    `  drawing  ${gpu} · ` +
      `scale ${run.scale.median.toFixed(3)}x (lowest ${run.scale.min.toFixed(3)}x) · ` +
      `${Math.round(run.triangles.median).toLocaleString()} triangles`,
  );
  lines.push(
    `  culling  ${Math.round(run.culling.occluded)} superchunks hidden, ` +
      `${Math.round(run.culling.visible)} drawn — what the occlusion pass buys ` +
      `for what it costs the card above`,
  );
  const phases = busyPhases(run)
    .map(([name, mean, max]) => `${name} ${micro(mean)}/${micro(max)}`)
    .join(" · ");
  lines.push(
    `  phases   ${phases === "" ? "none measurable" : phases}  (mean/worst)`,
  );
  lines.push("  the same on any machine:");
  lines.push(
    `  world    fills ${run.counters.fillsRequested}→${run.counters.fillsLanded} · ` +
      `meshes ${run.counters.meshesRequested}→${run.counters.meshesLanded} ` +
      `(${run.counters.meshesFromFill} arrived with their fill) · ` +
      `${run.counters.scrolls} scrolls streaming ${run.counters.blocksStreamed} blocks · ` +
      `${run.counters.merges} merges (${run.counters.fullRejoins} rebuilt whole), ` +
      `${run.counters.uploads} uploads`,
  );
  lines.push(
    `  queues   fill ${run.queues.fillPending}/${run.queues.fillInFlight} · ` +
      `mesh ${run.queues.meshPending}/${run.queues.meshInFlight} · ` +
      `${run.queues.dirtySuperchunks} dirty superchunks (deepest reached)`,
  );
  lines.push(
    `  upload   ${megabytes(run.upload.totalBytes)} over ${run.upload.framesWithUpload} frames, ` +
      `most ${megabytes(run.upload.maxFrameBytes)} in one ` +
      `(${run.upload.mergesInBiggestFrame} superchunks merged; ` +
      `${run.upload.maxFrameMerges} is the most in any frame)`,
  );
  lines.push(
    `  resident ${megabytes(run.resident.startBytes)} → ${megabytes(run.resident.endBytes)} ` +
      `(peak ${megabytes(run.resident.maxBytes)}: ` +
      `${megabytes(run.resident.voxelBytes)} voxels and light, ` +
      `${megabytes(run.resident.geometryBytes)} geometry)`,
  );
  lines.push(
    `  heap     ${megabytes(run.heap.startBytes)} → ${megabytes(run.heap.endBytes)} ` +
      `(peak ${megabytes(run.heap.maxBytes)}) — excludes the buffers above, so read it beside them`,
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
    `profile ${context.profile}` +
      (context.cpuThrottle > 1
        ? `, processor slowed ${context.cpuThrottle} times`
        : "") +
      ` · frames ${context.pacing}`,
    `${context.graphicsCard} · ${context.cores} threads · ` +
      `${context.viewport.width}x${context.viewport.height} · ` +
      `radius ${context.chunkRadius} (${context.blockCount} blocks) · ` +
      (context.adaptiveResolution
        ? "resolution adapting"
        : `scale pinned at ${context.pinnedScale}`) +
      ` · ${context.workers}`,
  ].join("\n");
  return [
    head,
    "",
    ...report.scenarios.map((scenario) =>
      formatScenario(scenario, context.pacing),
    ),
  ].join("\n\n");
};
