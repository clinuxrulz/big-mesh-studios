import { For, Show } from "solid-js";
import type { JSX } from "@solidjs/web/jsx-runtime";
import { clearOfTheSpread } from "../ab-report.ts";
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
  const marks = (side: number[], middle: number, slot: number): JSX.Element => (
    <For each={side}>
      {(value) => (
        <rect
          class="run"
          data-slot={slot}
          x={x(value) - 1.5}
          y={value === middle ? 4 : 7}
          width="3"
          height={value === middle ? 14 : 8}
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
      <line class="axis" x1="0" y1={HEIGHT - 3} x2={WIDTH} y2={HEIGHT - 3} />
      {marks(props.metric.before, props.metric.beforeMiddle, 1)}
      {marks(props.metric.after, props.metric.afterMiddle, 2)}
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
    <section class="scenario">
      <h2>{props.scenario.name}</h2>
      <p class="lede">{props.scenario.description}</p>
      <p class="meta">
        {`${props.scenario.beforeRepeats} repeats of ${props.before} against ${props.scenario.afterRepeats} of ${props.after}`}
      </p>
      <table class="metrics">
        <thead>
          <tr>
            <th scope="col">metric</th>
            <th scope="col">{props.before}</th>
            <th scope="col">{props.after}</th>
            <th scope="col">change</th>
            <th scope="col">every repeat, on one scale</th>
          </tr>
        </thead>
        <tbody>
          <For each={props.scenario.metrics}>
            {(metric) => (
              <tr data-apart={metric.apart ? "yes" : "no"}>
                <th scope="row">{metric.name}</th>
                <td>{show(metric.beforeMiddle, metric.unit)}</td>
                <td>{show(metric.afterMiddle, metric.unit)}</td>
                <td>{percent(metric.change)}</td>
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
  return (
    <main class="viz-root">
      <header>
        <h1>{`${props.report.before.commit} against ${props.report.after.commit}`}</h1>
        <p class="lede">
          {`frames ${props.report.pacing} · ${props.report.before.commit} ${props.report.before.power.join(", then ")} · ${props.report.after.commit} ${props.report.after.power.join(", then ")}`}
        </p>
        <p class="meta">{props.report.finishedAt}</p>
      </header>
      <Show when={props.report.powerMismatch}>
        {(mismatch) => <pre class="mismatch">{mismatch()}</pre>}
      </Show>
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
                  <span class="by">{percent(one.metric.change)}</span>
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
