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
import { reportsByAge } from "./html.ts";
import { METRICS, phaseMetrics, show } from "./metrics.ts";
import type { Metric } from "./metrics.ts";
import type { BenchReport } from "./report.ts";
import type { RunSummary } from "./summarize.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
/** The application directory, whatever directory the script was started from. */
const APP_DIR = join(HERE, "..", "..");
const RUNNER = join(HERE, "run.ts");

/** What one side of the comparison measured, pooled across its rounds. */
interface Side {
  /** The commit measured, as its reports name it. */
  commit: string;
  /** Every repeat of every round, keyed by the scenario it belongs to. */
  repeats: Map<string, RunSummary[]>;
  /** What each scenario is, for the report to say. */
  descriptions: Map<string, string>;
}

/** The middle value of `values`, which is not changed by one wild run. */
export const median = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
};

/**
 * Whether a metric's repeats from one commit stay clear of the repeats from
 * the other. Two runs of the same commit differ, so a difference between the
 * commits is only worth reading when it is larger than that: every value from
 * one side above every value from the other, or every one below.
 *
 * A side measured only once has no spread to be judged against, so nothing is
 * ever called clear on one repeat.
 *
 * @param before Every repeat of the metric on one commit.
 * @param after Every repeat of the same metric on the other.
 * @returns Whether the two sets of values are disjoint.
 */
export const standsApart = (before: number[], after: number[]): boolean => {
  if (before.length < 2 || after.length < 2) {
    return false;
  }
  return (
    Math.min(...before) > Math.max(...after) ||
    Math.min(...after) > Math.max(...before)
  );
};

/** The share of `before` that the step from it to `after` amounts to. */
const changeBetween = (before: number, after: number): number =>
  before === 0 ? (after === 0 ? 0 : 1) : (after - before) / before;

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
    repeats: new Map<string, RunSummary[]>(),
    descriptions: new Map<string, string>(),
  };
  for (const scenario of report.scenarios) {
    into.repeats.set(scenario.name, [
      ...(into.repeats.get(scenario.name) ?? []),
      ...scenario.repeats,
    ]);
    into.descriptions.set(scenario.name, scenario.description);
  }
  return into;
};

/** One metric's line: both commits' middles and ranges, and the step between. */
const line = (
  metric: Metric,
  before: number[],
  after: number[],
): { text: string; apart: boolean; change: number } => {
  const middles = [median(before), median(after)] as const;
  const change = changeBetween(middles[0], middles[1]);
  const range = (values: number[]): string =>
    `${show(median(values), metric.unit)} [${show(Math.min(...values), metric.unit)}–${show(Math.max(...values), metric.unit)}]`;
  const percent = `${change >= 0 ? "+" : ""}${(change * 100).toFixed(1)}%`;
  const apart = standsApart(before, after);
  return {
    text: `  ${metric.name.padEnd(16)} ${range(before).padStart(26)} → ${range(after).padStart(26)} ${percent.padStart(8)}${apart ? "  clear of the spread" : ""}`,
    apart,
    change,
  };
};

/** Everything that moved further than the repeats of one commit disagree. */
interface Clear {
  scenario: string;
  metric: string;
  before: number;
  after: number;
  unit: Metric["unit"];
  change: number;
}

const report = (before: Side, after: Side): string => {
  const lines: string[] = [];
  const clear: Clear[] = [];
  for (const [scenario, afterRepeats] of after.repeats) {
    const beforeRepeats = before.repeats.get(scenario);
    if (beforeRepeats === undefined) {
      lines.push(`\n${scenario} — only measured on ${after.commit}`);
      continue;
    }
    lines.push(
      `\n${scenario} — ${after.descriptions.get(scenario) ?? ""}`,
      `  ${beforeRepeats.length} repeats of ${before.commit} against ${afterRepeats.length} of ${after.commit}, middle [lowest–highest]`,
    );
    const metrics = [
      ...METRICS,
      ...phaseMetrics([...beforeRepeats, ...afterRepeats]),
    ];
    for (const metric of metrics) {
      const beforeValues = beforeRepeats.map(metric.of);
      const afterValues = afterRepeats.map(metric.of);
      const drawn = line(metric, beforeValues, afterValues);
      lines.push(drawn.text);
      if (drawn.apart) {
        clear.push({
          scenario,
          metric: metric.name,
          before: median(beforeValues),
          after: median(afterValues),
          unit: metric.unit,
          change: drawn.change,
        });
      }
    }
  }
  lines.push("");
  if (clear.length === 0) {
    lines.push(
      "nothing moved further than the repeats of one commit disagree among themselves.",
    );
    return lines.join("\n");
  }
  lines.push("clear of the run-to-run spread:");
  for (const one of clear.sort(
    (a, b) => Math.abs(b.change) - Math.abs(a.change),
  )) {
    lines.push(
      `  ${one.scenario.padEnd(8)} ${one.metric.padEnd(16)} ${show(one.before, one.unit)} → ${show(one.after, one.unit)}  ${one.change >= 0 ? "+" : ""}${(one.change * 100).toFixed(1)}%`,
    );
  }
  lines.push(
    "",
    "every other number moved by less than two runs of the same commit do.",
  );
  return lines.join("\n");
};

const main = (): void => {
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
  const written = report(before, after);
  const file = outPath(
    `ab-${before.commit.replace("+", "")}-${after.commit.replace("+", "")}-${Date.now()}.txt`,
  );
  writeFileSync(file, `${written}\n`);
  console.log(`\n${written}\n\nwritten to ${file}`);
};

// Only when run as a command; the tests import the reasoning above instead.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
