// Profiles the main thread while the player walks forward through terrain that
// was already fully loaded before the walk began, to find the code to focus
// optimisation effort on. Requires the production build served by `vite
// preview` (the default `URL`/port below).
//
//   node --experimental-transform-types e2e/profile-walk.ts
//
// A headed Chromium (a real GPU path) gives frame times close to the player's;
// headless SwiftShader is so slow that every frame is a long task. A viewport
// of 1024x576 matches a realistic window.
//
// The walk does not start until the loading overlay reports that every block
// of the initial chunk window has been generated and drawn ("blocks to go"
// counts down to nothing), so what is profiled is steady-state forward travel
// plus the chunk streaming it triggers — not the startup fill.
import { chromium } from "playwright";
import { outPath } from "./out-dir.ts";

const URL = process.env.BENCH_URL ?? "http://127.0.0.1:4173/";
const STAND_MS = 12000;
const WALK_MS = 16000;
const LONG_TASK_MS = 50;
const SETTLE_MS = 1500;
/** When set, profiles a standing player instead of a walking one (a control run). */
const STAND_PROFILE = process.env.STAND_PROFILE === "1";

const installCollectors = (page: import("playwright").Page) =>
  page.evaluate(() => {
    const w = window as any;
    w.__active = null;
    w.__standing = { long: [], frames: [] };
    w.__walking = { long: [], frames: [] };
    new PerformanceObserver((list) => {
      const active = w.__active;
      if (!active) return;
      for (const e of list.getEntries()) {
        active.long.push({ start: e.startTime, dur: e.duration });
      }
    }).observe({ type: "longtask", buffered: true });
    let last = performance.now();
    const tick = () => {
      const now = performance.now();
      const active = w.__active;
      if (active) active.frames.push(now - last);
      last = now;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });

const setPhase = (page: import("playwright").Page, p: "standing" | "walking") =>
  page.evaluate(
    (p) => ((window as any).__active = (window as any)[`__${p}`]),
    p,
  );

/**
 * The initial chunk window is loaded when neither the "generating terrain"
 * cover nor the "N blocks to go" toast is in the DOM, and it has stayed that
 * way for a settle pause. The settle pause matters: the cover and the toast
 * are two different mounts and the progress number updates on every block, so
 * a single observation could land between updates; a whole settle period with
 * neither element is what proves the fill is actually over.
 */
const waitForChunksLoaded = async (page: import("playwright").Page) => {
  await page.goto(URL, { waitUntil: "load", timeout: 60000 });
  await page.waitForFunction(
    () => !document.body.innerText.includes("generating terrain"),
    { timeout: 120000 },
  );
  for (let attempt = 0; attempt < 20; attempt++) {
    await page.waitForFunction(
      () => !document.body.innerText.includes("blocks to go"),
      { timeout: 120000 },
    );
    await page.waitForTimeout(SETTLE_MS);
    const stillLoading = await page.evaluate(
      () =>
        document.body.innerText.includes("generating terrain") ||
        document.body.innerText.includes("blocks to go"),
    );
    if (!stillLoading) {
      return;
    }
  }
  throw new Error("chunk window never finished loading");
};

const summarize = (
  label: string,
  data: { long: { start: number; dur: number }[]; frames: number[] },
) => {
  const frames = data.frames.filter((f) => f >= 0).sort((a, b) => a - b);
  const pct = (p: number) =>
    frames[Math.min(frames.length - 1, Math.floor(frames.length * p))];
  const long = data.long.filter((l) => l.dur >= LONG_TASK_MS);
  const total = long.reduce((s, l) => s + l.dur, 0);
  const max = long.reduce((a, b) => Math.max(a, b.dur), 0);
  console.log(
    `[${label}] frames p50=${frames.length ? pct(0.5).toFixed(1) : "n/a"}ms p95=${frames.length ? pct(0.95).toFixed(1) : "n/a"}ms p99=${frames.length ? pct(0.99).toFixed(1) : "n/a"}ms | longtasks n=${long.length} total=${(total / 1000).toFixed(2)}s max=${(max / 1000).toFixed(2)}s`,
  );
};

const main = async () => {
  const browser = await chromium.launch({ headless: false, args: [] });
  const page = await browser.newPage({
    viewport: { width: 1024, height: 576 },
  });
  await waitForChunksLoaded(page);
  console.log("initial chunk window fully loaded; standing baseline begins");
  await installCollectors(page);

  await setPhase(page, "standing");
  await page.waitForTimeout(STAND_MS);

  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Profiler.enable");
  await cdp.send("Profiler.setSamplingInterval", { interval: 200 });
  await cdp.send("Profiler.start");
  console.log(
    `CPU profiler started; ${STAND_PROFILE ? "standing still" : "walking forward"} for ${WALK_MS / 1000}s`,
  );

  await setPhase(page, "walking");
  if (!STAND_PROFILE) {
    await page.keyboard.down("w");
  }
  await page.waitForTimeout(WALK_MS);
  if (!STAND_PROFILE) {
    await page.keyboard.up("w");
  }

  const { profile } = (await cdp.send("Profiler.stop")) as {
    profile: unknown;
  };
  const fs = await import("node:fs");
  const outFile = outPath(
    STAND_PROFILE ? "voxel-stand-profile.json" : "voxel-walk-profile.json",
  );
  fs.writeFileSync(outFile, JSON.stringify(profile));
  console.log(`CPU profile written to ${outFile}`);

  const standing = await page.evaluate(() => (window as any).__standing);
  const walking = await page.evaluate(() => (window as any).__walking);
  summarize(`standing ${STAND_MS / 1000}s`, standing);
  summarize(`walking ${WALK_MS / 1000}s`, walking);
  await browser.close();
};

main().catch((e) => {
  console.error("profile failed:", e);
  process.exit(1);
});
