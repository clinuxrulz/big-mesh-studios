// The console's window onto a running place script, and the easy way to try a
// script without the world drawing its NPCs yet: the script loads, and the
// console drives the dialog — starting a talk, picking an option, walking away —
// while the script's toasts go wherever the caller sends them. Everything the
// methods return is one line-shaped answer for a console to print.
import { ScriptHost, type DialogState, type ScriptedFire } from "./script-host";
import { SAMPLE_PLACE_SCRIPT } from "./sample";
import { MAIN_SCRIPT_FILE } from "./project";

export interface ScriptConsoleParams {
  /** The terrain surface at (`x`, `z`), where a script's NPCs are grounded. */
  heightAt: (x: number, z: number) => number;
  /** Where a script's toast and error lines go — the notice channel. */
  report?: (line: string) => void;
  /** Called whenever a player's dialog changes, so the world can show it. */
  onDialog?: (player: string, state: DialogState | null) => void;
  /** Called when a player's game reaches an ending, or null to close it. */
  onEnding?: (
    player: string,
    state: { title: string; text: string } | null,
  ) => void;
  /** Called when a player's game asks to start over. */
  onRestart?: (player: string) => void;
  /** Called when the script pins, jumps, or releases the day-night clock. */
  onTime?: (command: {
    seconds?: number;
    speed?: number;
    clear?: boolean;
  }) => void;
  /** Called when a player is shown a line with no figure speaking it. */
  onNarrate?: (player: string, line: { name: string; text: string }) => void;
  /** Called when the script moves a player, optionally turning them. */
  onPlayerPlace?: (
    player: string,
    at: { x: number; z: number; y?: number; yaw?: number },
  ) => void;
  /** Called when the script turns a player to look at a world point. */
  onPlayerFace?: (player: string, at: { x: number; z: number }) => void;
  /** Called when the script lights a fire; the world seeds its ember light. */
  onFire?: (fire: ScriptedFire) => void;
}

/** The option a console prints for a dialog, numbered for `/script:choose`. */
const optionLines = (dialog: DialogState): string =>
  dialog.options.map((option, index) => `  ${index + 1}. ${option}`).join("\n");

/** One script, loaded on demand and driven by console commands. */
export class ScriptConsole {
  private readonly heightAt: (x: number, z: number) => number;
  private readonly report: (line: string) => void;
  private readonly onDialog: (
    player: string,
    state: DialogState | null,
  ) => void;
  private readonly onEnding: (
    player: string,
    state: { title: string; text: string } | null,
  ) => void;
  private readonly onRestart: (player: string) => void;
  private readonly onTime: (command: {
    seconds?: number;
    speed?: number;
    clear?: boolean;
  }) => void;
  private readonly onNarrate: (
    player: string,
    line: { name: string; text: string },
  ) => void;
  private readonly onPlayerPlace: (
    player: string,
    at: { x: number; z: number; y?: number; yaw?: number },
  ) => void;
  private readonly onPlayerFace: (
    player: string,
    at: { x: number; z: number },
  ) => void;
  private readonly onFire: (fire: ScriptedFire) => void;
  private host: ScriptHost | null = null;
  /** The last project loaded, so `restart` can run it once more from scratch. */
  private last: {
    files: Record<string, string>;
    entry: string;
    seed: number;
  } | null = null;

  constructor(params: ScriptConsoleParams) {
    this.heightAt = params.heightAt;
    this.report = params.report ?? (() => {});
    this.onDialog = params.onDialog ?? (() => {});
    this.onEnding = params.onEnding ?? (() => {});
    this.onRestart = params.onRestart ?? (() => {});
    this.onTime = params.onTime ?? (() => {});
    this.onNarrate = params.onNarrate ?? (() => {});
    this.onPlayerPlace = params.onPlayerPlace ?? (() => {});
    this.onPlayerFace = params.onPlayerFace ?? (() => {});
    this.onFire = params.onFire ?? (() => {});
  }

  /** Whether a script is loaded and running. */
  get running(): boolean {
    return this.host !== null;
  }

  /** The NPCs the loaded script has placed, for the world to draw. */
  npcs() {
    return this.host?.npcList ?? [];
  }

  /** The NPC with `id`, or null when the script has not placed one. */
  npc(id: string) {
    return this.host?.npc(id) ?? null;
  }

  /** The props the loaded script has placed, for the world to draw. */
  props() {
    return this.host?.propList ?? [];
  }

  /** The prop with `id`, or null when the script has not placed one. */
  prop(id: string) {
    return this.host?.prop(id) ?? null;
  }

  /** The fires the loaded script has lit, for the world to draw. */
  fires() {
    return this.host?.fireList ?? [];
  }

  /** The blaze with `id`, or null when the script has not lit one. */
  fire(id: string) {
    return this.host?.fire(id) ?? null;
  }

  /**
   * The local player uses the prop with `id` — a tap or click on it — with
   * `item` the id of whatever they are holding, or "" for bare hands.
   */
  async use(id: string, item = ""): Promise<void> {
    await this.host?.use(id, "", item);
  }

  /** Tells the script where the local player now stands, for its zones. */
  async updatePosition(x: number, y: number, z: number): Promise<void> {
    await this.host?.movePlayer("", x, y, z);
  }

  /** Fires any timer the shared clock has reached; cheap when none is set. */
  async pump(): Promise<void> {
    await this.host?.pump();
  }

  /** The local player uses the item they are holding, away from any object. */
  async useItem(id: string): Promise<void> {
    await this.host?.useItem(id, "");
  }

  /** The item the local player is holding, or null when they hold none. */
  heldItem() {
    return this.host?.inventory.heldItem() ?? null;
  }

  /** Starts a talk straight away — the world's tap-and-click path, no console. */
  async talkTo(id: string): Promise<void> {
    await this.host?.talk(id, "");
  }

  /** Picks option `option` (0-based) of the local player's open dialog. */
  async chooseOption(option: number): Promise<void> {
    const current = this.host?.dialogFor("") ?? null;
    if (current === null) {
      return;
    }
    await this.host?.choose(current.npcId, option, "");
  }

  /** Ends the local player's open dialog. */
  async leaveTalk(): Promise<void> {
    const current = this.host?.dialogFor("") ?? null;
    if (current === null) {
      return;
    }
    await this.host?.leave(current.npcId, "");
  }

  /** Loads the bundled sample place script. */
  async loadSample(): Promise<string> {
    await this.loadProject(
      { [MAIN_SCRIPT_FILE]: SAMPLE_PLACE_SCRIPT },
      MAIN_SCRIPT_FILE,
      12_345,
    );
    return `sample script loaded — ${this.loadedLine()}`;
  }

  /**
   * Loads the place's scripts as the running project. The interpreter is built
   * fresh each load, so a creator iterating on a script starts from clean state
   * — no NPC or dialog from a previous run survives — and `seed` seeds its
   * randomness, the seed a place author means to publish. `entry` is the file
   * execution starts from; it must export `bmsTick`.
   */
  async loadProject(
    files: Record<string, string>,
    entry: string,
    seed: number,
  ): Promise<string> {
    this.last = { files, entry, seed };
    const host = await this.freshHost(seed);
    await host.loadProject(files, entry);
    return `script loaded — ${this.loadedLine()}`;
  }

  /**
   * Runs the last loaded project once more from a fresh interpreter, so a
   * place's own state starts over while the world it built stays standing.
   */
  async restart(): Promise<void> {
    if (this.last === null) {
      return;
    }
    await this.loadProject(this.last.files, this.last.entry, this.last.seed);
  }

  /** What the script has made so far: NPCs, dialogs, and any last problem. */
  async describe(): Promise<string> {
    const host = this.host;
    if (host === null) {
      return "no script loaded — use /script:demo";
    }
    const dialog = host.dialogFor("");
    return (
      host.describe() +
      (dialog === null
        ? ""
        : `\n${host.npc(dialog.npcId)?.name ?? dialog.npcId}: ${dialog.prompt}\n${optionLines(dialog)}`)
    );
  }

  /** The player starts talking to the NPC with `id`. */
  async talk(id: string): Promise<string> {
    const host = this.host;
    if (host === null) {
      return "no script loaded — use /script:demo";
    }
    const npc = host.npc(id);
    if (npc === null) {
      return `there is no NPC "${id}" — /script:state lists them`;
    }
    await host.talk(id, "");
    return this.dialogLine() ?? `talking to ${npc.name}, who says nothing yet`;
  }

  /** The player picks option `option` (1-based, as the console numbered it). */
  async choose(option: number): Promise<string> {
    const host = this.host;
    if (host === null) {
      return "no script loaded — use /script:demo";
    }
    const dialog = host.dialogFor("");
    if (dialog === null) {
      return "nobody is talking — /script:talk <id> first";
    }
    if (option < 1 || option > dialog.options.length) {
      return `choose 1..${dialog.options.length}`;
    }
    await host.choose(dialog.npcId, option - 1, "");
    const after = this.dialogLine();
    return after ?? "the conversation is over";
  }

  /** The player walks away from whoever they were talking to. */
  async leave(): Promise<string> {
    const host = this.host;
    if (host === null) {
      return "no script loaded — use /script:demo";
    }
    const dialog = host.dialogFor("");
    if (dialog === null) {
      return "nobody is talking";
    }
    await host.leave(dialog.npcId, "");
    return "conversation ended";
  }

  dispose(): void {
    this.host?.dispose();
    this.host = null;
  }

  /** A fresh host for `seed`, leaving the previous one's NPCs and dialogs behind. */
  private async freshHost(seed: number): Promise<ScriptHost> {
    this.host?.dispose();
    this.host = new ScriptHost({
      seed,
      now: () => Date.now(),
      heightAt: this.heightAt,
      onToast: (player, text) => {
        if (player === "") {
          this.report(text);
        }
      },
      onDialog: (player, state) => this.onDialog(player, state),
      onNotice: this.report,
      onEnding: (player, state) => this.onEnding(player, state),
      onRestart: (player) => this.onRestart(player),
      onTime: (command) => this.onTime(command),
      onNarrate: (player, line) => this.onNarrate(player, line),
      onPlayerPlace: (player, at) => this.onPlayerPlace(player, at),
      onPlayerFace: (player, at) => this.onPlayerFace(player, at),
      onFire: (fire) => this.onFire(fire),
    });
    return this.host;
  }

  /** Where the loaded script's NPCs stand and how to talk to them, for a load line. */
  private loadedLine(): string {
    const npcs = this.host?.npcList ?? [];
    const where = npcs
      .map((npc) => `${npc.name} at (${npc.x}, ${npc.z})`)
      .join(", ");
    const ids = npcs.map((npc) => npc.id).join(" or ");
    const tail =
      npcs.length === 0
        ? "no NPCs placed yet"
        : `Talk with /script:talk <id> (${ids})`;
    return `${where}. ${tail}`;
  }

  /** The open dialog as console lines, or null when nobody is talking. */
  private dialogLine(): string | null {
    const host = this.host;
    if (host === null) {
      return null;
    }
    const dialog = host.dialogFor("");
    if (dialog === null) {
      return null;
    }
    const name = host.npc(dialog.npcId)?.name ?? dialog.npcId;
    return `${name}: ${dialog.prompt}\n${optionLines(dialog)}`;
  }
}
