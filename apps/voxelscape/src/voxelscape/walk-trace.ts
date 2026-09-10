// A recording of a walk, for handing to somebody who was not there.
//
// A bug that only shows up in certain places is expensive to describe and
// cheap to walk into again, so this records the walking: what the world was
// set to, every frame the probe timed along the way, and a mark at each moment
// somebody said "there". A mark carries the picture on screen and, better than
// anything measured, a sentence about what was wrong with it.
//
// The frames come from the performance probe, which already rings the last few
// thousand of them. That probe is left out of the build players get, where it
// answers as a probe that records nothing: a trace made there still carries its
// setup, its marks and their pictures, and simply holds no frames. Nothing here
// records anything until a trace is started.
import type { PerfDrain, PerfProbeApi } from "../render/perf-probe";

/**
 * How many frames a trace's ring holds. At sixty a second this is about four
 * and a half minutes of walking, held in five megabytes — deeper than the
 * probe's own default, because a trace is started on purpose and meant to
 * cover the whole of what somebody set out to do.
 */
const TRACE_FRAMES = 16384;

/** Where the player stood and which way they faced. */
export interface WalkTracePose {
  position: [number, number, number];
  /** The direction the camera looked, as a unit vector. */
  facing: [number, number, number];
}

/** One moment somebody marked, and what they said about it. */
export interface WalkTraceMark {
  /** Seconds since the trace started. */
  at: number;
  /**
   * What was wrong, in the words of whoever saw it. The one thing in a trace
   * that no instrument records, and the first thing worth reading.
   */
  note: string;
  pose: WalkTracePose;
  /** The drawing as it was, as a data URL, where one could be taken. */
  picture?: string;
}

/** What a trace reads from the world it is recording. */
export interface WalkTraceSource {
  /**
   * What the world is set to: everything a reader would have to match to walk
   * into the same place, from the terrain seed to the size of the window.
   */
  setup(): Record<string, unknown>;
  pose(): WalkTracePose;
}

/** A finished recording, as it is written down. */
export interface WalkTraceFile {
  /** What the walk was for, in the words of whoever started it. */
  name: string;
  startedAt: string;
  seconds: number;
  setup: Record<string, unknown>;
  marks: WalkTraceMark[];
  /** Every frame the probe timed, oldest first; see `PerfDrain`. */
  frames: PerfDrain;
}

/**
 * Records one walk at a time. Started and stopped by hand, because a recording
 * nobody asked for costs a ring of frames to hold and is rarely the walk
 * anybody wanted.
 */
export class WalkTraceRecorder {
  private startedAt: number | undefined;
  private startedOn = "";
  private name = "";
  private marks: WalkTraceMark[] = [];
  private setup: Record<string, unknown> = {};
  /** Whether a mark is waiting for the next frame to hand it a picture. */
  private wanting = false;

  constructor(
    private readonly probe: PerfProbeApi,
    private readonly source: WalkTraceSource,
  ) {}

  /** Whether a walk is being recorded right now. */
  get recording(): boolean {
    return this.startedAt !== undefined;
  }

  /** How many moments have been marked so far. */
  get marked(): number {
    return this.marks.length;
  }

  /**
   * Begins recording, discarding anything a previous trace left. The world is
   * read once here rather than at the end, so a trace says what was set when
   * the walk began even if it was changed along the way.
   */
  start(name: string): Record<string, unknown> {
    this.name = name;
    this.startedAt = performance.now();
    this.startedOn = new Date().toISOString();
    this.marks = [];
    this.setup = this.source.setup();
    this.probe.arm(TRACE_FRAMES);
    // Handed back so a caller can say what it is recording without reading the
    // world a second time and risking a different answer.
    return this.setup;
  }

  /**
   * Marks this moment: where the player stood, which way they faced, and what
   * they said was wrong. The picture is left for `takePicture` to fill in,
   * because a mark is made between frames and a drawing buffer holds nothing
   * readable then.
   */
  mark(note: string): void {
    if (this.startedAt === undefined) {
      return;
    }
    this.marks.push({
      at: (performance.now() - this.startedAt) / 1000,
      note,
      pose: this.source.pose(),
    });
    this.wanting = true;
  }

  /**
   * Gives the newest mark the drawing, if it is still waiting for one. Called
   * straight after a frame is drawn, which is the only moment a WebGL canvas
   * reads back as anything but blank.
   */
  takePicture(canvas: HTMLCanvasElement): void {
    if (!this.wanting) {
      return;
    }
    this.wanting = false;
    const mark = this.marks.at(-1);
    if (mark === undefined) {
      return;
    }
    try {
      mark.picture = canvas.toDataURL("image/png");
    } catch {
      // A canvas the page is not allowed to read back leaves the mark without
      // a picture rather than taking the frame down with it.
    }
  }

  /** Ends the recording and hands over what it holds, or nothing if none was running. */
  stop(): WalkTraceFile | undefined {
    if (this.startedAt === undefined) {
      return undefined;
    }
    const seconds = (performance.now() - this.startedAt) / 1000;
    const frames = this.probe.drain();
    this.probe.disarm();
    this.startedAt = undefined;
    return {
      name: this.name,
      startedAt: this.startedOn,
      seconds,
      setup: this.setup,
      marks: this.marks,
      frames,
    };
  }
}

/** One setting written out, however deeply the setup nested it. */
const settingText = (value: unknown): string => {
  if (value === undefined || value === null) {
    return "unset";
  }
  if (Array.isArray(value)) {
    return value.join(", ");
  }
  if (typeof value === "object") {
    return Object.entries(value)
      .map(([name, held]) => `${name} ${settingText(held)}`)
      .join(", ");
  }
  return String(value);
};

/**
 * The setup as lines to read, one a setting. Walks whatever the snapshot holds
 * rather than naming the settings it expects, so a setting added to a trace is
 * a setting the trace also says out loud — nothing can be recorded quietly.
 */
export const describeSetup = (setup: Record<string, unknown>): string =>
  Object.entries(setup)
    .map(([name, held]) => `${name}: ${settingText(held)}`)
    .join("\n");
