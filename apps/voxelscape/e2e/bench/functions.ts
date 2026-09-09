// Where the main thread's time went, function by function, from V8's own
// sampling profiler.
//
// The probe's phases say which stretch of a frame cost what, and stop there: a
// phase that costs four milliseconds says nothing about which of the twenty
// functions inside it spent them. The sampler interrupts the thread every
// quarter of a millisecond and writes down what was running, so the answer is
// arithmetic over those samples rather than instrumentation anybody had to
// place.
//
// Two things this cannot see. It samples the page's main thread alone, so the
// world's workers — every fill and every mesh build — are invisible here and
// show up only as the main thread waiting. And sampling costs a few percent of
// the thread it watches, so a run recorded with it is for reading, not for
// comparing against a run without it.
//
// The raw profile is written beside the report as a `.cpuprofile`, which
// Chrome's developer tools open directly: drop the file into the Performance
// panel for the flame graph this summary flattens.
import { readFileSync } from "node:fs";
import { SourceMap } from "node:module";
import { basename, join } from "node:path";
import type { CDPSession } from "playwright";

/** Microseconds between samples. */
const SAMPLE_INTERVAL_US = 250;

/** How many functions a summary names before it stops. */
const NAMED = 18;

/** One function as the profiler saw it: where it was, and what was running there. */
interface CallFrame {
  functionName: string;
  url: string;
  lineNumber: number;
  columnNumber: number;
}

/** One node of the profile's call tree. */
interface ProfileNode {
  id: number;
  callFrame: CallFrame;
  hitCount?: number;
  children?: number[];
}

/** A profile as `Profiler.stop` returns it. */
export interface CpuProfile {
  nodes: ProfileNode[];
  startTime: number;
  endTime: number;
  samples?: number[];
  timeDeltas?: number[];
}

/** One function, with the time the sampler caught it running itself. */
export interface FunctionCost {
  /** What the function is called, or `(anonymous)` where it has no name. */
  name: string;
  /** The file and line it starts on, as the built code or its source names it. */
  where: string;
  /** Milliseconds the sampler caught this function running, its callees excluded. */
  selfMs: number;
  /** That time as a share of the profile's whole span. */
  share: number;
}

/** What a profiled scenario spent its main thread on. */
export interface FunctionSummary {
  /** Where the raw profile was written, for the developer tools to open. */
  file: string;
  /** The scenario the profile covers. */
  scenario: string;
  /** Milliseconds the profile spans. */
  spanMs: number;
  /** Of those, the milliseconds the thread had nothing to do. */
  idleMs: number;
  /** Of those, the milliseconds V8 spent collecting garbage. */
  garbageMs: number;
  /** The costliest functions, its callees excluded, largest first. */
  functions: FunctionCost[];
  /** Whether the names came back through a source map or from the built code. */
  mapped: boolean;
}

/** Arms V8's sampler on the page this session is attached to. */
export const startSampling = async (cdp: CDPSession): Promise<void> => {
  await cdp.send("Profiler.enable");
  await cdp.send("Profiler.setSamplingInterval", {
    interval: SAMPLE_INTERVAL_US,
  });
  await cdp.send("Profiler.start");
};

/** Stops the sampler and takes the profile it collected. */
export const stopSampling = async (cdp: CDPSession): Promise<CpuProfile> => {
  const { profile } = (await cdp.send("Profiler.stop")) as {
    profile: CpuProfile;
  };
  await cdp.send("Profiler.disable");
  return profile;
};

/** The synthetic frames V8 writes for what is not a function of the page's own. */
const SYNTHETIC = new Map([
  ["(idle)", "the thread had nothing to do"],
  ["(program)", "the browser's own work, outside any script"],
  ["(garbage collector)", "V8 reclaiming memory"],
  ["(root)", "the profile's root"],
  ["(unresolved function)", "a frame V8 could not name"],
]);

/**
 * Reads the source map beside a built file, once per file, and answers null for
 * a build that emitted none. Without maps the names stay as the built code has
 * them, which for a minified build is readable for a class's methods — their
 * names are property keys, which nothing renames — and not for anything else.
 */
const sourceMapReader = (
  distDir: string,
): ((url: string) => SourceMap | null) => {
  const read = new Map<string, SourceMap | null>();
  return (url: string): SourceMap | null => {
    const held = read.get(url);
    if (held !== undefined) {
      return held;
    }
    let map: SourceMap | null = null;
    try {
      const file = join(distDir, "assets", `${basename(url)}.map`);
      map = new SourceMap(
        JSON.parse(readFileSync(file, "utf8")) as ConstructorParameters<
          typeof SourceMap
        >[0],
      );
    } catch {
      map = null;
    }
    read.set(url, map);
    return map;
  };
};

/** Where a frame came from in the sources, or in the built file when nothing maps it. */
const placeOf = (
  frame: CallFrame,
  readMap: (url: string) => SourceMap | null,
): { where: string; name: string | null; mapped: boolean } => {
  const built = `${basename(frame.url) || "the page"}:${frame.lineNumber + 1}`;
  const map = frame.url === "" ? null : readMap(frame.url);
  if (map === null) {
    return { where: built, name: null, mapped: false };
  }
  // The protocol counts lines and columns from zero, and so does a source map,
  // so only the printed line needs the one added back.
  // `findEntry` answers an empty object for a position nothing maps.
  const entry = map.findEntry(frame.lineNumber, frame.columnNumber) as {
    originalSource?: string;
    originalLine?: number;
    name?: string;
  };
  if (entry.originalSource === undefined) {
    return { where: built, name: null, mapped: false };
  }
  const source = entry.originalSource.replace(/^.*\/(src|e2e)\//, "$1/");
  return {
    where: `${source}:${(entry.originalLine ?? 0) + 1}`,
    name: entry.name ?? null,
    mapped: true,
  };
};

/**
 * Flattens a profile into the functions that spent its time, its callees
 * excluded from each: the sampler's own arithmetic, which is the sum of the
 * intervals it caught each function running in.
 *
 * @param profile What `Profiler.stop` returned.
 * @param file Where the raw profile was written.
 * @param scenario The scenario it covers.
 * @param distDir The built site, so the source maps beside it can be read.
 */
export const summarizeProfile = (
  profile: CpuProfile,
  file: string,
  scenario: string,
  distDir: string,
): FunctionSummary => {
  const byId = new Map(profile.nodes.map((node) => [node.id, node]));
  const selfUs = new Map<number, number>();
  const samples = profile.samples ?? [];
  const deltas = profile.timeDeltas ?? [];
  for (let at = 0; at < samples.length; at++) {
    const id = samples[at];
    // A delta is the gap before its sample, which is the time that sample
    // stands for. A profile without deltas is counted by hit instead.
    const us = deltas[at] ?? SAMPLE_INTERVAL_US;
    selfUs.set(id, (selfUs.get(id) ?? 0) + Math.max(0, us));
  }
  if (samples.length === 0) {
    for (const node of profile.nodes) {
      selfUs.set(node.id, (node.hitCount ?? 0) * SAMPLE_INTERVAL_US);
    }
  }

  const readMap = sourceMapReader(distDir);
  let mapped = false;
  let idleUs = 0;
  let garbageUs = 0;
  const byFunction = new Map<string, FunctionCost>();
  for (const [id, us] of selfUs) {
    const node = byId.get(id);
    if (node === undefined) {
      continue;
    }
    const frame = node.callFrame;
    if (frame.functionName === "(idle)") {
      idleUs += us;
      continue;
    }
    if (frame.functionName === "(garbage collector)") {
      garbageUs += us;
      continue;
    }
    if (frame.functionName === "(root)") {
      continue;
    }
    const place = SYNTHETIC.has(frame.functionName)
      ? { where: "", name: null, mapped: false }
      : placeOf(frame, readMap);
    mapped = mapped || place.mapped;
    const name =
      place.name ??
      (frame.functionName === "" ? "(anonymous)" : frame.functionName);
    const key = `${name} ${place.where}`;
    const held = byFunction.get(key);
    if (held === undefined) {
      byFunction.set(key, {
        name,
        where: place.where,
        selfMs: us / 1000,
        share: 0,
      });
    } else {
      held.selfMs += us / 1000;
    }
  }

  const spanMs = (profile.endTime - profile.startTime) / 1000;
  const functions = [...byFunction.values()]
    .sort((one, two) => two.selfMs - one.selfMs)
    .slice(0, NAMED)
    .map((cost) => ({
      ...cost,
      share: spanMs === 0 ? 0 : cost.selfMs / spanMs,
    }));
  return {
    file,
    scenario,
    spanMs,
    idleMs: idleUs / 1000,
    garbageMs: garbageUs / 1000,
    functions,
    mapped,
  };
};

/** Writes a profiled scenario's findings as the lines that follow its numbers. */
export const formatFunctions = (summary: FunctionSummary): string => {
  const ms = (value: number): string => `${value.toFixed(1)}ms`;
  const share = (value: number): string => `${(value * 100).toFixed(1)}%`;
  const busyMs = summary.spanMs - summary.idleMs;
  const lines = [
    `  where ${summary.scenario}'s main thread went (${ms(summary.spanMs)} sampled, ` +
      `${ms(busyMs)} of it busy, ${ms(summary.idleMs)} idle)`,
  ];
  if (!summary.mapped) {
    lines.push(
      "    names are the built code's: a class's methods keep theirs, and the rest were minified away",
    );
  }
  lines.push(
    `    ${"(garbage collector)".padEnd(34)} ${ms(summary.garbageMs).padStart(8)}  ${share(summary.garbageMs / summary.spanMs).padStart(6)} of the span`,
  );
  for (const cost of summary.functions) {
    lines.push(
      `    ${cost.name.slice(0, 34).padEnd(34)} ${ms(cost.selfMs).padStart(8)}  ${share(cost.share).padStart(6)}  ${cost.where}`,
    );
  }
  lines.push(`    whole profile written to ${summary.file}`);
  return lines.join("\n");
};
