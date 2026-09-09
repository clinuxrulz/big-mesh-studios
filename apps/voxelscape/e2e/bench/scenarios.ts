import type { BenchRoute } from "../../src/voxelscape/create-voxelscape.ts";

/** The player's walking speed, matching `PlayerConfig`'s default. */
const WALK_SPEED = 22.5;

/** World units along one axis of a chunk cell, from `BLOCK_WORLD`. */
const CELL_UNITS = 128;

/** One measured stretch of play: what the player does, and for how long. */
export interface Scenario {
  name: string;
  /** What this scenario puts under load, in one line, printed above its numbers. */
  description: string;
  /** How the player is driven while it runs. */
  route: BenchRoute;
  /** Seconds to settle after the route is set before the probe starts recording. */
  settleSeconds?: number;
}

/**
 * The scenarios a run can measure, each one isolating a different demand on
 * the frame: drawing what is already there, streaming terrain being walked
 * into, streaming faster than a walk, and merging the geometry a turning
 * camera brings into view.
 */
export const SCENARIOS: Scenario[] = [
  {
    name: "stand",
    description: "still, on loaded terrain — what a frame costs to draw alone",
    route: { heading: 0, speed: 0, turn: 0, seconds: 5 },
  },
  {
    name: "walk",
    description: "walking forward — streaming the terrain being walked into",
    route: { heading: 0, speed: WALK_SPEED, turn: 0, seconds: 8 },
  },
  {
    name: "sprint",
    description:
      "forward at three times walking pace — outrunning the streaming",
    route: { heading: 0, speed: WALK_SPEED * 3, turn: 0, seconds: 8 },
  },
  {
    name: "turn",
    description: "still, turning a full circle — merging what comes into view",
    route: { heading: 0, speed: 0, turn: (Math.PI * 2) / 6, seconds: 6 },
  },
  {
    name: "diagonal",
    description:
      "walking across the cell grid — crossing two boundaries at once",
    route: { heading: Math.PI / 4, speed: WALK_SPEED * 2, turn: 0, seconds: 8 },
  },
];

/** The scenarios a run measures when the caller names none. */
export const QUICK_SCENARIOS = ["stand", "walk"];

/** How many world units a route covers, for reporting what a run should have travelled. */
export const routeDistance = (route: BenchRoute): number =>
  route.speed * route.seconds;

/** How many chunk cells a route crosses, which is what makes it stream. */
export const routeCells = (route: BenchRoute): number =>
  routeDistance(route) / CELL_UNITS;
