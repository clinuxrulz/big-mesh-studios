import type { CDPSession } from "playwright";

/**
 * What the browser's own graphics process does with the commands the page
 * sends it: the layer below anything the page can time for itself, and the
 * only place a frame's wait on the card is written down.
 */
const GRAPHICS_CATEGORIES = [
  "disabled-by-default-gpu.service",
  "disabled-by-default-gpu.device",
  "gpu",
  "viz",
  "toplevel",
];

/**
 * The dumps every part of the browser writes of what it is holding, including
 * the buffers and textures the graphics driver holds, which the page cannot
 * see at all.
 *
 * Recorded only when a run asks for them, because the browser takes dumps of
 * its own accord while this is on, and each one stops the thread it is taken
 * on: on a phone they run to a tenth of a second, which lands in the middle of
 * frames and makes a trace recorded for timing describe the tracing.
 */
const MEMORY_CATEGORIES = ["disabled-by-default-memory-infra"];

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

/** One heading of a memory dump, and what it held. */
interface DumpRoot {
  name: string;
  bytes: number;
}

/**
 * What one of the browser's processes held, taken from its own first and last
 * dumps rather than from whichever dump every process happened to answer
 * together: they do not all answer every time, and a process that missed the
 * last one would otherwise go unreported however much it was holding.
 */
export interface ProcessMemory {
  /** The process id, and the name the trace gave it if it named one. */
  pid: number;
  process: string;
  /**
   * Whether this is the process drawing the page. A browser runs several
   * renderers and the others hold pages this run never opened, so the one
   * holding a WebGL context is the one a measurement is about.
   */
  drawsThePage: boolean;
  /**
   * The top-level totals of its first dump and of its last, largest first.
   * These are separate trees rather than parts of one sum — a browser counts
   * the same bytes under more than one heading — so they are reported as they
   * are rather than added up.
   */
  first: DumpRoot[];
  last: DumpRoot[];
  /**
   * What the page's own graphics objects take, by kind: the vertex and index
   * buffers uploaded to the card, its textures, and its render targets. This
   * is the count no code inside the page can take for itself.
   */
  webgl: DumpRoot[];
}

/** What one traced scenario is reduced to. */
export interface TraceSummary {
  /** The scenario this was recorded around; a run traces each one separately. */
  scenario: string;
  /** Where the whole trace was written, for opening in a trace viewer. */
  file: string;
  events: number;
  /** The costliest work the graphics process did, by total time under each name. */
  graphicsSlices: { name: string; totalMs: number; count: number }[];
  /** What each process was holding, largest last dump first. */
  memory: ProcessMemory[];
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

/**
 * Starts recording a trace on this page's browser.
 *
 * @param withMemory Whether to record what each process holds as well as what
 * the graphics process does. It costs the run the stalls described above, so a
 * trace read for timing leaves it off.
 */
export const startTrace = async (
  cdp: CDPSession,
  withMemory: boolean,
): Promise<TraceEvent[]> => {
  const events: TraceEvent[] = [];
  cdp.on("Tracing.dataCollected", (payload) => {
    events.push(
      ...((payload as unknown as { value?: TraceEvent[] }).value ?? []),
    );
  });
  await cdp.send("Tracing.start", {
    traceConfig: {
      includedCategories: withMemory
        ? [...GRAPHICS_CATEGORIES, ...MEMORY_CATEGORIES]
        : GRAPHICS_CATEGORIES,
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
  scenario: string,
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

  // Each process is followed on its own, because they do not all write a dump
  // every time one is taken: pairing the first and last dump of each keeps a
  // process that answered only some of them.
  const held = new Map<
    number,
    { first?: DumpRoot[]; last: DumpRoot[]; webgl: DumpRoot[] }
  >();
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
    if (roots.length === 0) {
      continue;
    }
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
    const seen = held.get(event.pid);
    if (seen === undefined) {
      held.set(event.pid, { last: roots, webgl });
    } else {
      seen.first = seen.first ?? seen.last;
      seen.last = roots;
      if (webgl.length > 0) {
        seen.webgl = webgl;
      }
    }
  }
  const largest = (roots: DumpRoot[]): number => roots[0]?.bytes ?? 0;
  const memory = [...held]
    .map(([pid, dumps]): ProcessMemory => ({
      pid,
      process: names.get(pid) ?? `process ${pid}`,
      drawsThePage: dumps.webgl.length > 0,
      first: dumps.first ?? dumps.last,
      last: dumps.last,
      webgl: dumps.webgl,
    }))
    .sort((a, b) => largest(b.last) - largest(a.last));

  return {
    scenario,
    file,
    events: events.length,
    graphicsSlices,
    memory,
  };
};

const mebibytes = (bytes: number): string =>
  `${(bytes / (1024 * 1024)).toFixed(1)}MiB`;

/** Writes a traced scenario's findings as the lines that follow its numbers. */
export const formatTrace = (summary: TraceSummary): string => {
  const lines: string[] = [];
  lines.push(
    `  browser trace of ${summary.scenario} (${summary.events.toLocaleString()} events)`,
  );
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
  // The page lives in one renderer and its drawing is done by the graphics
  // process; the browser runs other renderers for pages this run never opened,
  // and its own helpers, none of which a change here moves.
  const worthReading = summary.memory.filter(
    (process) =>
      process.drawsThePage ||
      (process.process === "GPU Process" && process.last.length > 0),
  );
  if (worthReading.length > 0) {
    lines.push("    what the browser was holding, first dump → last:");
    for (const process of worthReading) {
      const which = process.drawsThePage ? " (drawing this page)" : "";
      lines.push(`      ${process.process}${which}`);
      for (const root of process.last) {
        const was =
          process.first.find((candidate) => candidate.name === root.name)
            ?.bytes ?? 0;
        lines.push(
          `        ${root.name.padEnd(24)} ${mebibytes(was).padStart(9)} → ${mebibytes(root.bytes).padStart(9)}`,
        );
      }
      if (process.webgl.length > 0) {
        lines.push(
          `        of which this page's own graphics objects: ` +
            process.webgl
              .map((kind) => `${kind.name} ${mebibytes(kind.bytes)}`)
              .join(", "),
        );
      }
    }
  }
  lines.push(`    whole trace written to ${summary.file}`);
  return lines.join("\n");
};
