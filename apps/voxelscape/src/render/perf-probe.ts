/**
 * The stretches of one frame the probe times separately. The order is the
 * order they run in, and the numbers index every per-phase array here.
 */
export const Phase = {
  player: 0,
  scroll: 1,
  flow: 2,
  multiplayer: 3,
  monsters: 4,
  environment: 5,
  meshDrain: 6,
  merge: 7,
  rendererTick: 8,
  advance: 9,
  occlusion: 10,
  draw: 11,
} as const;

/** Each phase's name, at the index that phase is timed under. */
export const PHASE_NAMES = Object.keys(Phase) as (keyof typeof Phase)[];

/**
 * The things the probe counts over a whole run rather than timing: how much
 * work the world asked for and how much of it landed.
 */
export const Counter = {
  fillsRequested: 0,
  fillsLanded: 1,
  meshesRequested: 2,
  meshesLanded: 3,
  /** Geometry adopted straight from a fill, which no mesh request ever asked for. */
  meshesFromFill: 4,
  merges: 5,
  /**
   * Merges that rebuilt a superchunk's geometry from every member rather than
   * appending to what was already there, which owes the graphics card the
   * whole superchunk again.
   */
  fullRejoins: 6,
  uploads: 7,
  scrolls: 8,
  blocksStreamed: 9,
} as const;

/** Each counter's name, at the index that counter is kept under. */
export const COUNTER_NAMES = Object.keys(Counter) as (keyof typeof Counter)[];

/**
 * The values the probe records once per frame, each one a column of the frame
 * ring. The per-phase slices follow them, so a row is `FIELD_NAMES.length +
 * PHASE_NAMES.length` numbers wide.
 */
export const Field = {
  /** Milliseconds between this frame's animation callback and the one before. */
  gapMs: 0,
  /** Milliseconds the graphics card spent drawing, from `GpuTimer`. */
  gpuMs: 1,
  /** The render scale the frame was drawn at, where 1 is the display resolution. */
  scale: 2,
  /** Bytes uploaded to the graphics card during the frame. */
  uploadBytes: 3,
  /** Superchunks whose geometry was merged and uploaded during the frame. */
  merges: 4,
  /** Triangles in the drawn geometry. */
  triangles: 5,
  /** Superchunks the occlusion pass found hidden. */
  occluded: 6,
  /** Superchunks that survived to be drawn. */
  visible: 7,
  /** Blocks waiting for terrain data. */
  fillPending: 8,
  /** Blocks whose terrain data a worker is generating. */
  fillInFlight: 9,
  /** Blocks waiting for geometry. */
  meshPending: 10,
  /** Blocks whose geometry a worker is building. */
  meshInFlight: 11,
  /** Superchunks whose merged geometry is out of date. */
  dirtySuperchunks: 12,
  /** The JavaScript heap in bytes, sampled about once a second. */
  heapBytes: 13,
  /**
   * Whether the block the player stands in has its terrain, as 1 or 0. The
   * world holds the player still while it is 0, so a run of zeroes is the
   * player having outrun what the workers could stream.
   */
  cellReady: 14,
  playerX: 15,
  playerY: 16,
  playerZ: 17,
} as const;

/** Each per-frame value's name, at the column it is recorded in. */
export const FIELD_NAMES = Object.keys(Field) as (keyof typeof Field)[];

/** How many numbers one frame's row holds: the per-frame values, then the phase slices. */
export const ROW_STRIDE = FIELD_NAMES.length + PHASE_NAMES.length;

/** How many frames the ring holds before it starts overwriting the oldest. */
const DEFAULT_CAPACITY = 8192;

/** How long between two reads of the heap size, in milliseconds. */
const HEAP_SAMPLE_MS = 1000;

/** The heap reading Chromium adds to `performance`, absent in other browsers. */
interface HeapMemory {
  usedJSHeapSize: number;
}

/** One run's measurements, as plain numbers a benchmark script can carry away. */
export interface PerfDrain {
  /** Each frame's row, `rowStride` numbers per frame, oldest first. */
  rows: number[];
  rowStride: number;
  fieldNames: string[];
  phaseNames: string[];
  counterNames: string[];
  counters: number[];
  /** Frames recorded since the last reset, including any the ring has dropped. */
  framesSeen: number;
  /** Whether the ring wrapped, meaning the earliest frames are gone. */
  wrapped: boolean;
  /** Milliseconds between the reset and the drain. */
  durationMs: number;
}

/**
 * Records where a frame's time goes, what the world has queued, and how much
 * of it landed — for the benchmark scripts under `e2e/bench`, which arm the
 * probe, drive the player, and carry the numbers away.
 *
 * Disarmed it does nothing but test a boolean, so the calls can sit on the
 * frame path unconditionally. Armed it writes into arrays allocated up front:
 * a run records no objects, so the measurement never itself causes the
 * collection pause it would then blame on the frame.
 */
export class PerfProbe {
  private _armed = false;
  private rows = new Float64Array(0);
  private capacity = 0;
  /** Where the next frame's row starts, wrapping at the end of the ring. */
  private cursor = 0;
  private _framesSeen = 0;
  private _wrapped = false;
  private startedAt = 0;

  /** When each phase currently being timed began; only meaningful between `begin` and `end`. */
  private readonly phaseStart = new Float64Array(PHASE_NAMES.length);
  /** This frame's phase slices, moved into the row and cleared each frame. */
  private readonly phaseSlice = new Float64Array(PHASE_NAMES.length);
  private readonly counters = new Float64Array(COUNTER_NAMES.length);
  /** The values last handed to `gauge`, written into every row until they change. */
  private readonly gauges = new Float64Array(FIELD_NAMES.length);
  private lastHeapAt = 0;

  /** Whether the probe is recording. Every other method is inert while it is not. */
  get armed(): boolean {
    return this._armed;
  }

  /** Starts recording into a ring of `capacityFrames` frames, discarding anything held. */
  arm(capacityFrames: number = DEFAULT_CAPACITY): void {
    if (this.capacity !== capacityFrames) {
      this.capacity = capacityFrames;
      this.rows = new Float64Array(capacityFrames * ROW_STRIDE);
    }
    this._armed = true;
    this.reset();
  }

  /** Stops recording and releases the ring. */
  disarm(): void {
    this._armed = false;
    this.rows = new Float64Array(0);
    this.capacity = 0;
  }

  /** Throws away everything recorded so far and starts the run's clock again. */
  reset(): void {
    this.cursor = 0;
    this._framesSeen = 0;
    this._wrapped = false;
    this.counters.fill(0);
    this.phaseSlice.fill(0);
    this.lastHeapAt = 0;
    this.startedAt = performance.now();
  }

  /** Starts timing a phase. Pair it with `end` for the same phase. */
  begin(phase: number): void {
    if (!this._armed) {
      return;
    }
    this.phaseStart[phase] = performance.now();
  }

  /** Stops timing a phase, adding its slice to this frame's total for it. */
  end(phase: number): void {
    if (!this._armed) {
      return;
    }
    this.phaseSlice[phase] += performance.now() - this.phaseStart[phase];
  }

  /** Adds to a counter for this run. */
  count(counter: number, amount: number = 1): void {
    if (!this._armed) {
      return;
    }
    this.counters[counter] += amount;
  }

  /** Records a per-frame value, which every row carries until it is set again. */
  gauge(field: number, value: number): void {
    if (!this._armed) {
      return;
    }
    this.gauges[field] = value;
  }

  /**
   * Closes the frame: writes the gauges and this frame's phase slices into the
   * ring, samples the heap when it is due, and clears the slices for the next
   * frame.
   *
   * @param gapMs Milliseconds since the previous frame's animation callback.
   * @param gpuMs Milliseconds the graphics card spent on the previous frame.
   * @param scale The render scale the frame was drawn at.
   */
  frame(gapMs: number, gpuMs: number, scale: number): void {
    if (!this._armed) {
      return;
    }
    const at = performance.now();
    if (at - this.lastHeapAt >= HEAP_SAMPLE_MS) {
      this.lastHeapAt = at;
      const memory = (performance as Performance & { memory?: HeapMemory })
        .memory;
      this.gauges[Field.heapBytes] = memory?.usedJSHeapSize ?? 0;
    }
    this.gauges[Field.gapMs] = gapMs;
    this.gauges[Field.gpuMs] = gpuMs;
    this.gauges[Field.scale] = scale;

    const base = this.cursor;
    const fields = FIELD_NAMES.length;
    for (let i = 0; i < fields; i++) {
      this.rows[base + i] = this.gauges[i];
    }
    for (let i = 0; i < this.phaseSlice.length; i++) {
      this.rows[base + fields + i] = this.phaseSlice[i];
      this.phaseSlice[i] = 0;
    }
    // The bytes uploaded and the superchunks merged are counted for one frame
    // each, unlike the queue depths, which stand until they change.
    this.gauges[Field.uploadBytes] = 0;
    this.gauges[Field.merges] = 0;

    this._framesSeen++;
    this.cursor += ROW_STRIDE;
    if (this.cursor >= this.rows.length) {
      this.cursor = 0;
      this._wrapped = true;
    }
  }

  /** Everything recorded since the last reset, oldest frame first. */
  drain(): PerfDrain {
    const kept = this._wrapped ? this.capacity : this._framesSeen;
    const rows: number[] = new Array(kept * ROW_STRIDE);
    const first = this._wrapped ? this.cursor : 0;
    for (let i = 0; i < kept * ROW_STRIDE; i++) {
      rows[i] = this.rows[(first + i) % this.rows.length];
    }
    return {
      rows,
      rowStride: ROW_STRIDE,
      fieldNames: FIELD_NAMES,
      phaseNames: PHASE_NAMES,
      counterNames: COUNTER_NAMES,
      counters: Array.from(this.counters),
      framesSeen: this._framesSeen,
      wrapped: this._wrapped,
      durationMs: performance.now() - this.startedAt,
    };
  }
}

/**
 * The one probe the world reports into. Measurement crosses every layer of the
 * frame — the player, the streaming, the renderer's merge loop — and handing a
 * probe down through each of their constructors would put a benchmark's
 * concern in the signature of objects that otherwise know nothing about one.
 */
export const probe = new PerfProbe();
