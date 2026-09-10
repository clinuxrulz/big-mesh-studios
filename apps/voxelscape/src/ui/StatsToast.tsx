import { createSignal, onSettled, type Component } from "solid-js";
import styles from "./StatsToast.module.css";
import { useVoxelscape } from "../voxelscape/voxelscape-context";

/**
 * How often the readout is rebuilt, in milliseconds. Frames are measured every
 * one of them; what the panel says is rewritten this often, because a number
 * that changes sixty times a second cannot be read and rewriting it costs a
 * layout each time.
 */
const REWRITE_MS = 250;

/** Mebibytes, to one decimal, as every memory figure here is written. */
const mib = (bytes: number): string => (bytes / 1048576).toFixed(1);

/** One row of the panel: what it is on the left, what it costs on the right. */
const Row: Component<{ name: string; value: string; dim?: boolean }> = (
  props,
) => (
  <div class={props.dim === true ? styles.rowDim : styles.row}>
    <span>{props.name}</span>
    <span class={styles.value}>{props.value}</span>
  </div>
);

/**
 * What the world is costing, while it is costing it: the frame, the memory it
 * holds, the window it holds it for, and where the player is standing.
 *
 * Read straight off the world rather than from the performance probe, so this
 * says the same thing in the build players get, where the probe is left out.
 */
export const StatsToast: Component = () => {
  const { player, stats } = useVoxelscape();
  const [frame, setFrame] = createSignal({ fps: 0, worst: 0 });
  const [world, setWorld] = createSignal(stats());
  const [place, setPlace] = createSignal({ x: 0, y: 0, z: 0 });

  onSettled(() => {
    let request = 0;
    let last = performance.now();
    let since = last;
    let frames = 0;
    let worst = 0;
    const next = (): void => {
      const now = performance.now();
      const gap = now - last;
      last = now;
      frames++;
      // The first gap after the panel opens spans whatever the tab was doing
      // before it, which is not a frame anybody drew.
      if (frames > 1) {
        worst = Math.max(worst, gap);
      }
      if (now - since >= REWRITE_MS) {
        setFrame({ fps: (frames * 1000) / (now - since), worst });
        setWorld(stats());
        const at = player.position;
        setPlace({
          x: Math.round(at.x),
          y: Math.round(at.y),
          z: Math.round(at.z),
        });
        since = now;
        frames = 0;
        worst = 0;
      }
      request = requestAnimationFrame(next);
    };
    request = requestAnimationFrame(next);
    return () => cancelAnimationFrame(request);
  });

  const resident = (): number =>
    world().voxelBytes +
    world().mergedGeometryBytes +
    world().blockGeometryBytes;

  return (
    <div class={styles.panel}>
      <Row
        name="frame"
        value={`${frame().fps.toFixed(0)} fps  worst ${frame().worst.toFixed(1)}ms`}
      />
      <Row
        name="heap"
        value={
          world().heapBytes === undefined
            ? "not said"
            : `${mib(world().heapBytes!)} MiB`
        }
      />
      <Row name="resident" value={`${mib(resident())} MiB`} />
      <Row name="voxels + light" value={mib(world().voxelBytes)} dim />
      <Row
        name="geometry"
        value={mib(world().mergedGeometryBytes + world().blockGeometryBytes)}
        dim
      />
      <Row
        name="window"
        value={`${world().blocks} blocks  r${world().chunkRadius}`}
      />
      <Row
        name="drawing"
        value={`${(world().triangles / 1000).toFixed(0)}k triangles`}
      />
      <Row
        name="waiting"
        value={`${world().fillsPending} fills  ${world().meshesPending} meshes`}
      />
      <Row name="at" value={`${place().x}  ${place().y}  ${place().z}`} />
    </div>
  );
};
