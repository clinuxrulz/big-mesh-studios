// What a run's costliest frames were doing. The charts above show the shape of
// a run; these read the individual frames out of the same samples, because a
// run is judged by the few frames that went over a sixtieth of a second and
// the answer to "why" is in what those frames happened to be doing.
import type { RunSamples } from "../report.ts";

/** One frame that cost more than it had, and what it spent that on. */
export interface LateFrame {
  /** Seconds from the run's first frame. */
  at: number;
  /** Main-thread milliseconds: every phase of the frame added up. */
  mainMs: number;
  /** Milliseconds until the next frame arrived. */
  gapMs: number;
  uploadBytes: number;
  merges: number;
  /** The phases that took the most of it, longest first. */
  spent: { name: string; ms: number }[];
}

/** How much of a phase is worth naming as part of why a frame ran long. */
const PHASE_FLOOR_MS = 0.5;
/** How many phases one frame's account names before the rest are left out. */
const PHASES_NAMED = 4;

/** Reads one frame's column, whether it is a field or a phase. */
const reader = (samples: RunSamples) => {
  const { fieldNames, phaseNames, rowStride, rows } = samples;
  return (frame: number, name: string): number => {
    const field = fieldNames.indexOf(name);
    const column =
      field >= 0 ? field : fieldNames.length + phaseNames.indexOf(name);
    return rows[frame * rowStride + column];
  };
};

/**
 * The frames whose main-thread work went over `budgetMs`, costliest first.
 *
 * @param samples Every frame of one run.
 * @param budgetMs What a frame was allowed to cost.
 * @param limit How many to return.
 * @returns Those frames, at most `limit` of them.
 */
export const lateFrames = (
  samples: RunSamples,
  budgetMs: number,
  limit: number,
): LateFrame[] => {
  const read = reader(samples);
  const count = Math.floor(samples.rows.length / samples.rowStride);
  const late: LateFrame[] = [];
  let elapsed = 0;
  for (let frame = 0; frame < count; frame++) {
    elapsed += read(frame, "gapMs") / 1000;
    const phases = samples.phaseNames.map((name) => ({
      name,
      ms: read(frame, name),
    }));
    const mainMs = phases.reduce((total, phase) => total + phase.ms, 0);
    if (mainMs <= budgetMs) {
      continue;
    }
    late.push({
      at: elapsed,
      mainMs,
      gapMs: read(frame, "gapMs"),
      uploadBytes: read(frame, "uploadBytes"),
      merges: read(frame, "merges"),
      spent: phases
        .filter((phase) => phase.ms >= PHASE_FLOOR_MS)
        .sort((one, two) => two.ms - one.ms)
        .slice(0, PHASES_NAMED),
    });
  }
  return late.sort((one, two) => two.mainMs - one.mainMs).slice(0, limit);
};

/**
 * How many frames sent the graphics card more than one frame's upload budget
 * in one go. The chart above draws every upload against that budget; this
 * counts the ones that cleared it, which is the number worth quoting.
 *
 * @param samples Every frame of one run.
 * @param budgetBytes What one frame was meant to send at most.
 * @returns The number of frames that sent more.
 */
export const uploadsOverBudget = (
  samples: RunSamples,
  budgetBytes: number,
): number => {
  const read = reader(samples);
  const count = Math.floor(samples.rows.length / samples.rowStride);
  let over = 0;
  for (let frame = 0; frame < count; frame++) {
    if (read(frame, "uploadBytes") > budgetBytes) {
      over++;
    }
  }
  return over;
};
