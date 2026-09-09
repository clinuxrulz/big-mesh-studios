// Reproduces the reported "player outruns chunk generation while walking
// forward" after the window has fully loaded. Boots the production build
// served by `vite preview` (the default URL below), walks forward holding W,
// and samples every frame the player's own cell readiness plus the two cells
// directly ahead. If the streaming keeps up, the player's cell is streamed
// before they arrive and never reads as not-ready while walking; an outrun
// shows up as stretches where the player's cell -- or the cells just ahead --
// are still unstreamed.
//
//   node --experimental-transform-types e2e/outrun.ts
//
// Load the page with `#bench` so the world hands itself to the script.
import { chromium } from "playwright";

const URL = process.env.BENCH_URL ?? "http://127.0.0.1:4173/#bench";
const WALK_MS = 30000;
const READY_WAIT_PROBE_EVERY_MS = 100;

const main = async () => {
  const browser = await chromium.launch({ headless: false });
  const page = await browser.newPage({
    viewport: { width: 1024, height: 576 },
  });
  await page.goto(URL, { waitUntil: "load", timeout: 60000 });
  await page.waitForFunction(() => (window as any).__voxelscape !== undefined, {
    timeout: 120000,
  });
  const info = await page.evaluate(() => {
    const v = (window as any).__voxelscape;
    return {
      blocks: v.blockCount,
      radius: v.chunkRadius,
      yRadius: v.chunkRadiusY,
    };
  });
  console.log(
    `window: ${info.blocks} blocks at radius ${info.radius} (y ${info.yRadius})`,
  );

  await page.waitForFunction(
    () =>
      !document.body.innerText.includes("generating terrain") &&
      !document.body.innerText.includes("blocks to go"),
    { timeout: 120000 },
  );
  console.log("initial window fully loaded; standing 2s to settle");
  await page.waitForTimeout(2000);

  // Sample loop on the page: player position and readiness of the player's
  // cell and of the two cells directly ahead, every frame.
  await page.evaluate(() => {
    const v = (window as any).__voxelscape;
    const out: Array<{
      t: number;
      x: number;
      y: number;
      z: number;
      here: boolean;
      ahead: boolean;
      farAhead: boolean;
    }> = ((window as any).__samples = []);
    (window as any).__sample = () => {
      const p = v.player;
      out.push({
        t: performance.now(),
        x: Math.round(p.x),
        y: Math.round(p.y),
        z: Math.round(p.z),
        here: v.cellReady(p.x, p.y, p.z),
        ahead: v.cellReady(p.x + 128, p.y, p.z),
        farAhead: v.cellReady(p.x + 256, p.y, p.z),
      });
    };
  });

  // One standing measurement (baseline), then walk. When BENCH_FAST is set,
  // the player position is pushed forward at a fixed rate (two and a half
  // times walk speed) rather than relying on frame-rate-bound keyboard input,
  // so a slow software renderer cannot mask how the streaming prioritizes the
  // cells being moved into.
  await page.evaluate(() => (window as any).__sample());
  const fast = process.env.BENCH_FAST === "1";
  if (fast) {
    console.log("teleporting forward at 2.5x walk speed for 20s");
    const fastTimer = setInterval(async () => {
      await page.evaluate(() => {
        const v = (window as any).__voxelscape;
        v.player.x += 56.25;
        (window as any).__sample();
      });
    }, 1000);
    await page.waitForTimeout(20000);
    clearInterval(fastTimer);
  } else {
    console.log(`walking forward for ${WALK_MS / 1000}s ("w" held)`);
    await page.keyboard.down("w");
    const timer = setInterval(
      () => page.evaluate(() => (window as any).__sample()).catch(() => {}),
      READY_WAIT_PROBE_EVERY_MS,
    );
    await page.waitForTimeout(WALK_MS);
    clearInterval(timer);
    await page.keyboard.up("w");
  }
  const samples: Array<{
    t: number;
    x: number;
    y: number;
    z: number;
    here: boolean;
    ahead: boolean;
    farAhead: boolean;
  }> = await page.evaluate(() => (window as any).__samples);
  await browser.close();

  if (samples.length < 2) {
    console.error("no samples collected");
    process.exit(1);
  }

  const t0 = samples[0].t;
  const started = { x: samples[0].x, z: samples[0].z };
  const ended = samples[samples.length - 1];
  const distance = Math.hypot(ended.x - started.x, ended.z - started.z);
  const cells = distance / 128;
  const duration = (ended.t - t0) / 1000;
  console.log(
    `walked ${distance.toFixed(0)} units (${cells.toFixed(2)} cells) in ${duration.toFixed(1)}s`,
  );

  const hereUnready = samples.filter((s) => !s.here);
  const aheadUnready = samples.filter((s) => !s.ahead);
  const farAheadUnready = samples.filter((s) => !s.farAhead);
  const longestRun = (
    pred: (s: (typeof samples)[number]) => boolean,
  ): number => {
    let best = 0;
    let run = 0;
    for (const s of samples) {
      run = pred(s) ? run + 1 : 0;
      best = Math.max(best, run);
    }
    return best;
  };
  console.log(
    `samples n=${samples.length}; standing baseline: here=${samples[0].here} ahead=${samples[0].ahead} farAhead=${samples[0].farAhead}`,
  );
  console.log(
    `player cell unready: ${hereUnready.length} samples (${((hereUnready.length * READY_WAIT_PROBE_EVERY_MS) / 1000).toFixed(1)}s), longest run ${longestRun((s) => !s.here) * READY_WAIT_PROBE_EVERY_MS}ms`,
  );
  console.log(
    `1-ahead unready: ${aheadUnready.length} samples, longest ${longestRun((s) => !s.ahead) * READY_WAIT_PROBE_EVERY_MS}ms`,
  );
  console.log(
    `2-ahead unready: ${farAheadUnready.length} samples, longest ${longestRun((s) => !s.farAhead) * READY_WAIT_PROBE_EVERY_MS}ms`,
  );
  const gaps = samples.filter((s) => !s.here);
  if (gaps.length >= 2) {
    console.log(
      `first unready stretch: t=${((gaps[0].t - t0) / 1000).toFixed(1)}s at x=${gaps[0].x} z=${gaps[0].z}, then every ${(gaps[0].t - t0) / 1000}..${(gaps[gaps.length - 1].t - t0) / 1000}s`,
    );
  }
  if (hereUnready.length === 0) {
    console.log(
      "result: streaming kept the player's cell ready the whole walk",
    );
  } else {
    console.log(
      `result: player walked into unstreamed terrain ${((hereUnready.length / samples.length) * 100).toFixed(0)}% of the time`,
    );
    process.exitCode = 1;
  }
};

main().catch((e) => {
  console.error("outrun probe failed:", e);
  process.exit(1);
});
