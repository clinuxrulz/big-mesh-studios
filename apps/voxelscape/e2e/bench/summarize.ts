import type { PerfDrain } from "../../src/render/perf-probe.ts";

/**
 * How much longer than the run's own median a frame's gap has to be before it
 * counts as dropped. The median is the display's refresh period on any run
 * that mostly keeps up, so this asks whether a frame arrived late enough to
 * have missed a whole refresh rather than assuming a rate the display may not
 * have.
 */
const DROP_FACTOR = 1.5;

/** A sixtieth of a second: the frame every profile is asked to fit inside. */
const FRAME_BUDGET_MS = 1000 / 60;

/** A set of measurements reduced to the shape of its distribution. */
export interface Spread {
  count: number;
  median: number;
  p95: number;
  p99: number;
  max: number;
  mean: number;
}

/** How often frames arrived late, and how badly. */
export interface Drops {
  /** Frames whose gap exceeded the drop threshold. */
  count: number;
  /** Those frames as a share of every frame in the run. */
  share: number;
  /** The longest unbroken stretch of them, in frames. */
  longestRun: number;
  /** The gap a frame had to exceed to count, in milliseconds. */
  thresholdMs: number;
}

/** What one scenario run measured. */
export interface RunSummary {
  frames: number;
  durationMs: number;
  /** True when the run outlasted the probe's ring and its earliest frames are gone. */
  wrapped: boolean;
  /** Milliseconds between animation callbacks. */
  gap: Spread;
  /** Milliseconds the graphics card spent drawing the scene. */
  gpu: Spread;
  /** Milliseconds the graphics card spent on the occlusion pass. */
  gpuOcclusion: Spread;
  /**
   * Milliseconds of main-thread work a frame: the world's tick, the occlusion
   * pass and the draw call together. Unlike the gap, this is not held down by
   * the display's refresh rate, so it shows what the frame costs even when
   * every frame arrives on time.
   */
  mainThread: Spread;
  drops: Drops;
  /** The render scale the frames were drawn at, where 1 is the display resolution. */
  scale: { min: number; median: number };
  /** Each phase's milliseconds a frame, keyed by the phase's name. */
  phases: Record<string, Spread>;
  /** Each counter's total for the run, keyed by the counter's name. */
  counters: Record<string, number>;
  /** The deepest each queue got during the run. */
  queues: {
    fillPending: number;
    fillInFlight: number;
    meshPending: number;
    meshInFlight: number;
    dirtySuperchunks: number;
  };
  upload: {
    totalBytes: number;
    maxFrameBytes: number;
    framesWithUpload: number;
    /** Superchunks merged in the frame that uploaded the most. */
    mergesInBiggestFrame: number;
    /** The most superchunks merged in any one frame. */
    maxFrameMerges: number;
  };
  triangles: { median: number; max: number };
  /** What the occlusion pass hid against what it left to draw. */
  culling: {
    occluded: number;
    visible: number;
    drawnMeshes: number;
  };
  heap: { startBytes: number; endBytes: number; maxBytes: number };
  /** Bytes of voxels, light and geometry the world holds, counted rather than sampled. */
  resident: {
    startBytes: number;
    endBytes: number;
    maxBytes: number;
    /** The voxels and their light, at the moment the run held most. */
    voxelBytes: number;
    /** The superchunks' merged geometry, at the same moment. */
    mergedGeometryBytes: number;
    /** The per-block meshes the merge reads from, at the same moment. */
    blockGeometryBytes: number;
  };
  /**
   * Frames that cost more than a sixtieth of a second, against a fixed
   * threshold rather than the run's own median. This is the count that means
   * the same thing whether or not the display was pacing the frames.
   */
  overBudget: Drops;
  /** How far the player actually went, along their path and end to end. */
  travel: { pathUnits: number; straightUnits: number };
  /** How much of the run the player spent on terrain that had not streamed in. */
  outrun: { frames: number; share: number; longestRun: number };
}

const percentile = (sorted: number[], fraction: number): number => {
  if (sorted.length === 0) {
    return 0;
  }
  const at = Math.min(sorted.length - 1, Math.floor(sorted.length * fraction));
  return sorted[at];
};

/** Reduces one column of measurements to its median, tail and mean. */
export const spreadOf = (values: number[]): Spread => {
  const sorted = [...values].sort((a, b) => a - b);
  const total = sorted.reduce((sum, value) => sum + value, 0);
  return {
    count: sorted.length,
    median: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    p99: percentile(sorted, 0.99),
    max: sorted.length === 0 ? 0 : sorted[sorted.length - 1],
    mean: sorted.length === 0 ? 0 : total / sorted.length,
  };
};

/**
 * Counts the frames whose gap exceeded `threshold`, and the longest unbroken
 * stretch of them. Given no threshold it takes the run's own median gap as the
 * refresh period and asks which frames missed one.
 */
export const dropsIn = (gaps: number[], threshold?: number): Drops => {
  const thresholdMs = threshold ?? spreadOf(gaps).median * DROP_FACTOR;
  let count = 0;
  let run = 0;
  let longestRun = 0;
  for (const gap of gaps) {
    if (gap > thresholdMs) {
      count++;
      run++;
      longestRun = Math.max(longestRun, run);
    } else {
      run = 0;
    }
  }
  return {
    count,
    share: gaps.length === 0 ? 0 : count / gaps.length,
    longestRun,
    thresholdMs,
  };
};

/**
 * Counts the frames the player stood in a block whose terrain had not arrived
 * yet. The world holds their physics still while that is true, so a long run
 * of them is the player having outrun the streaming.
 */
export const outrunIn = (
  ready: number[],
): { frames: number; share: number; longestRun: number } => {
  let frames = 0;
  let run = 0;
  let longestRun = 0;
  for (const value of ready) {
    if (value === 0) {
      frames++;
      run++;
      longestRun = Math.max(longestRun, run);
    } else {
      run = 0;
    }
  }
  return {
    frames,
    share: ready.length === 0 ? 0 : frames / ready.length,
    longestRun,
  };
};

/** Pulls one column out of every frame's row. */
const column = (drain: PerfDrain, index: number): number[] => {
  const values: number[] = [];
  for (let at = index; at < drain.rows.length; at += drain.rowStride) {
    values.push(drain.rows[at]);
  }
  return values;
};

/**
 * The column a named per-frame value or phase is recorded in, or -1 when the
 * run recorded neither. A run measured from an older commit knows nothing of a
 * value added since, and a column worked out by adding two positions lands on
 * the last field, reporting that value's numbers under this one's name.
 */
const columnOf = (drain: PerfDrain, name: string): number => {
  const field = drain.fieldNames.indexOf(name);
  if (field >= 0) {
    return field;
  }
  const phase = drain.phaseNames.indexOf(name);
  return phase >= 0 ? drain.fieldNames.length + phase : -1;
};

/** Every frame's value for a name, or nothing at all when the run has no such column. */
const columnFor = (drain: PerfDrain, name: string): number[] => {
  const at = columnOf(drain, name);
  return at < 0 ? [] : column(drain, at);
};

const maxOf = (values: number[]): number =>
  values.reduce((most, value) => Math.max(most, value), 0);

/** Reduces one drained run to the numbers a report prints and compares. */
export const summarize = (drain: PerfDrain): RunSummary => {
  const gaps = columnFor(drain, "gapMs");
  // The first frame has no previous frame to measure a gap from.
  const realGaps = gaps.filter((gap) => gap > 0);
  const uploads = columnFor(drain, "uploadBytes");
  const merges = columnFor(drain, "merges");
  const heap = columnFor(drain, "heapBytes").filter((bytes) => bytes > 0);
  const x = columnFor(drain, "playerX");
  const z = columnFor(drain, "playerZ");

  let pathUnits = 0;
  for (let i = 1; i < x.length; i++) {
    pathUnits += Math.hypot(x[i] - x[i - 1], z[i] - z[i - 1]);
  }
  const straightUnits =
    x.length < 2
      ? 0
      : Math.hypot(x[x.length - 1] - x[0], z[z.length - 1] - z[0]);

  const phases: Record<string, Spread> = {};
  for (const name of drain.phaseNames) {
    phases[name] = spreadOf(columnFor(drain, name));
  }
  const counters: Record<string, number> = {};
  drain.counterNames.forEach((name, at) => {
    counters[name] = drain.counters[at];
  });

  const scale = columnFor(drain, "scale");
  const resident = columnFor(drain, "residentBytes").filter(
    (bytes) => bytes > 0,
  );
  // The three stretches that are all main-thread work; every other phase is
  // inside one of them, and adding those in would count the same time twice.
  const advance = columnFor(drain, "advance");
  const occlusion = columnFor(drain, "occlusion");
  const draw = columnFor(drain, "draw");
  const mainThread = advance.map(
    (value, at) => value + occlusion[at] + draw[at],
  );
  return {
    frames: drain.framesSeen,
    durationMs: drain.durationMs,
    wrapped: drain.wrapped,
    gap: spreadOf(realGaps),
    mainThread: spreadOf(mainThread),
    // A browser without the timer-query extension reports every frame as -1,
    // which leaves the spread empty rather than claiming the card took no time.
    gpu: spreadOf(columnFor(drain, "gpuMs").filter((ms) => ms >= 0)),
    gpuOcclusion: spreadOf(
      columnFor(drain, "gpuOcclusionMs").filter((ms) => ms > 0),
    ),
    drops: dropsIn(realGaps),
    scale: {
      min: scale.length === 0 ? 0 : Math.min(...scale),
      median: spreadOf(scale).median,
    },
    phases,
    counters,
    queues: {
      fillPending: maxOf(columnFor(drain, "fillPending")),
      fillInFlight: maxOf(columnFor(drain, "fillInFlight")),
      meshPending: maxOf(columnFor(drain, "meshPending")),
      meshInFlight: maxOf(columnFor(drain, "meshInFlight")),
      dirtySuperchunks: maxOf(columnFor(drain, "dirtySuperchunks")),
    },
    upload: {
      totalBytes: uploads.reduce((sum, bytes) => sum + bytes, 0),
      maxFrameBytes: maxOf(uploads),
      framesWithUpload: uploads.filter((bytes) => bytes > 0).length,
      mergesInBiggestFrame: merges[uploads.indexOf(maxOf(uploads))] ?? 0,
      maxFrameMerges: maxOf(merges),
    },
    triangles: {
      median: spreadOf(columnFor(drain, "triangles")).median,
      max: maxOf(columnFor(drain, "triangles")),
    },
    culling: {
      occluded: spreadOf(columnFor(drain, "occluded")).median,
      visible: spreadOf(columnFor(drain, "visible")).median,
      drawnMeshes: spreadOf(columnFor(drain, "drawnMeshes")).median,
    },
    heap: {
      startBytes: heap[0] ?? 0,
      endBytes: heap[heap.length - 1] ?? 0,
      maxBytes: maxOf(heap),
    },
    resident: {
      startBytes: resident[0] ?? 0,
      endBytes: resident[resident.length - 1] ?? 0,
      maxBytes: maxOf(resident),
      voxelBytes: maxOf(columnFor(drain, "voxelBytes")),
      mergedGeometryBytes: maxOf(columnFor(drain, "mergedGeometryBytes")),
      blockGeometryBytes: maxOf(columnFor(drain, "blockGeometryBytes")),
    },
    overBudget: dropsIn(realGaps, FRAME_BUDGET_MS),
    travel: { pathUnits, straightUnits },
    outrun: outrunIn(columnFor(drain, "cellReady")),
  };
};
