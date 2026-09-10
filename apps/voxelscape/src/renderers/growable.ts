// A growable typed array, and the only way geometry is accumulated in this
// world: the mesher writes its vertices into one of these in a worker, and the
// merger appends a landed block's into a superchunk's. Both used to build boxed
// numbers first and copy them to typed arrays afterwards, which cost eight bytes
// an entry to hold and a pass over every one of them to convert.
//
// A builder is worth reusing. The buffer doubles when it fills, so a builder
// that has met the largest block a worker will see never grows again, and
// `clear` empties it for the next block without giving the buffer back.
//
// The `writeAt` half is for the other kind of caller: one filling a run that
// something already left room for — a superchunk writing a member's vertices
// into the space a retired member freed — where the length does not move.

/**
 * A growable typed array: appends into a buffer that doubles when full, so a
 * landed chunk's arrays are merged straight into float/uint buffers instead of
 * boxed numbers that then get copied to typed arrays at upload. The logical
 * length is tracked separately from the capacity, and `array()` returns a
 * view of exactly the written elements.
 */
export class Growable<
  T extends Float32Array | Uint32Array | Uint16Array | Uint8Array,
> {
  private buf: T;
  private readonly ctor: new (size: number) => T;
  private readonly chunk: number;
  length = 0;

  constructor(ctor: new (size: number) => T, chunk = 512) {
    this.ctor = ctor;
    this.chunk = chunk;
    this.buf = new ctor(chunk);
  }

  /** Grows the backing buffer so at least `amount` more elements fit. */
  private growBy(amount: number): void {
    const needed = this.length + amount;
    if (needed <= this.buf.length) {
      return;
    }
    let size = this.buf.length;
    while (size < needed) {
      size = Math.max(size * 2, this.chunk);
    }
    const next = new this.ctor(size);
    next.set(this.buf.subarray(0, this.length));
    this.buf = next;
  }

  /** Appends `values` as-is (a member's positions, lanes or coordinates). */
  pushMany(values: ArrayLike<number>): void {
    this.growBy(values.length);
    this.buf.set(values, this.length);
    this.length += values.length;
  }

  /** Appends `values`, shifting each by `shift` (indices are re-based). */
  pushShifted(values: ArrayLike<number>, shift: number): void {
    this.growBy(values.length);
    for (let i = 0; i < values.length; i++) {
      this.buf[this.length + i] = values[i] + shift;
    }
    this.length += values.length;
  }

  /** Appends positions shifted per component by `(dx, dy, dz)`. */
  pushOffset(
    values: ArrayLike<number>,
    dx: number,
    dy: number,
    dz: number,
  ): void {
    this.growBy(values.length);
    for (let i = 0; i < values.length; i += 3) {
      this.buf[this.length + i] = values[i] + dx;
      this.buf[this.length + i + 1] = values[i + 1] + dy;
      this.buf[this.length + i + 2] = values[i + 2] + dz;
    }
    this.length += values.length;
  }

  /** Appends `count` copies of the same three values (a vertex run's colour). */
  pushTris(r: number, g: number, b: number, count: number): void {
    const amount = count * 3;
    this.growBy(amount);
    for (let i = 0; i < count; i++) {
      const at = this.length + i * 3;
      this.buf[at] = r;
      this.buf[at + 1] = g;
      this.buf[at + 2] = b;
    }
    this.length += amount;
  }

  /** The current length, for the callers that count vertices or indices. */
  get count(): number {
    return this.length;
  }

  /** Bytes the backing buffer occupies, written or not, since growth doubles it. */
  get capacityBytes(): number {
    return this.buf.byteLength;
  }

  /** Appends two, which is a texture coordinate. */
  pushPair(first: number, second: number): void {
    this.growBy(2);
    this.buf[this.length] = first;
    this.buf[this.length + 1] = second;
    this.length += 2;
  }

  /** Appends three, which is a position or a triangle's indices. */
  pushTriple(first: number, second: number, third: number): void {
    this.growBy(3);
    this.buf[this.length] = first;
    this.buf[this.length + 1] = second;
    this.buf[this.length + 2] = third;
    this.length += 3;
  }

  /** Appends four, which is one vertex's group of packed lanes. */
  pushQuad(first: number, second: number, third: number, fourth: number): void {
    this.growBy(4);
    this.buf[this.length] = first;
    this.buf[this.length + 1] = second;
    this.buf[this.length + 2] = third;
    this.buf[this.length + 3] = fourth;
    this.length += 4;
  }

  /**
   * Writes `values` over what is at `at`, leaving the length alone: the caller
   * is filling a run something else has already left room for.
   */
  writeManyAt(at: number, values: ArrayLike<number>): void {
    this.buf.set(values, at);
  }

  /** Writes `values` over what is at `at`, each shifted by `shift`. */
  writeShiftedAt(at: number, values: ArrayLike<number>, shift: number): void {
    for (let i = 0; i < values.length; i++) {
      this.buf[at + i] = values[i] + shift;
    }
  }

  /** Writes positions over what is at `at`, shifted per component. */
  writeOffsetAt(
    at: number,
    values: ArrayLike<number>,
    dx: number,
    dy: number,
    dz: number,
  ): void {
    for (let i = 0; i < values.length; i += 3) {
      this.buf[at + i] = values[i] + dx;
      this.buf[at + i + 1] = values[i + 1] + dy;
      this.buf[at + i + 2] = values[i + 2] + dz;
    }
  }

  /** Forgets everything written, keeping the buffer for what is written next. */
  clear(): void {
    this.length = 0;
  }

  /**
   * The written elements as an array of their own, at exactly their length. A
   * copy, unlike `array`: what leaves a worker is transferred and outlives the
   * builder, so it cannot be a view onto a buffer the next block will overwrite.
   */
  exact(): T {
    const out = new this.ctor(this.length);
    out.set(this.buf.subarray(0, this.length));
    return out;
  }

  /** The written elements, as a same-typed view the uploader passes straight through. */
  array(): T {
    return this.buf.subarray(0, this.length) as T;
  }
}
