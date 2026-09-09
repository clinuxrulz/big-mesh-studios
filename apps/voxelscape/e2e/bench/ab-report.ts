// What comparing one commit against another found: every metric, on both
// sides, across every repeat either was measured over. Held apart from the
// command that produces it so the page that draws it can read the same shape.
//
// Nothing here decides that a change is good or bad. It decides one narrower
// thing: whether a difference is larger than the disagreement between repeats
// of the same commit, which is the only ground for reading it at all.
import { metricsFor, phaseMetrics } from "./metrics.ts";
import type { Metric, Unit } from "./metrics.ts";
import { describePower, samePower } from "./power.ts";
import type { PowerState } from "./power.ts";
import type { RunContext } from "./report.ts";
import type { RunSummary } from "./summarize.ts";

/** One side of a comparison: a commit, and everything measured of it. */
export interface Side {
  /** The commit measured, as its reports name it. */
  commit: string;
  /** Whether the runs' frames waited for the display, which both sides share. */
  pacing: RunContext["pacing"];
  /** How the machine was powered for each round this side was measured over. */
  power: PowerState[];
  /** Every repeat of every round, keyed by the scenario it belongs to. */
  repeats: Map<string, RunSummary[]>;
  /** What each scenario is, for the report to say. */
  descriptions: Map<string, string>;
}

/** One metric, as both commits measured it. */
export interface MetricComparison {
  name: string;
  unit: Unit;
  /** Every repeat's value on the earlier commit, and on this checkout. */
  before: number[];
  after: number[];
  /** The middle of each, which is what the change is measured between. */
  beforeMiddle: number;
  afterMiddle: number;
  /** The change between the middles, as a share of the earlier one. */
  change: number;
  /** Whether the two sets of repeats stayed clear of each other. */
  apart: boolean;
}

/** One scenario, as both commits measured it. */
export interface ScenarioComparison {
  name: string;
  description: string;
  beforeRepeats: number;
  afterRepeats: number;
  metrics: MetricComparison[];
}

/** Everything one comparison found. */
export interface AbReport {
  before: { commit: string; power: string[] };
  after: { commit: string; power: string[] };
  pacing: RunContext["pacing"];
  /** What to hold against the numbers because the two were powered differently. */
  powerMismatch: string | null;
  scenarios: ScenarioComparison[];
  finishedAt: string;
}

/** The middle value of `values`, which is not moved by one wild run. */
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

/**
 * What to say about two sides that were not powered alike, or null when they
 * were. A machine on its battery, or holding itself back to save power, draws
 * slower than the same machine on the wall, so a difference measured across
 * such a change is partly the wall socket. The runs are still reported: they
 * measured what they measured, and this says what to hold against them.
 *
 * @param before Every power state the earlier commit was measured under.
 * @param after The same for this checkout.
 * @returns The line to print above the numbers, or null.
 */
export const powerMismatch = (
  before: { commit: string; power: PowerState[] },
  after: { commit: string; power: PowerState[] },
): string | null => {
  const every = [...before.power, ...after.power];
  if (every.length === 0 || every.every((one) => samePower(one, every[0]))) {
    return null;
  }
  const side = (one: { commit: string; power: PowerState[] }): string =>
    `${one.commit} ${[...new Set(one.power.map(describePower))].join(", then ")}`;
  return [
    "the two were not powered alike, and a machine draws slower on its battery than on the wall:",
    `  ${side(before)}`,
    `  ${side(after)}`,
    "the numbers below stand as they were measured; a difference between them may be the power rather than the commit.",
  ].join("\n");
};

/** One metric read off both sides' repeats. */
const compareMetric = (
  metric: Metric,
  before: RunSummary[],
  after: RunSummary[],
): MetricComparison => {
  const beforeValues = before.map(metric.of);
  const afterValues = after.map(metric.of);
  const beforeMiddle = median(beforeValues);
  const afterMiddle = median(afterValues);
  return {
    name: metric.name,
    unit: metric.unit,
    before: beforeValues,
    after: afterValues,
    beforeMiddle,
    afterMiddle,
    change: changeBetween(beforeMiddle, afterMiddle),
    apart: standsApart(beforeValues, afterValues),
  };
};

/**
 * Everything the two sides measured, put side by side.
 *
 * @param before The commit measured against.
 * @param after This checkout.
 * @returns The comparison, ready to print or to draw.
 */
export const compareSides = (before: Side, after: Side): AbReport => {
  const scenarios: ScenarioComparison[] = [];
  for (const [name, afterRepeats] of after.repeats) {
    const beforeRepeats = before.repeats.get(name);
    if (beforeRepeats === undefined) {
      continue;
    }
    const metrics = [
      ...metricsFor(after.pacing),
      ...phaseMetrics([...beforeRepeats, ...afterRepeats]),
    ].map((metric) => compareMetric(metric, beforeRepeats, afterRepeats));
    scenarios.push({
      name,
      description: after.descriptions.get(name) ?? "",
      beforeRepeats: beforeRepeats.length,
      afterRepeats: afterRepeats.length,
      metrics,
    });
  }
  return {
    before: {
      commit: before.commit,
      power: [...new Set(before.power.map(describePower))],
    },
    after: {
      commit: after.commit,
      power: [...new Set(after.power.map(describePower))],
    },
    pacing: after.pacing,
    powerMismatch: powerMismatch(before, after),
    scenarios,
    finishedAt: new Date().toISOString(),
  };
};

/** Every metric that moved further than the repeats of one commit disagree. */
export const clearOfTheSpread = (
  report: AbReport,
): { scenario: string; metric: MetricComparison }[] =>
  report.scenarios
    .flatMap((scenario) =>
      scenario.metrics
        .filter((metric) => metric.apart)
        .map((metric) => ({ scenario: scenario.name, metric })),
    )
    .sort((a, b) => Math.abs(b.metric.change) - Math.abs(a.metric.change));
