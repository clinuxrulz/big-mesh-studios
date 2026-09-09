import { For, Show } from "solid-js";
import type { JSX } from "@solidjs/web/jsx-runtime";
import { representative } from "../report.ts";
import type { BenchReport, RunSamples, ScenarioReport } from "../report.ts";
import type { RunSummary } from "../summarize.ts";
import type { TraceSummary } from "../trace.ts";
import { Bars, Chart } from "./Charts.tsx";
import { describePower } from "../power.ts";
import { lateFrames, uploadsOverBudget } from "./late.ts";
import {
  framesOf,
  memoryBands,
  phaseBands,
  queueLines,
  uploadBars,
} from "./series.ts";

/** A sixtieth of a second, the frame every run is asked to fit inside. */
const FRAME_BUDGET_MS = 1000 / 60;

/** The upload budget one frame is paced against, from the renderer. */
const UPLOAD_BUDGET_BYTES = 2 * 1024 * 1024;

const ms = (value: number): string => `${value.toFixed(value < 10 ? 1 : 0)}ms`;
const megabytes = (bytes: number): string =>
  `${(bytes / (1024 * 1024)).toFixed(0)}MB`;
const count = (value: number): string => value.toFixed(0);
const percent = (share: number): string => `${(share * 100).toFixed(1)}%`;

/** One headline number, with the words that say what it is. */
function Tile(props: {
  label: string;
  value: string;
  note?: string;
  tone?: "plain" | "warning" | "critical";
}): JSX.Element {
  return (
    <div class="tile" data-tone={props.tone ?? "plain"}>
      <dt>{props.label}</dt>
      <dd>{props.value}</dd>
      <Show when={props.note}>{(note) => <small>{note()}</small>}</Show>
    </div>
  );
}

/** How a scenario's headline numbers read, given how it was paced. */
function Tiles(props: {
  run: RunSummary;
  scenario: ScenarioReport;
  paced: boolean;
}): JSX.Element {
  const late = () => (props.paced ? props.run.drops : props.run.overBudget);
  const share = () => props.run.mainThread.median / FRAME_BUDGET_MS;
  return (
    <dl class="tiles">
      <Tile
        label="main thread a frame"
        value={ms(props.run.mainThread.median)}
        note={`${percent(share())} of a sixtieth of a second`}
        tone={share() > 0.75 ? "critical" : share() > 0.5 ? "warning" : "plain"}
      />
      <Tile
        label="worst frame"
        value={ms(props.run.mainThread.max)}
        note={`${percent(props.run.mainThread.max / FRAME_BUDGET_MS)} of one frame`}
        tone={props.run.mainThread.max > FRAME_BUDGET_MS ? "warning" : "plain"}
      />
      <Tile
        label={props.paced ? "frames dropped" : "frames over budget"}
        value={count(late().count)}
        note={`${percent(late().share)}, longest run ${late().longestRun}`}
        tone={late().share > 0.05 ? "warning" : "plain"}
      />
      <Show
        when={props.run.gpu.count > 0}
        fallback={
          <Tile
            label="graphics card"
            value="not timed"
            note="no reading came back"
          />
        }
      >
        <Tile
          label="card, drawing"
          value={ms(props.run.gpu.median)}
          note={
            props.run.gpuOcclusion.count > 0
              ? `occlusion pass ${ms(props.run.gpuOcclusion.median)}`
              : undefined
          }
        />
      </Show>
      <Tile
        label="held in memory"
        value={megabytes(props.run.resident.maxBytes)}
        note={`${megabytes(props.run.resident.geometryBytes)} of it geometry`}
      />
      <Tile
        label="sent to the card"
        value={megabytes(props.run.upload.totalBytes)}
        note={`most ${megabytes(props.run.upload.maxFrameBytes)} in one frame`}
        tone={
          props.run.upload.maxFrameBytes > UPLOAD_BUDGET_BYTES
            ? "warning"
            : "plain"
        }
      />
    </dl>
  );
}

/**
 * The numbers behind the shapes. Three of the light-mode series colours sit
 * below the contrast a small mark needs, so the figures they stand for are
 * written out here as well as drawn.
 */
function Numbers(props: {
  run: RunSummary;
  scenario: ScenarioReport;
}): JSX.Element {
  const rows = (): [string, string][] => [
    ["frames recorded", count(props.run.frames)],
    [
      "gap between frames",
      `${ms(props.run.gap.median)} typical, ${ms(props.run.gap.p95)} at the 95th, ${ms(props.run.gap.max)} worst`,
    ],
    [
      "render scale",
      `${props.run.scale.median.toFixed(3)}x, lowest ${props.run.scale.min.toFixed(3)}x`,
    ],
    ["triangles drawn", props.run.triangles.median.toLocaleString()],
    [
      "occlusion pass",
      `${count(props.run.culling.occluded)} superchunks hidden, ${count(props.run.culling.visible)} drawn`,
    ],
    [
      "terrain",
      `${props.run.counters.fillsRequested} blocks asked for, ${props.run.counters.fillsLanded} arrived`,
    ],
    [
      "geometry",
      `${props.run.counters.merges} merges, ${props.run.counters.fullRejoins} of them whole rebuilds, ${props.run.counters.uploads} uploads`,
    ],
    [
      "queues at their deepest",
      `${props.run.queues.fillPending} fills waiting, ${props.run.queues.fillInFlight} in flight, ${props.run.queues.dirtySuperchunks} superchunks dirty`,
    ],
    [
      "held in memory",
      `${megabytes(props.run.resident.voxelBytes)} voxels and light, ${megabytes(props.run.resident.geometryBytes)} geometry`,
    ],
    [
      "javascript heap",
      `${megabytes(props.run.heap.startBytes)} to ${megabytes(props.run.heap.endBytes)}, peak ${megabytes(props.run.heap.maxBytes)}`,
    ],
    [
      "travelled",
      `${props.run.travel.pathUnits.toFixed(0)} units of the ${props.scenario.expectedUnits.toFixed(0)} asked for`,
    ],
    [
      "standing on terrain that had not arrived",
      props.run.outrun.frames === 0
        ? "never"
        : `${props.run.outrun.frames} frames, longest ${props.run.outrun.longestRun} in a row`,
    ],
  ];
  return (
    <table class="numbers">
      <tbody>
        <For each={rows()}>
          {([label, value]) => (
            <tr>
              <th scope="row">{label}</th>
              <td>{value}</td>
            </tr>
          )}
        </For>
      </tbody>
    </table>
  );
}

/**
 * The frames that cost more than a sixtieth of a second, and what each was
 * doing. The charts show the shape of a run; a run is judged by these.
 */
function LateFrames(props: { scenario: ScenarioReport }): JSX.Element {
  const samples = props.scenario.samples;
  const late =
    samples === undefined ? [] : lateFrames(samples, FRAME_BUDGET_MS, 8);
  return (
    <Show
      when={late.length > 0}
      fallback={
        <p class="empty">
          No frame in this run cost the main thread more than a sixtieth of a
          second.
        </p>
      }
    >
      <table class="frames">
        <caption>
          The frames that went over, costliest first — one run's worth, the same
          run the charts above are drawn from.
        </caption>
        <thead>
          <tr>
            <th scope="col">at</th>
            <th scope="col">main thread</th>
            <th scope="col">gap</th>
            <th scope="col">uploaded</th>
            <th scope="col">merges</th>
            <th scope="col">where it went</th>
          </tr>
        </thead>
        <tbody>
          <For each={late}>
            {(frame) => (
              <tr>
                <td>{`${frame.at.toFixed(1)}s`}</td>
                <td>{ms(frame.mainMs)}</td>
                <td>{ms(frame.gapMs)}</td>
                <td>
                  {frame.uploadBytes === 0 ? "—" : megabytes(frame.uploadBytes)}
                </td>
                <td>{frame.merges === 0 ? "—" : count(frame.merges)}</td>
                <td class="spent">
                  {frame.spent
                    .map((phase) => `${phase.name} ${ms(phase.ms)}`)
                    .join(" · ")}
                </td>
              </tr>
            )}
          </For>
        </tbody>
      </table>
    </Show>
  );
}

function Scenario(props: {
  scenario: ScenarioReport;
  paced: boolean;
}): JSX.Element {
  const run = representative(props.scenario.repeats);
  const frames =
    props.scenario.samples === undefined
      ? []
      : framesOf(props.scenario.samples);
  const at = frames.map((frame) => frame.at);
  /** How the run fared against the budget one frame's uploads are paced to. */
  const overBudget = (samples: RunSamples): string => {
    const over = uploadsOverBudget(samples, UPLOAD_BUDGET_BYTES);
    return over === 0
      ? `No frame sent more than the ${megabytes(UPLOAD_BUDGET_BYTES)} a frame is paced to.`
      : `${count(over)} ${over === 1 ? "frame sent" : "frames sent"} more than the ${megabytes(UPLOAD_BUDGET_BYTES)} a frame is paced to, in one go.`;
  };
  const phases = phaseBands(frames);
  const memory = memoryBands(frames);
  const queues = queueLines(frames);

  return (
    <section class="scenario">
      <h2>{props.scenario.name}</h2>
      <p class="lede">{props.scenario.description}</p>
      <Tiles run={run} scenario={props.scenario} paced={props.paced} />
      <Show
        when={frames.length > 0}
        fallback={<p class="empty">This run kept no frames to draw.</p>}
      >
        <Chart
          title="Where each frame went"
          caption="The stretches of one frame that do not contain one another, stacked into what the frame cost the main thread. Each column is a whole real frame — the costliest in its slice of the run — so a tall column is a frame that happened."
          at={at}
          series={phases}
          format={ms}
          rule={{ at: FRAME_BUDGET_MS, label: "one frame at 60 a second" }}
          stacked
        />
        <Chart
          title="What the world held"
          caption="Voxels, the light shadowing them, and the geometry built from both — counted rather than sampled, so this is the same number on any machine."
          at={at}
          series={memory}
          format={megabytes}
          stacked
        />
        <Chart
          title="What the world was waiting for"
          caption="How deep each queue stood. Fills waiting far above fills in flight means the window is asking for terrain faster than the workers can generate it."
          at={at}
          series={queues}
          format={count}
        />
        <Show when={props.scenario.samples}>
          {(samples) => (
            <Bars
              title="What was sent to the graphics card"
              caption={`Bytes uploaded, frame by frame. A column here is the largest frame in its slice, because an upload lands on a handful of a run's frames and the costliest frame is rarely one of them. ${overBudget(samples())}`}
              values={uploadBars(samples(), at.length)}
              format={megabytes}
              rule={{
                at: UPLOAD_BUDGET_BYTES,
                label: "the budget one frame is paced against",
              }}
            />
          )}
        </Show>
      </Show>
      <Numbers run={run} scenario={props.scenario} />
      <LateFrames scenario={props.scenario} />
    </section>
  );
}

function Trace(props: { trace: TraceSummary }): JSX.Element {
  const last = () => props.trace.memory[props.trace.memory.length - 1] ?? [];
  const first = () => props.trace.memory[0] ?? [];
  const worthReading = () =>
    last().filter(
      (process) =>
        process.process === "Renderer" || process.process === "GPU Process",
    );
  return (
    <section class="trace">
      <h3>What the browser itself was holding and doing</h3>
      <div class="traceGrid">
        <table class="numbers">
          <caption>Where the graphics process spent its time</caption>
          <tbody>
            <For each={props.trace.graphicsSlices.slice(0, 8)}>
              {(slice) => (
                <tr>
                  <th scope="row">{slice.name}</th>
                  <td>{`${slice.totalMs.toFixed(0)}ms over ${slice.count} calls`}</td>
                </tr>
              )}
            </For>
          </tbody>
        </table>
        <For each={worthReading()}>
          {(process) => (
            <table class="numbers">
              <caption>{process.process}</caption>
              <tbody>
                <For each={process.roots}>
                  {(root) => (
                    <tr>
                      <th scope="row">{root.name}</th>
                      <td>
                        {`${megabytes(
                          first()
                            .find((was) => was.pid === process.pid)
                            ?.roots.find((was) => was.name === root.name)
                            ?.bytes ?? 0,
                        )} → ${megabytes(root.bytes)}`}
                      </td>
                    </tr>
                  )}
                </For>
                <Show when={process.webgl.length > 0}>
                  <tr>
                    <th scope="row">this page's own graphics objects</th>
                    <td>
                      {process.webgl
                        .map((kind) => `${kind.name} ${megabytes(kind.bytes)}`)
                        .join(", ")}
                    </td>
                  </tr>
                </Show>
              </tbody>
            </table>
          )}
        </For>
      </div>
    </section>
  );
}

/** The whole report: how it was measured, then a section for each scenario. */
export function App(props: {
  report: BenchReport;
  traces: TraceSummary[];
}): JSX.Element {
  const context = () => props.report.context;
  return (
    <main class="viz-root">
      <header>
        <h1>voxelscape, measured</h1>
        <p class="lede">
          {`${context().profile} profile`}
          {context().cpuThrottle > 1
            ? `, processor slowed ${context().cpuThrottle} times`
            : ""}
          {` · frames ${context().pacing}`}
          {context().monsters === false ? " · no monsters" : ""}
          {context().power === undefined
            ? ""
            : ` · ${describePower(context().power)}`}
          {context().adaptiveResolution
            ? " · resolution adapting"
            : ` · scale pinned at ${context().pinnedScale}`}
        </p>
        <p class="meta">
          {`${context().graphicsCard} · ${context().cores} threads · `}
          {`${context().viewport.width}×${context().viewport.height} · `}
          {`radius ${context().chunkRadius} (${context().blockCount} blocks) · `}
          {context().workers}
        </p>
        <p class="meta">
          {`commit ${context().commit}${context().dirty ? ", working tree dirty" : ""} · ${context().finishedAt}`}
        </p>
      </header>
      <For each={props.report.scenarios}>
        {(scenario) => (
          <Scenario scenario={scenario} paced={context().pacing === "paced"} />
        )}
      </For>
      <For each={props.traces}>{(trace) => <Trace trace={trace} />}</For>
    </main>
  );
}
