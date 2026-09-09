// Headless check of the reported "player outruns chunk generation after the
// window has fully loaded". Boots the real `ChunkSphere` the way
// `bench-walk-sim.ts` does (synchronous-fallback fills, one block per
// macrotask — how worker results land one per message) and walks the player
// forward at the game's real speed for 30 simulated seconds, asking each step
// whether the cell the player is standing in has streamed in yet. If the
// streaming keeps up, the player's cell is always ready on arrival; an outrun
// shows up as a run of steps where it is not.
//
//   node_modules/.bin/esbuild --bundle --platform=node --format=cjs \
//     --outfile=/tmp/voxel-outrun.cjs e2e/outrun-sim.ts
//   node /tmp/voxel-outrun.cjs
import { BLOCK_WORLD, chunkCellOf } from "../src/world/level-data";
import { ChunkSphere } from "../src/world/chunk-sphere";
import { DEFAULT_TERRAIN } from "../src/world/noise";

const DT = 1 / 60;
const WALK_SPEED = 22.5;
const WALK_SECONDS = 30;
const drainFills = async (): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, 0));
};

const main = async (): Promise<void> => {
  const readySlots = new Set<number>();
  const sphere = new ChunkSphere({
    radius: 4,
    yRadius: 2,
    terrain: DEFAULT_TERRAIN,
    onBlockReposition: (index) => {
      // Same reset the world performs so a recycled slot never answers for its
      // previous cell's terrain between the reposition and its fill landing.
      const block = sphere.blocks[index];
      block.store.reset();
      block.light.skylight.fill(0);
      block.light.blocklight.fill(0);
      readySlots.delete(index);
    },
    onBlockRelease: (index) => {
      readySlots.delete(index);
    },
    onBlockChanged: (index) => {
      readySlots.add(index);
    },
  });

  const bootT = performance.now();
  sphere.fillFrom(0, 0, 0);
  // The initial window fills through the synchronous fallback, one block per
  // macrotask until the whole window is streamed — the "all chunks loaded"
  // starting point the walk begins from.
  let guarded = 0;
  while (readySlots.size < sphere.blocks.length) {
    if (++guarded > 1_000_000) {
      throw new Error("initial window never finished filling");
    }
    await drainFills();
  }
  const fillAllMs = performance.now() - bootT;
  const chunkCount = sphere.blocks.length;

  let playerX = 0;
  let playerY = sphere.blocks[0].targetLod === 0 ? 0 : 0;
  const playerZ = 0;
  const readyOf = (): boolean => {
    const slot = sphere.slotAt(playerX, playerY, playerZ);
    return slot !== undefined && readySlots.has(slot);
  };

  const steps: Array<{ ready: boolean; cell: string }> = [];
  let unready = 0;
  let longestRun = 0;
  let run = 0;
  let crossings = 0;
  let lastCell = "";
  for (let s = 0; s < WALK_SECONDS * 60; s++) {
    playerX += WALK_SPEED * DT;
    const cell = chunkCellOf(playerX, playerY, playerZ).join(",");
    if (cell !== lastCell) {
      crossings++;
      lastCell = cell;
    }
    sphere.scrollTo(playerX, playerY, playerZ);
    await drainFills();
    const ready = readyOf();
    steps.push({ ready, cell: lastCell });
    if (!ready) {
      unready++;
      run++;
      longestRun = Math.max(longestRun, run);
    } else {
      run = 0;
    }
  }
  // Let the last crossing's fills land so the tail is counted.
  for (let i = 0; i < 240; i++) {
    await drainFills();
  }

  const chunks = playerX / BLOCK_WORLD[0];
  console.log(
    `window: ${chunkCount} blocks filled in ${(fillAllMs / 1000).toFixed(1)}s; ` +
      `walked ${chunks.toFixed(2)} chunks (${playerX.toFixed(0)} units) in ${WALK_SECONDS}s`,
  );
  console.log(`chunk-boundary crossings: ${crossings}`);
  console.log(
    `steps in an unstreamed cell: ${unready} of ${steps.length} ` +
      `(${((unready / steps.length) * 100).toFixed(1)}%); longest run ${longestRun} steps (${(longestRun / 60).toFixed(2)}s)`,
  );
  const unreadyCells = new Set(
    steps.filter((s) => !s.ready).map((s) => s.cell),
  );
  console.log(`distinct unstreamed cells: ${unreadyCells.size}`);
  if (unready === 0) {
    console.log(
      "result: streaming kept the player's cell ready the whole walk",
    );
  } else {
    const first = steps.findIndex((s) => !s.ready);
    console.log(
      `result: player outran generation (first unready step ${(first / 60).toFixed(2)}s in)`,
    );
    process.exitCode = 1;
  }
};

main().catch((e) => {
  console.error("outrun sim failed:", e);
  process.exit(1);
});
