// Collision against scripted props: the axis-aligned boxes a place stands in
// the world block the player where voxels cannot, because a prop is a model
// rather than part of the terrain. The player's physics only ever asks whether
// a point is solid and where the ground is, so a caller wraps its terrain
// samplers with these and the mover needs no knowledge of props at all.
/** An axis-aligned box a prop is solid over, in world units. */
export interface SolidBox {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  minZ: number;
  maxZ: number;
}

/** How far below a box's top still counts as standing on it, in world units. */
const TOUCH = 1e-3;

/** Whether a world point lies inside a solid box. */
export const boxContains = (
  box: SolidBox,
  x: number,
  y: number,
  z: number,
): boolean =>
  x >= box.minX &&
  x <= box.maxX &&
  y >= box.minY &&
  y <= box.maxY &&
  z >= box.minZ &&
  z <= box.maxZ;

/** Whether a world point lies inside any of `boxes`. */
export const solidBoxAt = (
  boxes: readonly SolidBox[],
  x: number,
  y: number,
  z: number,
): boolean => boxes.some((box) => boxContains(box, x, y, z));

/**
 * The highest box top at or below `y` over the column at (`x`, `z`), in world
 * units, or `-Infinity` when none stands there. Mirrors `groundHeightAt`, so a
 * player can stand on a bed or a counter the way they stand on a voxel.
 */
export const boxGroundAt = (
  boxes: readonly SolidBox[],
  x: number,
  y: number,
  z: number,
): number => {
  let best = -Infinity;
  for (const box of boxes) {
    if (
      x >= box.minX &&
      x <= box.maxX &&
      z >= box.minZ &&
      z <= box.maxZ &&
      box.maxY <= y + TOUCH &&
      box.maxY > best
    ) {
      best = box.maxY;
    }
  }
  return best;
};
