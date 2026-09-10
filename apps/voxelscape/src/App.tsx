import {
  Component,
  createSignal,
  For,
  lazy,
  onCleanup,
  onSettled,
  Show,
} from "solid-js";
import styles from "./App.module.css";
import { createPlaceLibrary } from "./atproto/places";
import { builtinDemo, loadBuiltinDemo } from "./places/demos";
import { readPlaceProject, type PlaceProject } from "./places/project";
import { compilePlacePlan, planRegionAround } from "./places/plan";
import { DEFAULT_TERRAIN, type TerrainConfig } from "./world/noise";
import type { Dim3 } from "./world/level-data";
import type { StructurePlan } from "./world/structure-fill";
import type { PlaceBoot } from "./voxelscape/create-voxelscape";
import CoarseControls from "./ui/CoarseControls";
/** The place script editor, pulled in only when `/place:editor` first needs it,
 * so the code-mirror bundle is not loaded by every world. */
const PlaceEditor = lazy(() => import("./ui/PlaceEditor"));
import { Console } from "./ui/Console";
import { DialogOverlay } from "./ui/Dialog";
import { EditHud } from "./ui/EditHud";
import { HealthHud } from "./ui/HealthHud";
import { PositionHud } from "./ui/PositionHud";
import { LoadingScreen, LoadingToast } from "./ui/LoadingScreen";
import { createToasts, Toast } from "./ui/Toasts";
import { createMediaQuery } from "@big-mesh-studios/utils/create-media-query";
import { createVoxelscape } from "./voxelscape/create-voxelscape";
import {
  useVoxelscape,
  VoxelscapeContext,
} from "./voxelscape/voxelscape-context";

/** How long a line the world reports on its own is left on screen. */
const NOTICE_SECONDS = 6;

/**
 * How the world is built this session: a published place's world when the
 * address bar named one, and the default world otherwise.
 */
interface LaunchConfig {
  /** A place's terrain seed; omitted for the default world. */
  terrain?: TerrainConfig;
  /** A place's spawn point; omitted for the default world. */
  spawn?: Dim3;
  /** The structures a place's script asks the filler to stamp into every chunk. */
  structures?: StructurePlan;
  /** The place's scripts to run from boot; omitted for the default world. */
  place?: PlaceBoot;
  /** One line about how this world was chosen, toasted once it exists. */
  notice?: string;
}

const World: Component<{ launch: LaunchConfig }> = (props) => {
  let hud: HTMLDivElement | undefined;

  const [notice, setNotice] = createSignal<string>();

  const coarsePointer = createMediaQuery("(any-pointer: coarse)");
  const toasts = createToasts();
  const voxelscape = createVoxelscape({
    terrain: props.launch.terrain,
    spawn: props.launch.spawn,
    structures: props.launch.structures,
    place: props.launch.place,
    chunkRadius: radiusInUrl(),
    antialias: antialiasInUrl(),
    onDebugStats: (line) => {
      if (hud !== undefined) {
        hud.textContent = line;
      }
    },
    onNotice: (line) => {
      setNotice(line);
      // Nobody has the console open when the world reports its atproto state,
      // so the same line is put where it can be read without opening it.
      toasts.show(() => line, NOTICE_SECONDS * 1000);
    },
  });

  // A line the boot decided on — the place joined, or why that failed — goes
  // out once the world exists to hold it.
  onSettled(() => {
    if (props.launch.notice !== undefined) {
      toasts.show(() => props.launch.notice!, NOTICE_SECONDS * 1000);
    }
  });

  onCleanup(voxelscape.dispose);

  return (
    <VoxelscapeContext value={voxelscape}>
      <div class={styles.container}>
        {/* A canvas holds the sample count its drawing context was made with
            for the whole life of that context, so the only way to turn
            multisampling on or off is to throw the canvas away and mount the
            world onto a new one. Keying the list on the setting is what does
            that: the same value keeps the canvas, a changed one replaces it. */}
        <For each={[voxelscape.multisampling()]}>{() => <WorldCanvas />}</For>
        <Show when={coarsePointer()}>
          <CoarseControls />
        </Show>
        <EditHud />
        <HealthHud />
        <PositionHud />
        <DialogOverlay />
        <EndingOverlay />
        <Show when={voxelscape.placeEditor.open()}>
          <PlaceEditor />
        </Show>
        <LoadingScreen />
        <Console
          onCommand={(line) => voxelscape.commands.run(line)}
          names={voxelscape.commands.names()}
          notice={notice()}
        />
        <toasts.Stack>
          <Show when={voxelscape.debugPerf()}>
            <Toast>
              <div
                ref={(el) => {
                  hud = el;
                }}
                class={styles["debug-perf"]}
              />
            </Toast>
          </Show>
          <LoadingToast />
        </toasts.Stack>
      </div>
    </VoxelscapeContext>
  );
};

/**
 * The world's drawing surface, mounted when it appears and unmounted when it
 * goes. Kept apart from the rest of the world's markup because it is replaced
 * whenever multisampling changes, and everything else on screen stays.
 */
const WorldCanvas: Component = () => {
  const voxelscape = useVoxelscape();
  let canvas!: HTMLCanvasElement;
  onSettled(() => voxelscape.mount(canvas));
  return (
    <canvas
      ref={(element) => {
        canvas = element;
      }}
      class={styles.canvas}
      {...voxelscape.input.canvasHandlers}
    />
  );
};

/** The screen a place's script shows when its game ends, with a way to start over. */
const EndingOverlay: Component = () => {
  const voxelscape = useVoxelscape();
  return (
    <Show when={voxelscape.ending() !== null}>
      <div class={styles.ending} role="dialog" aria-label="ending">
        <div class={styles["ending-panel"]}>
          <h1 class={styles["ending-title"]}>{voxelscape.ending()!.title}</h1>
          <p class={styles["ending-text"]}>{voxelscape.ending()!.text}</p>
          <button
            class={styles["ending-button"]}
            onClick={() => voxelscape.restart()}
          >
            Play again
          </button>
        </div>
      </div>
    </Show>
  );
};

/** What shows while a `?place=` address is resolving, if it ever takes a moment. */
const Joining: Component<{ line: string }> = (props) => (
  <div class={styles.container}>
    <div class={styles.joining}>{props.line}</div>
  </div>
);

/** The place the address bar names, or null when it names none. */
const placeInUrl = (): string | null =>
  new URLSearchParams(window.location.search).get("place");

/** The built-in demo the address bar names, or null when it names none. */
const demoInUrl = (): string | null =>
  new URLSearchParams(window.location.search).get("demo");

/**
 * Whether the address bar turns multisampling off, or undefined when it says
 * nothing. A benchmark measures the world both ways: the multisampled canvas is
 * the largest thing the page holds on a phone's graphics card.
 */
const antialiasInUrl = (): boolean | undefined => {
  const asked = new URLSearchParams(window.location.search).get("antialias");
  if (asked === null) {
    return undefined;
  }
  return asked !== "0" && asked !== "false";
};

/**
 * The chunk window's horizontal radius the address bar asks for, or undefined
 * when it asks for none. A benchmark run trades window size for how long the
 * first fill takes, so it names the radius it wants to measure at.
 */
const radiusInUrl = (): number | undefined => {
  const asked = new URLSearchParams(window.location.search).get("radius");
  if (asked === null) {
    return undefined;
  }
  const radius = Number(asked);
  return Number.isInteger(radius) && radius >= 1 && radius <= 8
    ? radius
    : undefined;
};

const App: Component<{}> = () => {
  const [launch, setLaunch] = createSignal<LaunchConfig | null>(null);
  const [joiningLine, setJoiningLine] = createSignal("joining world…");

  const places = createPlaceLibrary();

  /**
   * Boots the world a place project describes: its terrain seed, spawn, the
   * structure plan its script compiles, and the scripts themselves.
   */
  const launchProject = async (
    project: PlaceProject,
    source: string,
  ): Promise<void> => {
    const entry = project.manifest.scripts?.[0];
    if (entry === undefined) {
      setLaunch({
        terrain: { ...DEFAULT_TERRAIN, seed: project.manifest.seed },
        spawn: project.manifest.spawn,
        notice: `${source} names no scripts — playing its terrain`,
      });
      return;
    }
    let structures: StructurePlan | undefined;
    let planNote = "";
    try {
      structures = await compilePlacePlan({
        files: project.scripts,
        entry,
        seed: project.manifest.seed,
        region: planRegionAround(project.manifest.spawn),
      });
      planNote = ` · ${structures.length} structure shape(s)`;
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      planNote = ` · its plan did not compile (${detail})`;
    }
    setLaunch({
      terrain: { ...DEFAULT_TERRAIN, seed: project.manifest.seed },
      spawn: project.manifest.spawn,
      structures,
      place: {
        files: project.scripts,
        entry,
        seed: project.manifest.seed,
        models: project.models,
      },
      notice: `${source}${planNote}`,
    });
  };

  onSettled(() => {
    void (async () => {
      const demoId = demoInUrl();
      if (demoId !== null) {
        const demo = builtinDemo(demoId);
        if (demo === null) {
          setLaunch({
            notice: `there is no demo "${demoId}" — /place:demos lists them`,
          });
          return;
        }
        setJoiningLine(`opening "${demo.name}"…`);
        try {
          await launchProject(
            await loadBuiltinDemo(demo),
            `playing the demo "${demo.name}"`,
          );
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          setJoiningLine(`could not open the demo — ${detail}`);
          setLaunch({ notice: `could not open the demo (${detail})` });
        }
        return;
      }

      const atUri = placeInUrl();
      if (atUri === null) {
        setLaunch({});
        return;
      }
      setJoiningLine("joining the published place…");
      try {
        const place = await places.recordAtUri(atUri);
        setJoiningLine("opening the place's scripts…");
        await launchProject(
          await readPlaceProject(await places.file(place)),
          `joined "${place.record.name}" — playing its world`,
        );
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        setJoiningLine(`could not join — ${detail}`);
        setLaunch({
          notice: `could not join that place (${detail}) — playing this world instead`,
        });
      }
    })();
  });

  return (
    <Show when={launch()} fallback={<Joining line={joiningLine()} />} keyed>
      {(config) => <World launch={config} />}
    </Show>
  );
};

export default App;
