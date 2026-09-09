// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  Counter,
  FIELD_NAMES,
  Field,
  PHASE_NAMES,
  Phase,
  PerfProbe,
  ROW_STRIDE,
} from "./perf-probe";

/** Reads one field out of a drained run's flat row array. */
const at = (rows: number[], frame: number, column: number): number =>
  rows[frame * ROW_STRIDE + column];

/** The column a phase's slice is recorded in, after all the per-frame fields. */
const phaseColumn = (phase: number): number => FIELD_NAMES.length + phase;

describe("PerfProbe", () => {
  it("records nothing until it is armed", () => {
    const probe = new PerfProbe();
    probe.begin(Phase.flow);
    probe.end(Phase.flow);
    probe.count(Counter.fillsLanded, 7);
    probe.gauge(Field.triangles, 100);
    probe.frame(16.7, 4, 1);

    const drain = probe.drain();
    expect(probe.armed).toBe(false);
    expect(drain.framesSeen).toBe(0);
    expect(drain.rows).toEqual([]);
    expect(drain.counters.every((count) => count === 0)).toBe(true);
  });

  it("writes one row a frame, with the gauges it was last given", () => {
    const probe = new PerfProbe();
    probe.arm(4);
    probe.gauge(Field.triangles, 1234);
    probe.gauge(Field.fillPending, 9);
    probe.frame(16.7, 4.25, 0.75);
    probe.frame(33.4, 8.5, 0.75);

    const drain = probe.drain();
    expect(drain.framesSeen).toBe(2);
    expect(drain.wrapped).toBe(false);
    expect(drain.rows.length).toBe(2 * ROW_STRIDE);
    expect(at(drain.rows, 0, Field.gapMs)).toBe(16.7);
    expect(at(drain.rows, 1, Field.gapMs)).toBe(33.4);
    expect(at(drain.rows, 0, Field.gpuMs)).toBe(4.25);
    expect(at(drain.rows, 0, Field.scale)).toBe(0.75);
    // A gauge stands until it is set again, so the second frame carries it too.
    expect(at(drain.rows, 1, Field.triangles)).toBe(1234);
    expect(at(drain.rows, 1, Field.fillPending)).toBe(9);
  });

  it("counts the bytes uploaded for one frame only", () => {
    const probe = new PerfProbe();
    probe.arm(4);
    probe.gauge(Field.uploadBytes, 2048);
    probe.frame(16.7, 0, 1);
    probe.frame(16.7, 0, 1);

    const drain = probe.drain();
    expect(at(drain.rows, 0, Field.uploadBytes)).toBe(2048);
    expect(at(drain.rows, 1, Field.uploadBytes)).toBe(0);
  });

  it("adds a phase's slices within a frame and clears them for the next", () => {
    const probe = new PerfProbe();
    probe.arm(4);
    probe.begin(Phase.merge);
    probe.end(Phase.merge);
    probe.begin(Phase.merge);
    probe.end(Phase.merge);
    probe.frame(16.7, 0, 1);
    probe.frame(16.7, 0, 1);

    const drain = probe.drain();
    const first = at(drain.rows, 0, phaseColumn(Phase.merge));
    expect(first).toBeGreaterThanOrEqual(0);
    expect(at(drain.rows, 1, phaseColumn(Phase.merge))).toBe(0);
  });

  it("keeps the most recent frames once the ring wraps", () => {
    const probe = new PerfProbe();
    probe.arm(3);
    for (let frame = 0; frame < 5; frame++) {
      probe.gauge(Field.triangles, frame);
      probe.frame(16.7, 0, 1);
    }

    const drain = probe.drain();
    expect(drain.wrapped).toBe(true);
    expect(drain.framesSeen).toBe(5);
    expect(drain.rows.length).toBe(3 * ROW_STRIDE);
    expect(at(drain.rows, 0, Field.triangles)).toBe(2);
    expect(at(drain.rows, 2, Field.triangles)).toBe(4);
  });

  it("totals a counter across the run and clears it on reset", () => {
    const probe = new PerfProbe();
    probe.arm(4);
    probe.count(Counter.fillsRequested, 12);
    probe.count(Counter.fillsRequested);
    expect(probe.drain().counters[Counter.fillsRequested]).toBe(13);

    probe.reset();
    expect(probe.drain().counters[Counter.fillsRequested]).toBe(0);
    expect(probe.drain().framesSeen).toBe(0);
  });

  it("names every column it records", () => {
    const probe = new PerfProbe();
    probe.arm(1);
    const drain = probe.drain();
    expect(drain.fieldNames).toEqual(FIELD_NAMES);
    expect(drain.phaseNames).toEqual(PHASE_NAMES);
    expect(drain.rowStride).toBe(
      drain.fieldNames.length + drain.phaseNames.length,
    );
    expect(drain.counterNames.length).toBe(drain.counters.length);
  });
});
