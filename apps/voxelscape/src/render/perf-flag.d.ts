/**
 * Whether this build carries the perf-probe/`GpuTimer` instrumentation,
 * substituted with a literal by the `define` in `vite.config.ts` so a build
 * where it's `false` can fold away and drop every branch it gates.
 */
declare const __PERF__: boolean;
