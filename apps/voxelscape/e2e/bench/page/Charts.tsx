import { For, Show } from "solid-js";
import type { JSX } from "@solidjs/web/jsx-runtime";
import type { Series } from "./series.ts";

/** The plot's size in its own coordinates; the page scales it to fit. */
const WIDTH = 720;
const HEIGHT = 180;
/** Room for the value labels down the left and the time labels along the bottom. */
const PAD = { left: 56, right: 12, top: 10, bottom: 22 };

const plotWidth = WIDTH - PAD.left - PAD.right;
const plotHeight = HEIGHT - PAD.top - PAD.bottom;

/** A value marked on the scale beside a chart, for a threshold worth seeing. */
export interface Rule {
  at: number;
  label: string;
}

interface ChartProps {
  title: string;
  /** What the chart is for, in one line under its title. */
  caption: string;
  /** Seconds at each column, shared by every series. */
  at: number[];
  series: Series[];
  /** How a value is written out, on the scale and in the tooltips. */
  format: (value: number) => string;
  rule?: Rule;
  /** Whether the bands stack into a total, or each line stands on its own. */
  stacked?: boolean;
}

/** A round number of ticks covering nought to `most`. */
const scaleFor = (most: number): { top: number; ticks: number[] } => {
  if (!(most > 0)) {
    return { top: 1, ticks: [0, 1] };
  }
  const rough = most / 4;
  const size = Math.pow(10, Math.floor(Math.log10(rough)));
  const step = [1, 2, 2.5, 5, 10]
    .map((multiple) => multiple * size)
    .find((candidate) => candidate >= rough) as number;
  const top = Math.ceil(most / step) * step;
  const ticks: number[] = [];
  for (let value = 0; value <= top + step / 2; value += step) {
    ticks.push(value);
  }
  return { top, ticks };
};

/**
 * A chart of one run's frames: time along the bottom, the series' own unit up
 * the side. Stacked, the bands add up to the whole a frame cost; unstacked,
 * each line stands on its own scale-mate.
 *
 * There is no script on the page, so what a reader would otherwise hover for
 * is carried by the shape marks themselves: every band and line holds a title
 * the browser shows on hover, and the numbers behind the shapes are written
 * out in the table beside the chart.
 */
export function Chart(props: ChartProps): JSX.Element {
  const columns = props.at.length;
  const span = Math.max(props.at[columns - 1] ?? 1, 0.001);
  const x = (column: number): number =>
    PAD.left + (props.at[column] / span) * plotWidth;

  /** Each series' running total beneath it, so a stacked band starts on the one below. */
  const beneath: number[][] = [];
  const running = new Array(columns).fill(0);
  for (const series of props.series) {
    beneath.push([...running]);
    if (props.stacked === true) {
      series.values.forEach((value, column) => {
        running[column] += value;
      });
    }
  }

  /** The tallest a band or line reaches, counting the floor it stands on. */
  let most = props.rule?.at ?? 0;
  props.series.forEach((series, index) => {
    series.values.forEach((value, column) => {
      most = Math.max(most, value + beneath[index][column]);
    });
  });

  const scale = scaleFor(most);
  const y = (value: number): number =>
    PAD.top + plotHeight - (value / scale.top) * plotHeight;

  const bandPath = (series: Series, index: number): string => {
    const floor = beneath[index];
    const up = series.values
      .map((value, column) => `${x(column)},${y(value + floor[column])}`)
      .join(" L");
    const down = series.values
      .map((_, column) => columns - 1 - column)
      .map((column) => `${x(column)},${y(floor[column])}`)
      .join(" L");
    return `M${up} L${down} Z`;
  };

  const linePath = (series: Series): string =>
    series.values
      .map((value, column) => `${x(column)},${y(value)}`)
      .join(" L")
      .replace(/^/, "M");

  return (
    <figure class="chart">
      <figcaption>
        <h4>{props.title}</h4>
        <p>{props.caption}</p>
      </figcaption>
      <ul class="legend">
        <For each={props.series}>
          {(series) => (
            <li>
              <span class="swatch" data-slot={series.slot} />
              {series.name}
            </li>
          )}
        </For>
      </ul>
      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        role="img"
        preserveAspectRatio="none"
      >
        <For each={scale.ticks}>
          {(tick) => (
            <>
              <line
                class="grid"
                x1={PAD.left}
                x2={WIDTH - PAD.right}
                y1={y(tick)}
                y2={y(tick)}
              />
              <text class="tick" x={PAD.left - 8} y={y(tick) + 4}>
                {props.format(tick)}
              </text>
            </>
          )}
        </For>
        <Show when={props.rule}>
          {(rule) => (
            <>
              <line
                class="rule"
                x1={PAD.left}
                x2={WIDTH - PAD.right}
                y1={y(rule().at)}
                y2={y(rule().at)}
              />
              <text
                class="ruleLabel"
                x={WIDTH - PAD.right}
                y={y(rule().at) - 5}
              >
                {rule().label}
              </text>
            </>
          )}
        </Show>
        <For each={props.series}>
          {(series, index) => (
            <Show
              when={props.stacked === true}
              fallback={
                <path class="line" data-slot={series.slot} d={linePath(series)}>
                  <title>{series.name}</title>
                </path>
              }
            >
              <path
                class="band"
                data-slot={series.slot}
                d={bandPath(series, index())}
              >
                <title>{series.name}</title>
              </path>
            </Show>
          )}
        </For>
        <line
          class="axis"
          x1={PAD.left}
          x2={WIDTH - PAD.right}
          y1={PAD.top + plotHeight}
          y2={PAD.top + plotHeight}
        />
        <text class="tick" x={PAD.left} y={HEIGHT - 6} text-anchor="start">
          0s
        </text>
        <text
          class="tick"
          x={WIDTH - PAD.right}
          y={HEIGHT - 6}
          text-anchor="end"
        >
          {`${span.toFixed(1)}s`}
        </text>
      </svg>
    </figure>
  );
}

interface BarsProps {
  title: string;
  caption: string;
  values: number[];
  format: (value: number) => string;
  rule?: Rule;
}

/**
 * A chart of something that happens on some frames and not others — an upload
 * lands on a handful of a run's frames — where a line between the landings
 * would draw a slope that never happened.
 */
export function Bars(props: BarsProps): JSX.Element {
  const values = props.values;
  const scale = scaleFor(Math.max(props.rule?.at ?? 0, ...values, 1));
  const y = (value: number): number =>
    PAD.top + plotHeight - (value / scale.top) * plotHeight;
  const width = plotWidth / Math.max(1, values.length);

  return (
    <figure class="chart">
      <figcaption>
        <h4>{props.title}</h4>
        <p>{props.caption}</p>
      </figcaption>
      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        role="img"
        preserveAspectRatio="none"
      >
        <For each={scale.ticks}>
          {(tick) => (
            <>
              <line
                class="grid"
                x1={PAD.left}
                x2={WIDTH - PAD.right}
                y1={y(tick)}
                y2={y(tick)}
              />
              <text class="tick" x={PAD.left - 8} y={y(tick) + 4}>
                {props.format(tick)}
              </text>
            </>
          )}
        </For>
        <Show when={props.rule}>
          {(rule) => (
            <>
              <line
                class="rule"
                x1={PAD.left}
                x2={WIDTH - PAD.right}
                y1={y(rule().at)}
                y2={y(rule().at)}
              />
              <text
                class="ruleLabel"
                x={WIDTH - PAD.right}
                y={y(rule().at) - 5}
              >
                {rule().label}
              </text>
            </>
          )}
        </Show>
        <For each={values}>
          {(value, column) => (
            <Show when={value > 0}>
              <rect
                class="bar"
                data-slot={1}
                x={PAD.left + column() * width}
                y={y(value)}
                width={Math.max(1.5, width - 1)}
                height={PAD.top + plotHeight - y(value)}
                rx={1}
              >
                <title>{props.format(value)}</title>
              </rect>
            </Show>
          )}
        </For>
        <line
          class="axis"
          x1={PAD.left}
          x2={WIDTH - PAD.right}
          y1={PAD.top + plotHeight}
          y2={PAD.top + plotHeight}
        />
      </svg>
    </figure>
  );
}
