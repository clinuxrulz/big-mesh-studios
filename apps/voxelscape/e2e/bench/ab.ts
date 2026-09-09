// Measures this checkout against another commit in one sitting, and reports
// what moved between them.
//
//   pnpm bench:ab bcf5696                    # the quick scenarios, once each
//   pnpm bench:ab bcf5696 walk turn --repeat 3
//   pnpm bench:ab bcf5696 --repeat 3 --unlocked
//   pnpm bench:ab bcf5696 --rounds 2         # take the two commits in turn twice
//
// The first plain argument names the commit to measure against; everything
// else is handed to `pnpm bench` untouched, so the scenarios and the flags are
// the ones that command already takes.
//
// The two commits are measured one after the other rather than on different
// days, because a run carries the machine it was made on: what else was
// running, how warm the card had become. Taking them in turn puts both through
// the same afternoon.
//
// Every repeat of every run is kept, and a change is only called out when the
// repeats of one commit do not reach into the repeats of the other. Two runs
// of the same commit already disagree — a walk streams different terrain each
// time it boots — and a difference smaller than that disagreement says nothing
// about the change between them.
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { outPath } from "../out-dir.ts";
import { clearOfTheSpread, compareSides } from "./ab-report.ts";
import type { AbReport, MetricComparison, Side } from "./ab-report.ts";
import { reportsByAge, writeAbHtmlReport } from "./html.ts";
import { show } from "./metrics.ts";
import type { BenchReport } from "./report.ts";
import type { RunSummary } from "./summarize.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
/** The application directory, whatever directory the script was started from. */
const APP_DIR = join(HERE, "..", "..");
const RUNNER = join(HERE, "run.ts");

/** Runs the benchmark once with `args`, and reads back the report it wrote. */
const measure = (args: string[]): BenchReport => {
  const before = new Set(reportsByAge());
  const run = spawnSync(
    process.execPath,
    ["--experimental-transform-types", RUNNER, ...args],
    { cwd: APP_DIR, stdio: "inherit" },
  );
  if (run.status !== 0) {
    throw new Error(`the benchmark failed with ${args.join(" ")}`);
  }
  const written = reportsByAge().filter((path) => !before.has(path));
  if (written.length !== 1) {
    throw new Error(
      `expected the run to write one report and it wrote ${written.length}`,
    );
  }
  return JSON.parse(readFileSync(written[0], "utf8")) as BenchReport;
};

/** Adds everything `report` measured to the side it belongs to. */
const pool = (side: Side | undefined, report: BenchReport): Side => {
  const into = side ?? {
    commit: `${report.context.commit}${report.context.dirty ? "+" : ""}`,
    pacing: report.context.pacing,
    power: [],
    repeats: new Map<string, RunSummary[]>(),
    descriptions: new Map<string, string>(),
  };
  into.power.push(report.context.power);
  for (const scenario of report.scenarios) {
    into.repeats.set(scenario.name, [
      ...(into.repeats.get(scenario.name) ?? []),
      ...scenario.repeats,
    ]);
    into.descriptions.set(scenario.name, scenario.description);
  }
  return into;
};

/** How a change reads as a percentage, signed. */
const percent = (change: number): string =>
  `${change >= 0 ? "+" : ""}${(change * 100).toFixed(1)}%`;

/** One metric's line: both commits' middles and ranges, and the step between. */
const line = (metric: MetricComparison): string => {
  const range = (values: number[], middle: number): string =>
    `${show(middle, metric.unit)} [${show(Math.min(...values), metric.unit)}–${show(Math.max(...values), metric.unit)}]`;
  return `  ${metric.name.padEnd(16)} ${range(metric.before, metric.beforeMiddle).padStart(26)} → ${range(metric.after, metric.afterMiddle).padStart(26)} ${percent(metric.change).padStart(8)}${metric.apart ? "  clear of the spread" : ""}`;
};

/** The comparison as it reads in a terminal. */
export const formatAb = (report: AbReport): string => {
  const lines: string[] = [];
  if (report.powerMismatch !== null) {
    lines.push(report.powerMismatch);
  }
  for (const scenario of report.scenarios) {
    lines.push(
      `\n${scenario.name} — ${scenario.description}`,
      `  ${scenario.beforeRepeats} repeats of ${report.before.commit} against ${scenario.afterRepeats} of ${report.after.commit}, middle [lowest–highest]`,
      ...scenario.metrics.map(line),
    );
  }
  lines.push("");
  const clear = clearOfTheSpread(report);
  if (clear.length === 0) {
    lines.push(
      "nothing moved further than the repeats of one commit disagree among themselves.",
    );
    return lines.join("\n");
  }
  lines.push("clear of the run-to-run spread:");
  for (const one of clear) {
    lines.push(
      `  ${one.scenario.padEnd(8)} ${one.metric.name.padEnd(16)} ${show(one.metric.beforeMiddle, one.metric.unit)} → ${show(one.metric.afterMiddle, one.metric.unit)}  ${percent(one.metric.change)}`,
    );
  }
  lines.push(
    "",
    "every other number moved by less than two runs of the same commit do.",
  );
  return lines.join("\n");
};

const main = async (): Promise<void> => {
  const argv = process.argv.slice(2);
  let revision: string | undefined;
  let rounds = 1;
  const passed: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--rounds") {
      rounds = Number(argv[++i]);
    } else if (argv[i] === "--at") {
      throw new Error(
        "name the commit to measure against as the first argument, not with --at",
      );
    } else if (!argv[i].startsWith("--") && revision === undefined) {
      revision = argv[i];
    } else {
      passed.push(argv[i]);
    }
  }
  if (revision === undefined) {
    throw new Error(
      "name the commit to measure this checkout against, as in `pnpm bench:ab bcf5696`",
    );
  }

  let before: Side | undefined;
  let after: Side | undefined;
  for (let round = 0; round < rounds; round++) {
    before = pool(before, measure([...passed, "--at", revision]));
    after = pool(after, measure(passed));
  }
  if (before === undefined || after === undefined) {
    throw new Error("--rounds asks for at least one round");
  }
  const compared = compareSides(before, after);
  const stem = `ab-${before.commit.replace("+", "")}-${after.commit.replace("+", "")}-${Date.now()}`;
  const file = outPath(`${stem}.json`);
  writeFileSync(file, JSON.stringify(compared, null, 2));
  const drawn = await writeAbHtmlReport(compared, outPath(`${stem}.html`));
  console.log(
    `\n${formatAb(compared)}\n\nwritten to ${file}\ndrawn in ${drawn}`,
  );
};

// Only when run as a command; the tests import the reasoning above instead.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
