// Puts two benchmark reports side by side. With no arguments it takes the two
// most recent runs in `e2e/.out`, which is what you want after changing
// something and running `pnpm bench` again.
//
//   pnpm bench:compare
//   pnpm bench:compare e2e/.out/bench-abc1234-…json e2e/.out/bench-def5678-…json
//
// Nothing here passes or fails. Two runs on the same machine, a few minutes
// apart, differ by a few percent on every number; what is worth reading is a
// change large enough to stand out from the spread the repeats show.
import { readFileSync } from "node:fs";
import { outDir } from "../out-dir.ts";
import { reportsByAge } from "./html.ts";
import { representative } from "./report.ts";
import type { BenchReport, ScenarioReport } from "./report.ts";
import type { RunSummary } from "./summarize.ts";

/** The change worth drawing the eye to, as a share of the earlier value. */
const NOTABLE = 0.1;

/** The two most recent reports in the output directory, older one first. */
const twoMostRecent = (): [string, string] => {
  const reports = reportsByAge();
  if (reports.length < 2) {
    throw new Error(
      `need two reports to compare and found ${reports.length} in ${outDir()}`,
    );
  }
  return [reports[reports.length - 2], reports[reports.length - 1]];
};

const read = (path: string): BenchReport =>
  JSON.parse(readFileSync(path, "utf8")) as BenchReport;

/** One metric read out of a run, by the name it is printed under. */
interface Metric {
  name: string;
  of: (run: RunSummary) => number;
  /** How to write the value; also decides whether a rise is worth remarking on. */
  unit: "ms" | "count" | "bytes";
}

const METRICS: Metric[] = [
  { name: "gap p50", of: (run) => run.gap.median, unit: "ms" },
  { name: "gap p95", of: (run) => run.gap.p95, unit: "ms" },
  { name: "gap p99", of: (run) => run.gap.p99, unit: "ms" },
  { name: "worst frame", of: (run) => run.gap.max, unit: "ms" },
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

const show = (value: number, unit: Metric["unit"]): string => {
  if (unit === "ms") {
    return `${value.toFixed(2)}ms`;
  }
  if (unit === "bytes") {
    return `${(value / (1024 * 1024)).toFixed(1)}MB`;
  }
  return value >= 100 ? value.toFixed(0) : value.toFixed(2);
};

/** One metric's line: both values, and the change between them. */
const line = (
  name: string,
  before: number,
  after: number,
  unit: Metric["unit"],
): string => {
  const change =
    before === 0 ? (after === 0 ? 0 : 1) : (after - before) / before;
  const percent = `${change >= 0 ? "+" : ""}${(change * 100).toFixed(1)}%`;
  const mark = Math.abs(change) >= NOTABLE ? " <—" : "";
  return `  ${name.padEnd(16)} ${show(before, unit).padStart(10)} → ${show(after, unit).padStart(10)}  ${percent.padStart(7)}${mark}`;
};

/** The phases whose mean or worst frame moved most between the two runs. */
const phaseMovers = (before: RunSummary, after: RunSummary): string[] =>
  Object.keys(after.phases)
    .map((name) => ({
      name,
      before: before.phases[name]?.mean ?? 0,
      after: after.phases[name].mean,
      worstBefore: before.phases[name]?.max ?? 0,
      worstAfter: after.phases[name].max,
    }))
    .filter((phase) => phase.before > 0.005 || phase.after > 0.005)
    .sort((a, b) => Math.abs(b.after - b.before) - Math.abs(a.after - a.before))
    .slice(0, 5)
    .map((phase) =>
      [
        `  ${phase.name.padEnd(16)}`,
        `${show(phase.before, "ms").padStart(10)} → ${show(phase.after, "ms").padStart(10)}`,
        ` mean, worst ${show(phase.worstBefore, "ms")} → ${show(phase.worstAfter, "ms")}`,
      ].join(""),
    );

const compareScenario = (
  before: ScenarioReport,
  after: ScenarioReport,
): string => {
  const one = representative(before.repeats);
  const two = representative(after.repeats);
  return [
    `${after.name} — ${after.description}`,
    ...METRICS.map((metric) =>
      line(metric.name, metric.of(one), metric.of(two), metric.unit),
    ),
    "  phases that moved most:",
    ...phaseMovers(one, two),
  ].join("\n");
};

const main = (): void => {
  const [beforePath, afterPath] =
    process.argv.length >= 4
      ? [process.argv[2], process.argv[3]]
      : twoMostRecent();
  const before = read(beforePath);
  const after = read(afterPath);

  console.log(
    [
      `before  ${before.context.commit}${before.context.dirty ? "+" : ""}  ${before.context.finishedAt}`,
      `after   ${after.context.commit}${after.context.dirty ? "+" : ""}  ${after.context.finishedAt}`,
    ].join("\n"),
  );
  if (
    before.context.graphicsCard !== after.context.graphicsCard ||
    before.context.chunkRadius !== after.context.chunkRadius ||
    before.context.pinnedScale !== after.context.pinnedScale
  ) {
    console.log(
      "\nthese two runs were measured under different conditions; the numbers below are not comparable",
    );
  }

  for (const afterScenario of after.scenarios) {
    const beforeScenario = before.scenarios.find(
      (candidate) => candidate.name === afterScenario.name,
    );
    if (beforeScenario === undefined) {
      console.log(`\n${afterScenario.name} — only in the later run`);
      continue;
    }
    console.log(`\n${compareScenario(beforeScenario, afterScenario)}`);
  }
};

main();
