// Merging a plane of voxel faces into as few rectangles as it takes to cover
// them, with no DOM, GPU or renderer dependency so it can be tested by filling
// a plane by hand.
//
// The mesher emits one quad per exposed face, and a slab of terrain shows
// thousands of faces that are the same tile shaded the same way. Any
// rectangle of those draws identically as one quad, and every vertex saved is
// bytes not built, not merged, not sent to the graphics card and not
// transformed while drawing.
//
// A face only joins a rectangle when it is shaded flat — all four of its
// corners equally lit. A face that varies across itself is left on its own,
// because stretching it would ramp its shading across the whole rectangle
// instead of repeating it cell by cell, which is a different picture.

/** What one rectangle of merged faces covers, and what it shows. */
export interface MergedRectangle {
  /** Where it starts, in cells along the plane's two axes. */
  first: number;
  second: number;
  /** How many cells it covers along each. */
  wide: number;
  tall: number;
  /** The voxel id every cell in it shows. */
  id: number;
  /**
   * The brightness every corner of it carries, or null for a face that is not
   * shaded flat — which is always a rectangle of one cell, left for the caller
   * to draw with its own corners.
   */
  shade: number | null;
}

/** Nothing is at this cell. */
const EMPTY = -1;
/** This cell holds a face that must not be merged with anything. */
const ALONE = Number.NaN;

/**
 * One plane of a chunk's faces: the faces exposed in one direction, from one
 * slice of the volume. Reused across slices, so a sweep allocates one.
 */
export class SlicePlane {
  private readonly ids: Int32Array;
  private readonly shades: Float64Array;
  private readonly taken: Uint8Array;

  /**
   * @param wide Cells along the plane's first axis.
   * @param tall Cells along its second.
   */
  constructor(
    readonly wide: number,
    readonly tall: number,
  ) {
    this.ids = new Int32Array(wide * tall);
    this.shades = new Float64Array(wide * tall);
    this.taken = new Uint8Array(wide * tall);
    this.clear();
  }

  /** Empties the plane, for the next slice to fill. */
  clear(): void {
    this.ids.fill(EMPTY);
    this.taken.fill(0);
  }

  /**
   * Records the face at one cell.
   *
   * @param first Its position along the plane's first axis.
   * @param second Its position along the second.
   * @param id The voxel id it shows.
   * @param corners Its four corner brightnesses, or null where nothing is lit.
   */
  set(
    first: number,
    second: number,
    id: number,
    corners: number[] | null,
  ): void {
    const at = second * this.wide + first;
    this.ids[at] = id;
    this.shades[at] =
      corners === null
        ? 1
        : corners.every((one) => one === corners[0])
          ? corners[0]
          : ALONE;
  }

  /**
   * Covers every face recorded with as few rectangles as a greedy sweep finds:
   * each one grows along the first axis while the faces match, then along the
   * second while whole rows of them match.
   *
   * @param report Called once per rectangle, in the order they are found.
   */
  eachRectangle(report: (rectangle: MergedRectangle) => void): void {
    for (let second = 0; second < this.tall; second++) {
      for (let first = 0; first < this.wide; first++) {
        const at = second * this.wide + first;
        const id = this.ids[at];
        if (id === EMPTY || this.taken[at] === 1) {
          continue;
        }
        const shade = this.shades[at];
        if (Number.isNaN(shade)) {
          this.taken[at] = 1;
          report({ first, second, wide: 1, tall: 1, id, shade: null });
          continue;
        }
        let wide = 1;
        while (first + wide < this.wide && this.matches(at + wide, id, shade)) {
          wide++;
        }
        let tall = 1;
        while (second + tall < this.tall) {
          const row = at + tall * this.wide;
          let whole = true;
          for (let step = 0; step < wide; step++) {
            if (!this.matches(row + step, id, shade)) {
              whole = false;
              break;
            }
          }
          if (!whole) {
            break;
          }
          tall++;
        }
        for (let row = 0; row < tall; row++) {
          this.taken.fill(1, at + row * this.wide, at + row * this.wide + wide);
        }
        report({ first, second, wide, tall, id, shade });
      }
    }
  }

  /** Whether the cell at `at` is a free face showing the same thing. */
  private matches(at: number, id: number, shade: number): boolean {
    return (
      this.taken[at] === 0 && this.ids[at] === id && this.shades[at] === shade
    );
  }
}
