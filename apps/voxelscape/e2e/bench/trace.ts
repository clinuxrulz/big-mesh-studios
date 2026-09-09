import type { CDPSession } from "playwright";

/**
 * The trace categories a run records. The graphics categories carry what the
 * browser's own graphics process does with the commands the page sends it,
 * which is the layer below anything the page can time for itself; the memory
 * category carries the dumps every part of the browser writes when one is
 * asked for, including the buffers and textures the graphics driver holds,
 * which the page cannot see at all.
 */
const CATEGORIES = [
  "disabled-by-default-gpu.service",
  "disabled-by-default-gpu.device",
  "gpu",
  "viz",
  "toplevel",
  "disabled-by-default-memory-infra",
];

/** One event out of a browser trace, in the shape the trace file uses. */
interface TraceEvent {
  name: string;
  cat?: string;
  ph: string;
  pid: number;
  tid: number;
  ts: number;
  dur?: number;
  id?: string;
  args?: Record<string, unknown>;
}

/** A memory dump's numbers for one of the browser's processes. */
export interface ProcessMemory {
  /** The process id, and the name the trace gave it if it named one. */
  pid: number;
  process: string;
  /**
   * The dump's top-level totals, largest first. These are separate trees
   * rather than parts of one sum — a browser counts the same bytes under more
   * than one heading — so they are reported as they are rather than added up.
   */
  roots: { name: string; bytes: number }[];
  /**
   * What the page's own graphics objects take, by kind: the vertex and index
   * buffers uploaded to the card, its textures, and its render targets. This
   * is the count no code inside the page can take for itself.
   */
  webgl: { name: string; bytes: number }[];
}

/** What one traced scenario is reduced to. */
export interface TraceSummary {
  /** Where the whole trace was written, for opening in a trace viewer. */
  file: string;
  events: number;
  /** The costliest work the graphics process did, by total time under each name. */
  graphicsSlices: { name: string; totalMs: number; count: number }[];
  /** Each memory dump taken during the run, in the order they were taken. */
  memory: ProcessMemory[][];
}

/**
 * A memory-dump allocator's size, which the trace writes as a hexadecimal
 * string rather than a number.
 */
const allocatorBytes = (allocator: unknown): number => {
  const size = (
    allocator as { attrs?: { size?: { value?: string; units?: string } } }
  )?.attrs?.size;
  if (size?.value === undefined) {
    return 0;
  }
  return Number.parseInt(size.value, 16);
};

/** Starts recording a trace on this page's browser. */
export const startTrace = async (cdp: CDPSession): Promise<TraceEvent[]> => {
  const events: TraceEvent[] = [];
  cdp.on("Tracing.dataCollected", (payload) => {
    events.push(
      ...((payload as unknown as { value?: TraceEvent[] }).value ?? []),
    );
  });
  await cdp.send("Tracing.start", {
    traceConfig: {
      includedCategories: CATEGORIES,
      excludedCategories: ["*"],
      recordMode: "recordAsMuchAsPossible",
    },
    transferMode: "ReportEvents",
  });
  return events;
};

/**
 * Asks every part of the browser to write down what it is holding. The dump
 * lands in the trace as an event, so it is read back when the trace stops.
 */
export const dumpMemory = async (cdp: CDPSession): Promise<void> => {
  await cdp.send("Tracing.requestMemoryDump", {
    deterministic: true,
    levelOfDetail: "detailed",
  });
};

/** Stops recording and waits for the last events to arrive. */
export const stopTrace = async (cdp: CDPSession): Promise<void> => {
  const finished = new Promise<void>((resolve) => {
    cdp.once("Tracing.tracingComplete", () => resolve());
  });
  await cdp.send("Tracing.end");
  await finished;
};

/** The name the trace gave a process, or its number when it named none. */
const processNames = (events: TraceEvent[]): Map<number, string> => {
  const names = new Map<number, string>();
  for (const event of events) {
    if (event.name === "process_name") {
      const name = (event.args as { name?: string } | undefined)?.name;
      if (name !== undefined) {
        names.set(event.pid, name);
      }
    }
  }
  return names;
};

/**
 * Reduces a trace to the two things it is recorded for: where the graphics
 * process spent its time, and what each process was holding when a dump was
 * asked for.
 */
export const summarizeTrace = (
  events: TraceEvent[],
  file: string,
): TraceSummary => {
  const names = processNames(events);
  const graphicsPids = new Set(
    [...names].filter(([, name]) => name === "GPU Process").map(([pid]) => pid),
  );

  const byName = new Map<string, { totalMs: number; count: number }>();
  for (const event of events) {
    if (
      event.dur === undefined ||
      event.ph !== "X" ||
      !graphicsPids.has(event.pid)
    ) {
      continue;
    }
    const slice = byName.get(event.name) ?? { totalMs: 0, count: 0 };
    slice.totalMs += event.dur / 1000;
    slice.count++;
    byName.set(event.name, slice);
  }
  const graphicsSlices = [...byName]
    .map(([name, slice]) => ({ name, ...slice }))
    .sort((a, b) => b.totalMs - a.totalMs)
    .slice(0, 12);

  // Every process writes its own dump event, and the events of one dump share
  // an id; grouping by that keeps a dump's processes together, and the groups
  // stay in the order the dumps were asked for.
  const dumps = new Map<string, ProcessMemory[]>();
  for (const event of events) {
    if (event.ph !== "v") {
      continue;
    }
    const allocators = (
      event.args as { dumps?: { allocators?: Record<string, unknown> } }
    )?.dumps?.allocators;
    if (allocators === undefined) {
      continue;
    }
    const sized = Object.entries(allocators).map(
      ([name, allocator]): [string, number] => [
        name,
        allocatorBytes(allocator),
      ],
    );
    const roots = sized
      .filter(([name, bytes]) => !name.includes("/") && bytes > 0)
      .map(([name, bytes]) => ({ name, bytes }))
      .sort((a, b) => b.bytes - a.bytes)
      .slice(0, 6);
    // `webgl/context_0x…/buffers` and its siblings: the kind is the last
    // segment, and the context in the middle is an address worth dropping.
    const webgl = sized
      .filter(
        ([name, bytes]) =>
          name.startsWith("webgl/") &&
          name.split("/").length === 3 &&
          bytes > 0,
      )
      .map(([name, bytes]) => ({ name: name.split("/")[2], bytes }))
      .sort((a, b) => b.bytes - a.bytes);
    if (roots.length === 0) {
      continue;
    }
    const key = event.id ?? String(event.ts);
    const forDump = dumps.get(key) ?? [];
    forDump.push({
      pid: event.pid,
      process: names.get(event.pid) ?? `process ${event.pid}`,
      roots,
      webgl,
    });
    dumps.set(key, forDump);
  }

  return {
    file,
    events: events.length,
    graphicsSlices,
    memory: [...dumps.values()],
  };
};

const megabytes = (bytes: number): string =>
  `${(bytes / (1024 * 1024)).toFixed(1)}MB`;

/** Writes a traced scenario's findings as the lines that follow its numbers. */
export const formatTrace = (summary: TraceSummary): string => {
  const lines: string[] = [];
  lines.push(`  browser trace (${summary.events.toLocaleString()} events)`);
  if (summary.graphicsSlices.length === 0) {
    lines.push("    the graphics process recorded nothing");
  } else {
    lines.push("    where the graphics process spent its time:");
    for (const slice of summary.graphicsSlices.slice(0, 8)) {
      lines.push(
        `      ${slice.name.padEnd(42)} ${slice.totalMs.toFixed(1).padStart(8)}ms over ${slice.count} calls`,
      );
    }
  }
  const first = summary.memory[0];
  const last = summary.memory[summary.memory.length - 1];
  if (first !== undefined && last !== undefined) {
    lines.push("    what the browser was holding, first dump → last:");
    // The page lives in the renderer and its drawing is done by the graphics
    // process; the rest are the browser's own helpers, which no change here
    // moves.
    const worthReading = last.filter(
      (process) =>
        process.process === "Renderer" || process.process === "GPU Process",
    );
    for (const process of worthReading) {
      const before = first.find((candidate) => candidate.pid === process.pid);
      lines.push(`      ${process.process}`);
      for (const root of process.roots) {
        const was =
          before?.roots.find((candidate) => candidate.name === root.name)
            ?.bytes ?? 0;
        lines.push(
          `        ${root.name.padEnd(24)} ${megabytes(was).padStart(9)} → ${megabytes(root.bytes).padStart(9)}`,
        );
      }
      if (process.webgl.length > 0) {
        lines.push(
          `        of which this page's own graphics objects: ` +
            process.webgl
              .map((kind) => `${kind.name} ${megabytes(kind.bytes)}`)
              .join(", "),
        );
      }
    }
  }
  lines.push(`    whole trace written to ${summary.file}`);
  return lines.join("\n");
};
