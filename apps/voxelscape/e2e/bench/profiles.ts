/**
 * A machine to measure as if the run were happening on it. The browser cannot
 * become a weaker computer, but it can be slowed to one's processor speed,
 * given one's screen, and held to one's core count — which is enough to find
 * where the load falls over as the hardware gets worse.
 *
 * What none of these reproduce is a weaker graphics card. The card underneath
 * stays whatever the run is on, so triangle throughput and fill rate are the
 * one axis these profiles cannot speak for; what they do speak for is the main
 * thread, the worker pool, and the pixels being asked for.
 */
export interface MachineProfile {
  name: string;
  /** What the profile stands in for, printed above the numbers. */
  description: string;
  /**
   * How many times slower than the machine running the benchmark to make the
   * processor, through the browser's own throttle.
   */
  cpuThrottle: number;
  /** World workers to allow, or undefined to leave the automatic count alone. */
  workers?: number;
  /** The page size in layout pixels. */
  viewport: { width: number; height: number };
  /** Layout pixels to device pixels, which is what decides how many are drawn. */
  devicePixelRatio: number;
  /** The render scale to pin, where 1 draws every device pixel. */
  scale: number;
}

export const PROFILES: MachineProfile[] = [
  {
    name: "native",
    description: "this machine, unthrottled",
    cpuThrottle: 1,
    viewport: { width: 1024, height: 576 },
    devicePixelRatio: 1,
    scale: 1,
  },
  {
    name: "phone",
    description:
      "a mid-range phone: a slow processor, two workers, and a small dense screen",
    cpuThrottle: 6,
    workers: 2,
    viewport: { width: 412, height: 732 },
    devicePixelRatio: 2,
    scale: 1,
  },
  {
    name: "laptop",
    description:
      "an older laptop on integrated graphics: a slow processor and a full-size screen",
    cpuThrottle: 4,
    workers: 2,
    viewport: { width: 1366, height: 768 },
    devicePixelRatio: 1,
    scale: 1,
  },
  {
    name: "chromebook",
    description: "a low-end chromebook: slower still, and the same screen",
    cpuThrottle: 6,
    workers: 2,
    viewport: { width: 1366, height: 768 },
    devicePixelRatio: 1,
    scale: 1,
  },
];

export const profileNamed = (name: string): MachineProfile => {
  const profile = PROFILES.find((candidate) => candidate.name === name);
  if (profile === undefined) {
    throw new Error(
      `no profile named ${name}; there is ${PROFILES.map((p) => p.name).join(", ")}`,
    );
  }
  return profile;
};
