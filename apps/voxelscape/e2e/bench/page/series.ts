import type { RunSamples } from "../report.ts";

/**
 * How many columns a chart is drawn with at most. A run measured without the
 * display pacing it records thousands of frames, and a chart three hundred
 * pixels wide cannot show them one by one.
 */
const MAX_COLUMNS = 480;

/** One frame, with every column the probe recorded, addressed by name. */
export interface Frame {
  /** Seconds since the run's first frame. */
  at: number;
  value(column: string): number;
}

/**
 * The frames of a run, thinned to at most `MAX_COLUMNS` of them.
 *
 * Each column that survives is a whole real frame — the one in its slice that
 * cost the main thread most — rather than an average of the slice. Averaging
 * would flatten exactly the spikes a run is read for, and mixing averages
 * across columns would let a stacked chart show a frame that never happened.
 */
export const framesOf = (samples: RunSamples): Frame[] => {
  const columnOf = (name: string): number => {
    const field = samples.fieldNames.indexOf(name);
    return field >= 0
      ? field
      : samples.fieldNames.length + samples.phaseNames.indexOf(name);
  };
  const count = Math.floor(samples.rows.length / samples.rowStride);
  const read = (frame: number, name: string): number =>
    samples.rows[frame * samples.rowStride + columnOf(name)];

  /** Where each frame sits in the run, from the gaps between them. */
  const seconds: number[] = [];
  let elapsed = 0;
  for (let frame = 0; frame < count; frame++) {
    elapsed += read(frame, "gapMs") / 1000;
    seconds.push(elapsed);
  }

  const cost = (frame: number): number =>
    read(frame, "advance") + read(frame, "occlusion") + read(frame, "draw");

  const perColumn = Math.max(1, Math.ceil(count / MAX_COLUMNS));
  const frames: Frame[] = [];
  for (let start = 0; start < count; start += perColumn) {
    let worst = start;
    for (
      let frame = start;
      frame < Math.min(count, start + perColumn);
      frame++
    ) {
      if (cost(frame) > cost(worst)) {
        worst = frame;
      }
    }
    frames.push({
      at: seconds[worst],
      value: (column) => read(worst, column),
    });
  }
  return frames;
};

/** One line or band of a chart: what it is called, and its value each frame. */
export interface Series {
  name: string;
  /** Which categorical slot paints it, counted from 1. */
  slot: number;
  values: number[];
}

/**
 * The stretches of a frame that do not contain one another, so their heights
 * can be stacked into the frame's whole cost without counting any of it twice.
 * `advance` holds the world's own phases and `rendererTick` holds the two
 * inside it, so each of those contributes only what its children do not.
 */
export const phaseBands = (frames: Frame[]): Series[] => {
  const at = (frame: Frame, column: string): number => frame.value(column);
  const rendererOther = (frame: Frame): number =>
    Math.max(
      0,
      at(frame, "rendererTick") - at(frame, "merge") - at(frame, "meshDrain"),
    );
  const worldOwn = (frame: Frame): number =>
    at(frame, "player") +
    at(frame, "scroll") +
    at(frame, "flow") +
    at(frame, "multiplayer") +
    at(frame, "environment");
  const worldOther = (frame: Frame): number =>
    Math.max(
      0,
      at(frame, "advance") -
        worldOwn(frame) -
        at(frame, "monsters") -
        at(frame, "rendererTick"),
    );
  return [
    { name: "draw", slot: 1, values: frames.map((f) => at(f, "draw")) },
    {
      name: "occlusion pass",
      slot: 2,
      values: frames.map((f) => at(f, "occlusion")),
    },
    {
      name: "merging geometry",
      slot: 3,
      values: frames.map((f) => at(f, "merge") + at(f, "meshDrain")),
    },
    { name: "renderer", slot: 4, values: frames.map(rendererOther) },
    { name: "monsters", slot: 5, values: frames.map((f) => at(f, "monsters")) },
    {
      name: "the rest of the world",
      slot: 6,
      values: frames.map((f) => worldOwn(f) + worldOther(f)),
    },
  ];
};

/** How deep each of the world's queues stood, frame by frame. */
export const queueLines = (frames: Frame[]): Series[] =>
  [
    { name: "fills waiting", slot: 1, column: "fillPending" },
    { name: "fills in flight", slot: 2, column: "fillInFlight" },
    { name: "meshes waiting", slot: 3, column: "meshPending" },
    { name: "meshes in flight", slot: 4, column: "meshInFlight" },
    { name: "superchunks dirty", slot: 5, column: "dirtySuperchunks" },
  ].map((line) => ({
    name: line.name,
    slot: line.slot,
    values: frames.map((frame) => frame.value(line.column)),
  }));

/** What the world holds in main memory, split into the two things it holds. */
export const memoryBands = (frames: Frame[]): Series[] => [
  {
    name: "voxels and light",
    slot: 1,
    values: frames.map((frame) => frame.value("voxelBytes")),
  },
  {
    name: "geometry",
    slot: 2,
    values: frames.map((frame) => frame.value("geometryBytes")),
  },
];

/**
 * Bytes sent to the graphics card each frame. Unlike the other charts a column
 * here takes the largest frame in its slice rather than the costliest, because
 * an upload lands on a handful of frames in a run and the costliest frame is
 * usually not one of them.
 */
export const uploadBars = (samples: RunSamples, columns: number): number[] => {
  const field = samples.fieldNames.indexOf("uploadBytes");
  const count = Math.floor(samples.rows.length / samples.rowStride);
  const perColumn = Math.max(1, Math.ceil(count / columns));
  const bars: number[] = [];
  for (let start = 0; start < count; start += perColumn) {
    let most = 0;
    for (
      let frame = start;
      frame < Math.min(count, start + perColumn);
      frame++
    ) {
      most = Math.max(most, samples.rows[frame * samples.rowStride + field]);
    }
    bars.push(most);
  }
  return bars;
};
