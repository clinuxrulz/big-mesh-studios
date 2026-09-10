import { For, Show } from "solid-js";
import type { JSX } from "@solidjs/web/jsx-runtime";
import { clearOfTheSpread } from "../ab-report.ts";
import { anchorFor, Contents } from "./Contents.tsx";
import type { ContentsEntry } from "./Contents.tsx";
import type {
  AbReport,
  MetricComparison,
  ScenarioComparison,
} from "../ab-report.ts";
import { show } from "../metrics.ts";

/** The plot's size in its own coordinates; the page scales it to fit. */
const WIDTH = 320;
const HEIGHT = 22;
/** Room at each end for a mark drawn on the lowest or highest value. */
const PAD = 5;
/** Half the narrowest scale a row is drawn to, as a share of what it measures. */
const NARROWEST = 0.05;

/** How a change reads as a percentage, signed. */
const percent = (change: number): string =>
  `${change >= 0 ? "+" : ""}${(change * 100).toFixed(1)}%`;

/**
 * A commit, in the colour its marks are drawn in. The comparison names both
 * commits in a dozen places and every one of them is a question of which side
 * is being talked about, so the colour answers it wherever it is asked rather
 * than only in the plots.
 */
function Commit(props: { sha: string; slot: 1 | 2 }): JSX.Element {
  return (
    <span class="commit" data-slot={props.slot}>
      {props.sha}
    </span>
  );
}

/**
 * One metric's repeats from both commits on one scale: every run that was
 * measured, as a mark, with the middle of each side raised.
 *
 * This is the picture the whole comparison turns on. Two runs of the same
 * commit disagree, so the question a reader has is never "did the number
 * move" but "did it move further than the same commit moves on its own" —
 * which is to say, do the two rows of marks overlap.
 */
function Spread(props: { metric: MetricComparison }): JSX.Element {
  const values = [...props.metric.before, ...props.metric.after];
  // Neither side carried this column, so there is nothing to place on a scale.
  if (values.length === 0) {
    return <></>;
  }
  const low = Math.min(...values);
  const high = Math.max(...values);
  // The scale is the values' own range, but never narrower than a small share
  // of what is being measured. Drawn to the range alone, runs that agreed to
  // the last decimal would spread across the whole width and a number that
  // did not move would look as though it had.
  const middle = (props.metric.beforeMiddle + props.metric.afterMiddle) / 2;
  const half = Math.max((high - low) / 2, Math.abs(middle) * NARROWEST, 1e-9);
  const centre = (low + high) / 2;
  const x = (value: number): number =>
    PAD + ((value - (centre - half)) / (half * 2)) * (WIDTH - PAD * 2);
  // Each commit keeps its own lane. Sharing one would hide a side entirely
  // wherever the two measured the same thing, which is the most common
  // outcome of all and the one a reader most needs to see.
  const marks = (
    side: number[],
    middle: number,
    slot: number,
    lane: number,
  ): JSX.Element => (
    <For each={side}>
      {(value) => (
        <rect
          class="run"
          data-slot={slot}
          x={x(value) - 1.5}
          y={value === middle ? lane : lane + 2}
          width="3"
          height={value === middle ? 9 : 5}
        >
          <title>{show(value, props.metric.unit)}</title>
        </rect>
      )}
    </For>
  );
  return (
    <svg
      class="spread"
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      role="img"
      preserveAspectRatio="none"
      aria-label={`${props.metric.name}: ${show(props.metric.beforeMiddle, props.metric.unit)} against ${show(props.metric.afterMiddle, props.metric.unit)}`}
    >
      <line class="axis" x1="0" y1={HEIGHT - 1} x2={WIDTH} y2={HEIGHT - 1} />
      {marks(props.metric.before, props.metric.beforeMiddle, 1, 1)}
      {marks(props.metric.after, props.metric.afterMiddle, 2, 11)}
    </svg>
  );
}

/** Every metric of one scenario, the ones that stand apart marked as such. */
function Scenario(props: {
  scenario: ScenarioComparison;
  before: string;
  after: string;
}): JSX.Element {
  return (
    <section class="scenario" id={anchorFor(props.scenario.name)}>
      <h2>{props.scenario.name}</h2>
      <p class="lede">{props.scenario.description}</p>
      <p class="meta">
        {`${props.scenario.beforeRepeats} repeats of `}
        <Commit sha={props.before} slot={1} />
        {` against ${props.scenario.afterRepeats} of `}
        <Commit sha={props.after} slot={2} />
        {
          ". Each mark is one repeat, and the taller mark is the middle of them."
        }
      </p>
      <table class="metrics">
        <thead>
          <tr>
            <th scope="col">metric</th>
            <th scope="col">
              <Commit sha={props.before} slot={1} />
            </th>
            <th scope="col">
              <Commit sha={props.after} slot={2} />
            </th>
            <th scope="col">change</th>
            <th scope="col">every repeat, on one scale</th>
          </tr>
        </thead>
        <tbody>
          <For each={props.scenario.metrics}>
            {(metric) => (
              <tr data-apart={metric.apart ? "yes" : "no"}>
                <th scope="row">{metric.name}</th>
                <td>
                  {metric.beforeMeasured
                    ? show(metric.beforeMiddle, metric.unit)
                    : "not measured"}
                </td>
                <td>
                  {metric.afterMeasured
                    ? show(metric.afterMiddle, metric.unit)
                    : "not measured"}
                </td>
                <td>{metric.change === null ? "" : percent(metric.change)}</td>
                <td class="plot">
                  <Spread metric={metric} />
                </td>
              </tr>
            )}
          </For>
        </tbody>
      </table>
    </section>
  );
}

/** A comparison of two commits, drawn as a page. */
export function Ab(props: { report: AbReport }): JSX.Element {
  const clear = clearOfTheSpread(props.report);
  const contents = (): ContentsEntry[] =>
    props.report.scenarios.map((scenario) => ({
      id: anchorFor(scenario.name),
      label: scenario.name,
    }));
  return (
    <main class="viz-root">
      <header>
        <h1>
          <Commit sha={props.report.before.commit} slot={1} />
          {" against "}
          <Commit sha={props.report.after.commit} slot={2} />
        </h1>
        <p class="lede">
          {`frames ${props.report.pacing} · `}
          <Commit sha={props.report.before.commit} slot={1} />
          {` ${props.report.before.power.join(", then ")} · `}
          <Commit sha={props.report.after.commit} slot={2} />
          {` ${props.report.after.power.join(", then ")}`}
        </p>
        <p class="meta">{props.report.finishedAt}</p>
      </header>
      <Show when={props.report.powerMismatch !== null}>
        <p class="mismatch">
          The two were not powered alike, and a machine draws slower on its
          battery than on the wall:{" "}
          <Commit sha={props.report.before.commit} slot={1} />
          {` ${props.report.before.power.join(", then ")}, `}
          <Commit sha={props.report.after.commit} slot={2} />
          {` ${props.report.after.power.join(", then ")}. `}
          The numbers below stand as they were measured; a difference between
          them may be the power rather than the commit.
        </p>
      </Show>
      <Contents entries={contents()} />
      <section class="verdict">
        <h2>Clear of the run-to-run spread</h2>
        <p class="lede">
          A change is only worth reading when the repeats of one commit stay
          clear of the repeats of the other. Everything else moved by less than
          two runs of the same commit do.
        </p>
        <Show
          when={clear.length > 0}
          fallback={<p class="empty">Nothing did.</p>}
        >
          <ul class="clear">
            <For each={clear}>
              {(one) => (
                <li>
                  <span class="where">{one.scenario}</span>
                  <span class="what">{one.metric.name}</span>
                  <span class="from">
                    {`${show(one.metric.beforeMiddle, one.metric.unit)} → ${show(one.metric.afterMiddle, one.metric.unit)}`}
                  </span>
                  <span class="by">{percent(one.metric.change ?? 0)}</span>
                </li>
              )}
            </For>
          </ul>
        </Show>
      </section>
      <For each={props.report.scenarios}>
        {(scenario) => (
          <Scenario
            scenario={scenario}
            before={props.report.before.commit}
            after={props.report.after.commit}
          />
        )}
      </For>
    </main>
  );
}
