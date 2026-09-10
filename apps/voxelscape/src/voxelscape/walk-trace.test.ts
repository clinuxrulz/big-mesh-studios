// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { WalkTraceRecorder, type WalkTraceSource } from "./walk-trace";
import type { PerfDrain, PerfProbeApi } from "../render/perf-probe";

const EMPTY_DRAIN: PerfDrain = {
  rows: [],
  rowStride: 0,
  fieldNames: [],
  phaseNames: [],
  counterNames: [],
  counters: [],
  framesSeen: 0,
  wrapped: false,
  durationMs: 0,
};

/** A probe that records what it was asked to do rather than timing anything. */
const fakeProbe = () => {
  const arm = vi.fn();
  const disarm = vi.fn();
  const drain = vi.fn(() => EMPTY_DRAIN);
  return {
    probe: { arm, disarm, drain } as unknown as PerfProbeApi,
    arm,
    disarm,
    drain,
  };
};

const source = (): WalkTraceSource => ({
  setup: () => ({ chunkRadius: 4 }),
  pose: () => ({ position: [1, 2, 3], facing: [0, 0, -1] }),
});

describe("recording a walk", () => {
  it("records nothing until it is started", () => {
    const { probe, arm } = fakeProbe();
    const trace = new WalkTraceRecorder(probe, source());
    expect(trace.recording).toBe(false);
    trace.mark("something is wrong");
    expect(trace.marked).toBe(0);
    expect(trace.stop()).toBeUndefined();
    expect(arm).not.toHaveBeenCalled();
  });

  it("keeps what was marked, in the words it was marked with", () => {
    const { probe } = fakeProbe();
    const trace = new WalkTraceRecorder(probe, source());
    trace.start("looking for the shoreline flicker");
    trace.mark("water flickers here");
    trace.mark("and again, worse");

    const written = trace.stop();
    expect(written?.name).toBe("looking for the shoreline flicker");
    expect(written?.marks.map((mark) => mark.note)).toEqual([
      "water flickers here",
      "and again, worse",
    ]);
    expect(written?.marks[0].pose.position).toEqual([1, 2, 3]);
  });

  it("holds what the world was set to when the walk began", () => {
    const { probe } = fakeProbe();
    const reads = vi.fn(() => ({ chunkRadius: 4 }));
    const trace = new WalkTraceRecorder(probe, {
      setup: reads,
      pose: () => ({ position: [0, 0, 0], facing: [0, 0, -1] }),
    });
    trace.start("a walk");
    trace.mark("here");

    // Read once, at the start: a trace says what was set when the walk began,
    // not what somebody changed it to along the way.
    expect(reads).toHaveBeenCalledTimes(1);
    expect(trace.stop()?.setup).toEqual({ chunkRadius: 4 });
  });

  it("arms the ring on starting and lets it go on stopping", () => {
    const { probe, arm, disarm, drain } = fakeProbe();
    const trace = new WalkTraceRecorder(probe, source());
    trace.start("a walk");
    expect(arm).toHaveBeenCalledTimes(1);
    expect(disarm).not.toHaveBeenCalled();

    trace.stop();
    expect(drain).toHaveBeenCalledTimes(1);
    // The ring is several megabytes; a finished trace does not keep holding it.
    expect(disarm).toHaveBeenCalledTimes(1);
  });

  it("gives the drawing to the mark that is waiting for it, once", () => {
    const { probe } = fakeProbe();
    const trace = new WalkTraceRecorder(probe, source());
    const canvas = {
      toDataURL: vi.fn(() => "data:image/png;base64,AAAA"),
    } as unknown as HTMLCanvasElement;

    trace.start("a walk");
    trace.mark("here");
    trace.takePicture(canvas);
    // A second frame with nothing waiting must not take another picture.
    trace.takePicture(canvas);

    expect(canvas.toDataURL).toHaveBeenCalledTimes(1);
    expect(trace.stop()?.marks[0].picture).toBe("data:image/png;base64,AAAA");
  });

  it("leaves a mark without a picture rather than failing on a canvas it cannot read", () => {
    const { probe } = fakeProbe();
    const trace = new WalkTraceRecorder(probe, source());
    const canvas = {
      toDataURL: () => {
        throw new Error("tainted");
      },
    } as unknown as HTMLCanvasElement;

    trace.start("a walk");
    trace.mark("here");
    expect(() => trace.takePicture(canvas)).not.toThrow();
    expect(trace.stop()?.marks[0].picture).toBeUndefined();
  });

  it("starts again from nothing, keeping no marks from the walk before", () => {
    const { probe } = fakeProbe();
    const trace = new WalkTraceRecorder(probe, source());
    trace.start("first");
    trace.mark("old");
    trace.stop();

    trace.start("second");
    expect(trace.marked).toBe(0);
    expect(trace.stop()?.marks).toEqual([]);
  });
});
