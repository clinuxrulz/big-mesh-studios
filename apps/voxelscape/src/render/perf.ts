/**
 * Debug-only performance instrumentation, implemented directly against raw
 * WebGL2 since RMSL doesn't expose render targets or timer queries. Enabled
 * by appending `#perf` to the URL.
 */

/**
 * Minimal typing for the `EXT_disjoint_timer_query_webgl2` WebGL extension,
 * which is missing from the TypeScript DOM library used here. The extension
 * carries only the elapsed-time target; a result is read back through the
 * context's own `QUERY_RESULT_AVAILABLE` and `QUERY_RESULT`, which WebGL 2
 * already has and which the WebGL 1 extension had to add for itself.
 */
interface ExtTimerQuery {
  readonly TIME_ELAPSED_EXT: GLenum;
}

/**
 * Double-buffered GPU frame timer using EXT_disjoint_timer_query_webgl2.
 * Results are polled a frame late to avoid stalling the GPU pipeline.
 */
export class GpuTimer {
  readonly supported: boolean;
  private gl: WebGL2RenderingContext;
  private ext: ExtTimerQuery | null;
  private queries: WebGLQuery[];
  private frame: number = 0;
  ms: number = 0;
  /** Whether any query has come back yet, so a card that never answers is not read as instant. */
  answered: boolean = false;

  constructor(gl: WebGL2RenderingContext) {
    this.gl = gl;
    this.ext = gl.getExtension(
      "EXT_disjoint_timer_query_webgl2",
    ) as ExtTimerQuery | null;
    this.supported = this.ext !== null;
    this.queries = this.supported ? [gl.createQuery(), gl.createQuery()] : [];
  }

  /** Call right before `renderer.render(...)`. */
  begin(): void {
    if (!this.ext) return;
    this.gl.beginQuery(this.ext.TIME_ELAPSED_EXT, this.queries[this.frame % 2]);
  }

  /** Call right after `renderer.render(...)`. */
  end(): void {
    if (!this.ext) return;
    this.gl.endQuery(this.ext.TIME_ELAPSED_EXT);
  }

  /** Call once per frame after `end()` to collect last frame's time. */
  poll(): void {
    if (!this.ext) return;
    if (this.frame > 0) {
      const q = this.queries[(this.frame - 1) % 2];
      if (this.gl.getQueryParameter(q, this.gl.QUERY_RESULT_AVAILABLE)) {
        const nanos = this.gl.getQueryParameter(q, this.gl.QUERY_RESULT);
        this.ms = Number(nanos) / 1e6;
        this.answered = true;
      }
    }
    this.frame++;
  }
}

/** Every member `GpuTimer` exposes, so a build can swap in a timer that does nothing. */
export type GpuTimerApi = Pick<
  GpuTimer,
  "supported" | "ms" | "answered" | "begin" | "end" | "poll"
>;

/** Stands in for `GpuTimer` in a build without it: every method is empty, `ms` stays 0. */
class NoopGpuTimer implements GpuTimerApi {
  readonly supported = false;
  ms = 0;
  answered = false;
  begin(): void {}
  end(): void {}
  poll(): void {}
}

/**
 * Builds the timer `create-render-loop.ts` uses. `__PERF__` decides which —
 * substituted with a literal at build time, so the branch not taken folds
 * away along with `GpuTimer` itself in a build without it.
 */
export const createGpuTimer: (gl: WebGL2RenderingContext) => GpuTimerApi =
  __PERF__ ? (gl) => new GpuTimer(gl) : () => new NoopGpuTimer();
