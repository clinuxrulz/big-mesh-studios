// Measures voxelscape on the real graphics card. Boots the production build
// once, then drives the player through each scenario against the same warm
// page and carries away what the in-app probe recorded.
//
//   pnpm bench                       # stand and walk at radius 3, about 20s
//   pnpm bench --all --repeat 3      # every scenario, three times each
//   pnpm bench walk sprint --radius 4
//   pnpm bench --profile phone       # as if on a mid-range phone
//   pnpm bench --unlocked            # draw without waiting for the display,
//                                    # so the gap measures what a frame costs
//   pnpm bench --scale 0.5           # pin the render scale somewhere else
//   pnpm bench --adaptive            # let the resolution scaler run, to
//                                    # measure the scaler itself
//   pnpm bench --at bcf5696          # measure some other commit, checked out
//                                    # beside this one, with this harness
//   pnpm bench --monsters            # leave the monsters in the world, to
//                                    # measure what they cost
//
// A commit is measured through the harness in this checkout, so the scenarios,
// the report and its page are whatever they are here; only the application
// being driven comes from the commit. A commit from before the application
// carried a bench surface cannot be measured, and shows up as the wait for
// that surface timing out.
//
// A headed browser is not optional: headless Chromium draws through a software
// rasterizer, where every frame is slow enough to drown the numbers being
// measured.
import { chromium } from "playwright";
import type { Browser, CDPSession, Page } from "playwright";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { outPath } from "../out-dir.ts";
import { QUICK_SCENARIOS, SCENARIOS, routeDistance } from "./scenarios.ts";
import type { Scenario } from "./scenarios.ts";
import { profileNamed } from "./profiles.ts";
import type { MachineProfile } from "./profiles.ts";
import { summarize } from "./summarize.ts";
import { formatReport, representativeIndex } from "./report.ts";
import type { BenchReport, ScenarioReport } from "./report.ts";
import type { PerfDrain } from "../../src/render/perf-probe.ts";
import {
  dumpMemory,
  formatTrace,
  startTrace,
  stopTrace,
  summarizeTrace,
} from "./trace.ts";
import type { TraceSummary } from "./trace.ts";
import { writeHtmlReport } from "./html.ts";

/** The application directory, whatever directory the script was started from. */
const APP_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

const DEFAULT_PORT = 4173;
/** How long to let the world settle after the window has finished loading. */
const SETTLE_MS = 1500;
/** How long past a route's own length to wait before draining, for the last frames. */
const DRAIN_SLACK_MS = 400;
/** The second of the 20-minute day the clock is pinned to: full daylight. */
const PINNED_TIME_SECONDS = 300;

/** The bench surface `create-voxelscape.ts` puts on the page under `#bench`. */
interface BenchWindow {
  loading(): { drawn: number; total: number; spawnDrawn: boolean };
  blockCount: number;
  chunkRadius: number;
  run(line: string): string | Promise<string>;
  queues(): {
    fillPending: number;
    fillInFlight: number;
    meshPending: number;
    meshInFlight: number;
    dirtySuperchunks: number;
  };
  probe: { arm(capacityFrames?: number): void; drain(): PerfDrain };
  drive(route: {
    heading: number;
    speed: number;
    turn: number;
    seconds: number;
  }): void;
}

interface Options {
  scenarios: Scenario[];
  repeat: number;
  radius: number;
  port: number;
  headless: boolean;
  profile: MachineProfile;
  /** The render scale to pin, or undefined to take the profile's. */
  scale?: number;
  /**
   * Whether to leave the resolution scaler adapting. Off by default: a scaler
   * free to lower the render scale answers a slower frame by drawing fewer
   * pixels, so a renderer that got slower reports the same frame time on a
   * smaller canvas and the regression never appears in the numbers.
   */
  adaptive: boolean;
  /**
   * Whether to let the browser draw as fast as it can rather than waiting for
   * the display. Waiting hides the cost of a frame behind the refresh rate;
   * not waiting turns the gap back into a measurement of what a frame costs.
   */
  unlocked: boolean;
  /**
   * Whether to record a browser trace around each scenario. The trace carries
   * what the graphics process does with the commands the page sends it, and
   * what every part of the browser is holding — including the driver's own
   * buffers and textures, which the page has no way to count.
   */
  trace: boolean;
  /** The commit to measure, if not the one this checkout stands on. */
  at?: string;
  /**
   * Whether to leave the world growing monsters. A monster walks where the
   * terrain and the frame rate take it and swings when it reaches the player,
   * so it puts a different fight into every run; the benchmark empties the
   * world of them unless this asks for them.
   */
  monsters: boolean;
}

const parseOptions = (argv: string[]): Options => {
  const named: string[] = [];
  let repeat = 1;
  let radius = 3;
  let port = DEFAULT_PORT;
  let headless = false;
  let all = false;
  let unlocked = false;
  let adaptive = false;
  let trace = false;
  let scale: number | undefined;
  let at: string | undefined;
  let monsters = false;
  let profile = profileNamed("native");
  for (let i = 0; i < argv.length; i++) {
    const argument = argv[i];
    if (argument === "--all") {
      all = true;
    } else if (argument === "--headless") {
      headless = true;
    } else if (argument === "--unlocked") {
      unlocked = true;
    } else if (argument === "--profile") {
      profile = profileNamed(argv[++i]);
    } else if (argument === "--adaptive") {
      adaptive = true;
    } else if (argument === "--trace") {
      trace = true;
    } else if (argument === "--scale") {
      scale = Number(argv[++i]);
    } else if (argument === "--repeat") {
      repeat = Number(argv[++i]);
    } else if (argument === "--radius") {
      radius = Number(argv[++i]);
    } else if (argument === "--port") {
      port = Number(argv[++i]);
    } else if (argument === "--at") {
      at = argv[++i];
    } else if (argument === "--monsters") {
      monsters = true;
    } else if (argument.startsWith("--")) {
      throw new Error(`unknown option ${argument}`);
    } else {
      named.push(argument);
    }
  }
  const wanted = all
    ? SCENARIOS.map((scenario) => scenario.name)
    : named.length > 0
      ? named
      : QUICK_SCENARIOS;
  const scenarios = wanted.map((name) => {
    const scenario = SCENARIOS.find((candidate) => candidate.name === name);
    if (scenario === undefined) {
      throw new Error(
        `no scenario named ${name}; there is ${SCENARIOS.map((s) => s.name).join(", ")}`,
      );
    }
    return scenario;
  });
  return {
    scenarios,
    repeat,
    radius,
    port,
    headless,
    profile,
    unlocked,
    adaptive,
    trace,
    scale,
    at,
    monsters,
  };
};

const git = (...args: string[]): string =>
  execFileSync("git", args, { cwd: APP_DIR, encoding: "utf8" }).trim();

/** Where a commit checked out to be measured is kept. */
const WORKTREE_DIR = join(APP_DIR, "..", "..", ".worktrees");

/** The application a run measures, and what the report says it was. */
interface Subject {
  /** The application directory to build and serve. */
  dir: string;
  /** The commit the report is stamped with, short. */
  commit: string;
  /** Whether that directory carries changes the commit does not. */
  dirty: boolean;
}

/** The checkout the harness is being read from, changes and all. */
const thisCheckout = (): Subject => ({
  dir: APP_DIR,
  commit: git("rev-parse", "--short", "HEAD"),
  dirty: git("status", "--porcelain") !== "",
});

/**
 * Checks `revision` out into a worktree of its own and installs what it asks
 * for, so a run can measure a commit without disturbing the checkout being
 * worked in. What a commit depends on belongs to it as much as its source
 * does — the renderer the world draws through is a package like any other,
 * and two commits can name different versions of it — so the worktree gets
 * its own installation rather than borrowing this one's.
 *
 * The worktree is left behind, and a later run of the same commit reuses it
 * as it stands; `git worktree remove` clears one out.
 *
 * @param revision Anything git can resolve to a commit.
 * @returns The application under test in that worktree.
 */
const checkOut = (revision: string): Subject => {
  const commit = git("rev-parse", "--short", `${revision}^{commit}`);
  const worktree = join(WORKTREE_DIR, `bench-${commit}`);
  if (!existsSync(worktree)) {
    console.log(`checking ${commit} out into ${worktree}`);
    execFileSync("git", ["worktree", "add", "--detach", worktree, commit], {
      cwd: APP_DIR,
      stdio: "inherit",
    });
    execFileSync("pnpm", ["install", "--frozen-lockfile"], {
      cwd: worktree,
      stdio: "inherit",
    });
  }
  return { dir: join(worktree, "apps", "voxelscape"), commit, dirty: false };
};

/** The most recently changed file anywhere under a directory. */
const newestChange = (directory: string): number => {
  let newest = 0;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    newest = Math.max(
      newest,
      entry.isDirectory() ? newestChange(path) : statSync(path).mtimeMs,
    );
  }
  return newest;
};

/** Builds the site in `dir` when its sources have moved on since its last build. */
const buildIfStale = (dir: string): void => {
  const built = join(dir, "dist", "index.html");
  if (
    existsSync(built) &&
    statSync(built).mtimeMs > newestChange(join(dir, "src"))
  ) {
    return;
  }
  console.log("building the site (sources are newer than the last build)");
  execFileSync("pnpm", ["build"], { cwd: dir, stdio: "inherit" });
};

const answers = async (url: string): Promise<boolean> => {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(1000) });
    return response.ok;
  } catch {
    return false;
  }
};

/**
 * A preview server on the wanted port: the one already running if there is
 * one, or a new one this run starts and stops again.
 */
const serve = async (port: number, subject: Subject): Promise<() => void> => {
  const url = `http://127.0.0.1:${port}/`;
  if (await answers(url)) {
    // A server that was already up is serving a build nothing here chose, so
    // a run that was asked for one particular commit cannot take it on trust.
    if (subject.dir !== APP_DIR) {
      throw new Error(
        `something already answers on port ${port}, and a run measuring ${subject.commit} cannot tell which build that is; stop it, or pass --port`,
      );
    }
    console.log(`using the preview server already on port ${port}`);
    return () => {};
  }
  buildIfStale(subject.dir);
  const server = spawn("pnpm", ["serve", "--port", String(port)], {
    cwd: subject.dir,
    stdio: "ignore",
  });
  for (let attempt = 0; attempt < 60; attempt++) {
    if (await answers(url)) {
      return () => server.kill();
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  server.kill();
  throw new Error(`the preview server never answered on port ${port}`);
};

/** Waits until every block of the initial window has been generated and drawn. */
const waitForWindow = async (page: Page): Promise<void> => {
  await page.waitForFunction(
    () =>
      (window as unknown as { __voxelscape?: object }).__voxelscape !==
      undefined,
    undefined,
    { timeout: 120000 },
  );
  await page.waitForFunction(
    () => {
      const bench = (window as unknown as { __voxelscape: BenchWindow })
        .__voxelscape;
      const progress = bench.loading();
      return progress.spawnDrawn && progress.drawn >= progress.total;
    },
    undefined,
    { timeout: 180000 },
  );
};

/**
 * Holds still everything that would otherwise differ between two runs of the
 * same commit: the render scale (the adaptive scaler would absorb a slower
 * renderer as a smaller canvas instead of a slower frame), the time of day,
 * and the weather.
 *
 * @returns What the world said about its worker pool, for the report.
 */
const pinConditions = async (
  page: Page,
  pins: {
    scale: number;
    adaptive: boolean;
    timeSeconds: number;
    workers?: number;
    monsters: boolean;
  },
): Promise<{ workers: string; monsters: string }> =>
  page.evaluate(async (pins) => {
    const bench = (window as unknown as { __voxelscape: BenchWindow })
      .__voxelscape;
    await bench.run(
      pins.adaptive
        ? "/render:resolution auto"
        : `/render:resolution ${pins.scale}`,
    );
    await bench.run("/clock:speed 0");
    await bench.run(`/clock:time ${pins.timeSeconds}`);
    await bench.run("/weather clear");
    if (pins.workers !== undefined) {
      await bench.run(`/world:workers ${pins.workers}`);
    }
    const monsters = pins.monsters
      ? "monsters: left in the world"
      : String(await bench.run("/monsters:spawning off"));
    return { workers: String(await bench.run("/world:workers")), monsters };
  }, pins);

/**
 * Waits for the terrain the previous scenario asked for to finish arriving.
 * A scenario that starts while the last one's fills are still landing measures
 * that backlog instead of its own, and reports terrain it never asked for.
 *
 * Superchunks left dirty are not waited on: one the camera cannot see stays
 * dirty by design until the camera turns onto it, so a standing player never
 * reaches zero.
 */
const waitForQuiet = async (page: Page): Promise<void> => {
  await page.waitForFunction(
    () => {
      const bench = (window as unknown as { __voxelscape: BenchWindow })
        .__voxelscape;
      const queues = bench.queues();
      return (
        queues.fillPending === 0 &&
        queues.fillInFlight === 0 &&
        queues.meshPending === 0 &&
        queues.meshInFlight === 0
      );
    },
    undefined,
    { timeout: 120000 },
  );
};

/** Runs one scenario once and carries away what the probe recorded. */
const measure = async (
  page: Page,
  scenario: Scenario,
  tracing: { cdp: CDPSession; file: string } | undefined,
): Promise<{ drain: PerfDrain; trace?: TraceSummary }> => {
  await waitForQuiet(page);
  await page.waitForTimeout((scenario.settleSeconds ?? 0.5) * 1000);
  const events = tracing === undefined ? [] : await startTrace(tracing.cdp);
  if (tracing !== undefined) {
    await dumpMemory(tracing.cdp);
  }
  await page.evaluate((route) => {
    const bench = (window as unknown as { __voxelscape: BenchWindow })
      .__voxelscape;
    bench.probe.arm();
    bench.drive(route);
  }, scenario.route);
  await page.waitForTimeout(scenario.route.seconds * 1000 + DRAIN_SLACK_MS);
  const drain = await page.evaluate(() => {
    const bench = (window as unknown as { __voxelscape: BenchWindow })
      .__voxelscape;
    return bench.probe.drain();
  });
  if (tracing === undefined) {
    return { drain };
  }
  await dumpMemory(tracing.cdp);
  await stopTrace(tracing.cdp);
  writeFileSync(tracing.file, JSON.stringify(events));
  return { drain, trace: summarizeTrace(events, tracing.file) };
};

const describeMachine = (page: Page) =>
  page.evaluate(() => {
    const canvas = document.createElement("canvas");
    const gl = canvas.getContext("webgl2");
    const info = gl?.getExtension("WEBGL_debug_renderer_info");
    const bench = (window as unknown as { __voxelscape: BenchWindow })
      .__voxelscape;
    return {
      graphicsCard:
        info === null || info === undefined || gl === null
          ? "unknown graphics card"
          : String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)),
      cores: navigator.hardwareConcurrency ?? 0,
      blockCount: bench.blockCount,
      chunkRadius: bench.chunkRadius,
    };
  });

const main = async (): Promise<void> => {
  const options = parseOptions(process.argv.slice(2));
  const subject =
    options.at === undefined ? thisCheckout() : checkOut(options.at);
  const stopServer = await serve(options.port, subject);
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch({
      headless: options.headless,
      // Left to itself the browser waits for the display, so every frame
      // reads as the refresh period however little work it did. Told not to
      // wait, the gap between frames becomes the frame's actual cost —
      // including the graphics card's part of it, which is the only way to
      // see that cost where the card refuses to time itself.
      args: options.unlocked
        ? ["--disable-gpu-vsync", "--disable-frame-rate-limit"]
        : [],
    });
    const viewport = options.profile.viewport;
    const page = await browser.newPage({
      viewport,
      deviceScaleFactor: options.profile.devicePixelRatio,
    });
    const url = `http://127.0.0.1:${options.port}/?radius=${options.radius}#bench`;
    console.log(`loading ${url}`);
    await page.goto(url, { waitUntil: "load", timeout: 60000 });
    await waitForWindow(page);
    console.log("window loaded; settling");
    await page.waitForTimeout(SETTLE_MS);
    const scale = options.scale ?? options.profile.scale;
    const pinned = await pinConditions(page, {
      scale,
      adaptive: options.adaptive,
      timeSeconds: PINNED_TIME_SECONDS,
      workers: options.profile.workers,
      monsters: options.monsters,
    });
    // A build older than the command does not know how to put its monsters
    // away, and would be measured with a fight in it against one that was
    // not. Better to stop than to report two runs as comparable.
    if (!options.monsters && pinned.monsters.startsWith("unknown command")) {
      throw new Error(
        "this build cannot empty the world of monsters, so its numbers would carry a fight the other run does not; measure it with --monsters, and the other run too",
      );
    }
    console.log(pinned.monsters);
    const machine = await describeMachine(page);
    // The processor is slowed only once the window has loaded. Boot would
    // otherwise take the slowdown too, and what is being measured is a world
    // already standing, not the wait to reach it.
    if (options.profile.cpuThrottle > 1) {
      const cdp = await page.context().newCDPSession(page);
      await cdp.send("Emulation.setCPUThrottlingRate", {
        rate: options.profile.cpuThrottle,
      });
      console.log(
        `processor slowed ${options.profile.cpuThrottle} times for the ${options.profile.name} profile`,
      );
    }

    // One session for the whole run: a trace is recorded through it, and the
    // processor throttle above was set through another on the same page.
    const traceCdp = options.trace
      ? await page.context().newCDPSession(page)
      : undefined;
    const scenarios: ScenarioReport[] = [];
    const traces: TraceSummary[] = [];
    for (const scenario of options.scenarios) {
      const repeats = [];
      const drains: PerfDrain[] = [];
      for (let repeat = 0; repeat < options.repeat; repeat++) {
        process.stdout.write(
          `measuring ${scenario.name} (${repeat + 1}/${options.repeat})…\n`,
        );
        // Only the first repeat is traced: recording costs time of its own,
        // and one trace answers what a trace is asked.
        const tracing =
          traceCdp !== undefined && repeat === 0
            ? {
                cdp: traceCdp,
                file: outPath(`trace-${scenario.name}-${Date.now()}.json`),
              }
            : undefined;
        const measured = await measure(page, scenario, tracing);
        repeats.push(summarize(measured.drain));
        drains.push(measured.drain);
        if (measured.trace !== undefined) {
          traces.push(measured.trace);
        }
      }
      const reported = drains[representativeIndex(repeats)];
      scenarios.push({
        name: scenario.name,
        description: scenario.description,
        expectedUnits: routeDistance(scenario.route),
        repeats,
        samples: {
          rows: reported.rows,
          rowStride: reported.rowStride,
          fieldNames: reported.fieldNames,
          phaseNames: reported.phaseNames,
        },
      });
    }

    // Nothing past this point measures anything, and writing the report takes
    // long enough to notice, so the window goes away as soon as the last
    // scenario has been drained rather than at the end of the run.
    await browser.close();
    browser = undefined;

    const report: BenchReport = {
      context: {
        commit: subject.commit,
        dirty: subject.dirty,
        finishedAt: new Date().toISOString(),
        graphicsCard: machine.graphicsCard,
        cores: machine.cores,
        viewport,
        chunkRadius: machine.chunkRadius,
        blockCount: machine.blockCount,
        pinnedScale: scale,
        adaptiveResolution: options.adaptive,
        workers: pinned.workers,
        profile: options.profile.name,
        cpuThrottle: options.profile.cpuThrottle,
        pacing: options.unlocked ? "unlocked" : "paced",
        monsters: options.monsters,
      },
      scenarios,
    };

    const file = outPath(`bench-${report.context.commit}-${Date.now()}.json`);
    writeFileSync(file, JSON.stringify(report, null, 2));
    const drawn = await writeHtmlReport(
      report,
      traces,
      file.replace(/\.json$/, ".html"),
    );
    const traceLines =
      traces.length === 0 ? "" : `\n\n${traces.map(formatTrace).join("\n\n")}`;
    console.log(
      `\n${formatReport(report)}${traceLines}\n\nwritten to ${file}\ndrawn in ${drawn}`,
    );
  } finally {
    await browser?.close();
    stopServer();
  }
};

main().catch((error) => {
  console.error("bench failed:", error);
  process.exit(1);
});
