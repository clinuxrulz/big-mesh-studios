// Puts two benchmark reports side by side. With no arguments it takes the two
// most recent runs in `e2e/.out`, which is what you want after changing
// something and running `pnpm bench` again.
//
//   pnpm bench:compare
//   pnpm bench:compare e2e/.out/bench-abc1234-…json e2e/.out/bench-def5678-…json
//
// Nothing here passes or fails, and each side is shown through one
// representative repeat of the run. Two runs on the same machine, a few
// minutes apart, differ by a few percent on every number, and one repeat
// cannot say whether a difference is larger than that; `pnpm bench:ab` keeps
// every repeat and answers that question directly.
import { readFileSync } from "node:fs";
import { outDir } from "../out-dir.ts";
import { reportsByAge } from "./html.ts";
import { metricsFor, show } from "./metrics.ts";
import type { Metric } from "./metrics.ts";
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
  metrics: Metric[],
): string => {
  const one = representative(before.repeats);
  const two = representative(after.repeats);
  return [
    `${after.name} — ${after.description}`,
    ...metrics.map((metric) =>
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
    before.context.pinnedScale !== after.context.pinnedScale ||
    before.context.pacing !== after.context.pacing
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
    console.log(
      `\n${compareScenario(beforeScenario, afterScenario, metricsFor(after.context.pacing))}`,
    );
  }
};

main();
