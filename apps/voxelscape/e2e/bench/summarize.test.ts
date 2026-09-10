// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  COUNTER_NAMES,
  FIELD_NAMES,
  Field,
  PHASE_NAMES,
  PerfProbe,
} from "../../src/render/perf-probe.ts";
import { dropsIn, spreadOf, summarize } from "./summarize.ts";

/** A sixtieth of a second, the gap a frame has on a 60 hertz display. */
const REFRESH = 1000 / 60;

describe("spreadOf", () => {
  it("has no numbers to report for an empty column", () => {
    expect(spreadOf([])).toEqual({
      count: 0,
      median: 0,
      p95: 0,
      p99: 0,
      max: 0,
      mean: 0,
    });
  });

  it("orders the values it is given before reading percentiles off them", () => {
    const spread = spreadOf([5, 1, 4, 2, 3]);
    expect(spread.median).toBe(3);
    expect(spread.max).toBe(5);
    expect(spread.mean).toBe(3);
  });
});

describe("dropsIn", () => {
  it("finds no drops in frames that all met the refresh", () => {
    const drops = dropsIn(new Array(100).fill(REFRESH));
    expect(drops.count).toBe(0);
    expect(drops.longestRun).toBe(0);
  });

  it("takes the run's own median as the refresh period", () => {
    // A 120 hertz run: a 16.7ms frame is a drop here, though it would be
    // perfect on a 60 hertz display.
    const gaps = new Array(100).fill(1000 / 120);
    gaps[10] = REFRESH;
    const drops = dropsIn(gaps);
    expect(drops.thresholdMs).toBeCloseTo(12.5, 5);
    expect(drops.count).toBe(1);
  });

  it("reports the longest unbroken stretch of late frames", () => {
    const gaps = new Array(50).fill(REFRESH);
    gaps[10] = REFRESH * 4;
    gaps[20] = REFRESH * 4;
    gaps[21] = REFRESH * 4;
    gaps[22] = REFRESH * 4;
    const drops = dropsIn(gaps);
    expect(drops.count).toBe(4);
    expect(drops.longestRun).toBe(3);
    expect(drops.share).toBeCloseTo(4 / 50, 5);
  });
});

describe("summarize", () => {
  it("reads a recorded run back by column name", () => {
    const probe = new PerfProbe();
    probe.arm(16);
    probe.gauge(Field.triangles, 1000);
    probe.gauge(Field.fillPending, 4);
    probe.frame(REFRESH, 3, 1);
    probe.gauge(Field.fillPending, 9);
    probe.frame(REFRESH, 5, 1);

    const summary = summarize(probe.drain());
    expect(summary.frames).toBe(2);
    expect(summary.gap.median).toBeCloseTo(REFRESH, 5);
    expect(summary.gpu.count).toBe(2);
    expect(summary.queues.fillPending).toBe(9);
    expect(summary.triangles.max).toBe(1000);
    expect(Object.keys(summary.phases)).toEqual(PHASE_NAMES);
    expect(Object.keys(summary.counters)).toEqual(COUNTER_NAMES);
  });

  it("reports nothing for a value the run never recorded, not its neighbour's", () => {
    // A run measured from a commit that predates a value knows nothing of it.
    // This drain names three values and one phase, and no draw-call count; a
    // column worked out by adding two positions lands on the last field here,
    // so how far the player walked would be read back as that frame's draw
    // calls.
    const older = {
      rows: [REFRESH, 3, 2292, 0.5],
      rowStride: 4,
      fieldNames: ["gapMs", "gpuMs", "playerZ"],
      phaseNames: ["draw"],
      counterNames: [],
      counters: [],
      framesSeen: 1,
      wrapped: false,
      durationMs: REFRESH,
    };

    expect(summarize(older).culling.drawnMeshes).toBe(0);
  });

  it("leaves the graphics-card spread empty when the browser cannot time it", () => {
    const probe = new PerfProbe();
    probe.arm(16);
    probe.frame(REFRESH, -1, 1);
    probe.frame(REFRESH, -1, 1);
    expect(summarize(probe.drain()).gpu.count).toBe(0);
  });

  it("measures how far the player went, along the path and end to end", () => {
    const probe = new PerfProbe();
    probe.arm(16);
    // Three steps out and one back: four along the path, two end to end.
    for (const x of [0, 1, 2, 3, 2]) {
      probe.gauge(Field.playerX, x);
      probe.gauge(Field.playerZ, 0);
      probe.frame(REFRESH, 0, 1);
    }
    const summary = summarize(probe.drain());
    expect(summary.travel.pathUnits).toBeCloseTo(4, 5);
    expect(summary.travel.straightUnits).toBeCloseTo(2, 5);
  });

  it("names a column that is a phase as readily as one that is a field", () => {
    const probe = new PerfProbe();
    probe.arm(4);
    probe.frame(REFRESH, 0, 1);
    const drain = probe.drain();
    expect(drain.fieldNames).toEqual(FIELD_NAMES);
    expect(summarize(drain).phases[PHASE_NAMES[0]].count).toBe(1);
  });
});
