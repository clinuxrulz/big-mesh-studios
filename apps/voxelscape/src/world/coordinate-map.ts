// A hash map keyed by an integer coordinate triple, backed by flat typed
// arrays rather than a `Map` keyed by a "x,y,z" string. A lookup takes the
// three ints and never allocates or parses a key, so each access costs a hash
// and a short linear probe run over Int32Comparisons — the kind of work an
// object or string key runs twenty to a hundred times more of. Slots live in
// three parallel typed arrays (x, y, z, then the value) sized to a power of
// two and probed linearly from the hash slot.
export class CoordinateMap<V> {
  private capacity: number;
  private mask: number;
  private count = 0;
  private readonly maxLoadFactor = 0.7;

  private keys: Int32Array;
  private values: Array<V | undefined>;
  private occupied: Uint8Array;

  constructor(initialCapacity = 16) {
    this.capacity = this.powerOfTwoAtLeast(initialCapacity);
    this.mask = this.capacity - 1;
    this.keys = new Int32Array(this.capacity * 3);
    this.values = new Array<V | undefined>(this.capacity);
    this.occupied = new Uint8Array(this.capacity);
  }

  /** The number of stored entries. */
  get size(): number {
    return this.count;
  }

  /**
   * The value at a coordinate, or undefined when the map holds none.
   * Coordinates are compared as int32, so each must fit in signed 32 bits.
   */
  get(x: number, y: number, z: number): V | undefined {
    let slot = this.hash(x, y, z);
    while (this.occupied[slot] !== 0) {
      const stride = slot * 3;
      if (
        this.keys[stride] === x &&
        this.keys[stride + 1] === y &&
        this.keys[stride + 2] === z
      ) {
        return this.values[slot];
      }
      slot = (slot + 1) & this.mask;
    }
    return undefined;
  }

  /** Stores `value` at a coordinate, replacing whatever was there. */
  set(x: number, y: number, z: number, value: V): void {
    if (this.count >= this.capacity * this.maxLoadFactor) {
      this.resize(this.capacity * 2);
    }
    let slot = this.hash(x, y, z);
    while (this.occupied[slot] !== 0) {
      const stride = slot * 3;
      if (
        this.keys[stride] === x &&
        this.keys[stride + 1] === y &&
        this.keys[stride + 2] === z
      ) {
        this.values[slot] = value;
        return;
      }
      slot = (slot + 1) & this.mask;
    }
    const stride = slot * 3;
    this.keys[stride] = x;
    this.keys[stride + 1] = y;
    this.keys[stride + 2] = z;
    this.values[slot] = value;
    this.occupied[slot] = 1;
    this.count++;
  }

  /**
   * Runs `fn` for every entry. Iteration order is slot order, so it is not
   * insertion order; callers must not depend on one.
   */
  forEach(fn: (x: number, y: number, z: number, value: V) => void): void {
    const { keys, values, occupied, capacity } = this;
    for (let slot = 0; slot < capacity; slot++) {
      if (occupied[slot] === 0) {
        continue;
      }
      const stride = slot * 3;
      fn(keys[stride], keys[stride + 1], keys[stride + 2], values[slot] as V);
    }
  }

  /** FNV-1a over the three coordinates, folded onto the slot mask. */
  private hash(x: number, y: number, z: number): number {
    let h = 2166136261;
    h = Math.imul(h ^ x, 16777619);
    h = Math.imul(h ^ y, 16777619);
    h = Math.imul(h ^ z, 16777619);
    return (h ^ (h >>> 16)) & this.mask;
  }

  /** Grows to `newCapacity` and re-inserts every entry through the new mask. */
  private resize(newCapacity: number): void {
    const oldKeys = this.keys;
    const oldValues = this.values;
    const oldOccupied = this.occupied;
    const oldCapacity = this.capacity;
    this.capacity = newCapacity;
    this.mask = newCapacity - 1;
    this.count = 0;
    this.keys = new Int32Array(newCapacity * 3);
    this.values = new Array<V | undefined>(newCapacity);
    this.occupied = new Uint8Array(newCapacity);
    for (let slot = 0; slot < oldCapacity; slot++) {
      if (oldOccupied[slot] === 0) {
        continue;
      }
      const stride = slot * 3;
      this.set(
        oldKeys[stride],
        oldKeys[stride + 1],
        oldKeys[stride + 2],
        oldValues[slot] as V,
      );
    }
  }

  private powerOfTwoAtLeast(n: number): number {
    let p = 1;
    while (p < n) {
      p <<= 1;
    }
    return p;
  }
}
