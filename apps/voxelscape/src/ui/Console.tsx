import { createPopover } from "@big-mesh-studios/utils/create-popover";
import {
  createEffect,
  createSignal,
  For,
  onCleanup,
  Show,
  type Component,
} from "solid-js";
import type { CommandHelp, CommandOutput } from "../commands";
import { isEditableTarget } from "../utils";
import styles from "./Console.module.css";

export interface ConsoleInputHandle {
  /** Focuses the input and replaces what is typed, leaving the caret at the end. */
  prefill(text: string): void;
}

const ConsoleInput: Component<{
  /** Every command, for completing the one being typed and hinting what it takes. */
  commands: CommandHelp[];
  /** Whether the console panel is showing, and with it this input. */
  open: boolean;
  onCommand(command: string): void;
  ref(handle: ConsoleInputHandle): void;
}> = (props) => {
  let element: HTMLInputElement = null!;
  let suggestions: HTMLUListElement = null!;

  const history: string[] = [];

  const [historyIndex, setHistoryIndex] = createSignal(-1);
  const [value, setValue] = createSignal(() => history[historyIndex()]);
  const [candidateIndex, setCandidateIndex] = createSignal(0);

  /**
   * The command names that fuzzy-match what is typed — every one of its
   * characters appearing in the name in the same order — ranked best match
   * first, shorter names first among equal matches. Only a name is
   * completed, so a line that has reached its arguments has none; one that
   * already spells a name out has none either, unless a longer sibling name
   * extends it too and is worth offering alongside it.
   */
  const candidatesFor = (typed: string): string[] => {
    if (!typed.startsWith("/") || typed.includes(" ")) {
      return [];
    }
    const ranked = props.commands
      .map((command) => command.name)
      .map((name) => [name, fuzzyScore(typed, name)] as const)
      .filter((scored): scored is [string, number] => scored[1] !== undefined)
      .sort(([nameA, a], [nameB, b]) => b - a || nameA.length - nameB.length)
      .map(([name]) => name);
    return ranked.length > 1 ? ranked : ranked.filter((name) => name !== typed);
  };

  /**
   * How well `typed` fuzzy-matches `name`: every character of `typed` has to
   * appear in `name` in the same order, and matches that run together or
   * land earlier score higher. `undefined` when `typed` doesn't match at all.
   */
  const fuzzyScore = (typed: string, name: string): number | undefined => {
    let cursor = 0;
    let streak = 0;
    let score = 0;
    for (const char of typed) {
      const found = name.indexOf(char, cursor);
      if (found === -1) {
        return undefined;
      }
      streak = found === cursor ? streak + 1 : 0;
      score += streak - (found - cursor);
      cursor = found + 1;
    }
    return score;
  };

  /**
   * `name` cut back to the scope boundary that follows what is already typed,
   * so completing `/cl` against `/clock:speed` reaches `/clock:` and
   * completing that again reaches the whole name. A name with no boundary
   * left to stop at completes in full.
   */
  const toScopeBoundary = (name: string, typed: string): string => {
    const boundary = name.indexOf(":", typed.length);
    return boundary === -1 ? name : name.slice(0, boundary + 1);
  };

  const typed = (): string => value() ?? "";

  /**
   * What the command being typed still takes, ghosted after it once its name is
   * spelled out in full. Completing a name is `candidate`'s job; this takes
   * over when there is no name left to complete and the question becomes what
   * goes after it.
   */
  const hint = (): string => {
    const line = typed();
    const command = props.commands.find(
      (entry) => entry.name === line.trimEnd(),
    );
    if (command?.args === undefined) {
      return "";
    }
    // A space of its own, unless what is typed already ends in one.
    return `${line.endsWith(" ") ? "" : " "}${command.args}`;
  };
  const candidates = (): string[] => candidatesFor(typed());
  /** The candidate the arrow keys have landed on, if any is left to show. */
  const candidate = (): string | undefined => candidates()[candidateIndex()];
  /** Whether `line` already spells out a command's name in full. */
  const isCommand = (line: string): boolean =>
    props.commands.some((command) => command.name === line);
  /**
   * `candidate`, only when it continues what is typed as a prefix and what is
   * typed isn't already a complete command in its own right — a fuzzy match
   * that skips ahead of the caret has no trailing remainder that can be
   * ghosted after it, and a name that already stands on its own defers to
   * `hint` instead of ghosting a longer sibling on top of it.
   */
  const ghost = (): string | undefined => {
    if (isCommand(typed())) {
      return undefined;
    }
    const name = candidate();
    return name?.startsWith(typed()) ? name : undefined;
  };

  // Showing the list again whenever the panel reopens puts it back on top of
  // the panel in the top layer, which is stacked in the order things were
  // shown.
  createEffect(
    () => props.open && candidates().length > 0,
    (shown) => {
      suggestions.togglePopover(shown);
    },
  );

  // Keeps the highlighted suggestion in view as the arrow keys walk past the
  // end of the list's scrolled window.
  createEffect(
    () => candidateIndex(),
    (index) => {
      suggestions.children[index]?.scrollIntoView({ block: "nearest" });
    },
  );

  /** Replaces what is typed, leaving the caret at the end. */
  const fill = (text: string): void => {
    setValue(text);
    setCandidateIndex(0);
    // The signal only reaches the DOM on the next microtask, and the caret
    // has to be placed behind text that is already there.
    element.value = text;
    element.focus();
    element.setSelectionRange(text.length, text.length);
  };

  const onKeyDown = (
    event: KeyboardEvent & { currentTarget: HTMLInputElement },
  ) => {
    switch (event.key) {
      case "Enter": {
        const line = event.currentTarget.value.trim();
        // A line that already names a command runs as itself; one still
        // being completed runs as the completion standing behind it.
        const command = isCommand(line)
          ? line
          : (candidatesFor(line)[candidateIndex()] ?? line);

        if (command === "") {
          return;
        }

        props.onCommand(command);
        history.push(command);
        setCandidateIndex(0);
        setValue("");

        return;
      }
      case "Tab": {
        const completion = candidate();
        if (completion === undefined) {
          return;
        }
        event.preventDefault();
        const scope = completion.startsWith(typed())
          ? toScopeBoundary(completion, typed())
          : completion;
        fill(scope);
        // The name the arrows had landed on is still the one being completed,
        // so the highlight follows it to the place it takes in the shorter
        // list rather than starting over at the top.
        setCandidateIndex(
          Math.max(0, candidatesFor(scope).indexOf(completion)),
        );
        return;
      }
      case "ArrowUp": {
        // While a completion is standing behind the caret the arrows belong to
        // it, even when there is only the one and they have nowhere to go.
        const count = candidates().length;
        if (count > 0) {
          event.preventDefault();
          setCandidateIndex((index) => (index + count - 1) % count);
          return;
        }
        setHistoryIndex((index) => {
          if (index === -1) {
            return history.length - 1;
          }
          return index - 1;
        });
        return;
      }
      case "ArrowDown": {
        const count = candidates().length;
        if (count > 0) {
          event.preventDefault();
          setCandidateIndex((index) => (index + 1) % count);
          return;
        }
        setHistoryIndex((index) => {
          if (index === history.length - 1) {
            return -1;
          }
          return index + 1;
        });
        return;
      }
    }
  };

  props.ref({ prefill: fill });

  return (
    <div class={styles.field}>
      <input
        ref={element}
        value={value()}
        autofocus
        onInput={(e) => {
          setHistoryIndex(-1);
          setCandidateIndex(0);
          setValue(e.currentTarget.value);
        }}
        onKeyDown={onKeyDown}
        placeholder="type a command (/help)"
        class={styles.input}
      />
      <Show when={ghost()}>
        {(completion) => (
          <div class={styles.completion} aria-hidden="true">
            <span class={styles.typed}>{typed()}</span>
            {completion().slice(typed().length)}
          </div>
        )}
      </Show>
      <Show when={hint()}>
        {(args) => (
          <div class={styles.completion} aria-hidden="true">
            <span class={styles.typed}>{typed()}</span>
            {args()}
          </div>
        )}
      </Show>
      {/* A manual popover, kept a child of the field so that the panel around
          it counts as its ancestor and a click on a name doesn't dismiss the
          console. Showing it lifts it into the top layer, clear of the
          panel's clipped edges. */}
      <ul ref={suggestions} popover="manual" class={styles.suggestions}>
        <For each={candidates()}>
          {(name, index) => (
            <li
              class={[
                styles.suggestion,
                { [styles.selected]: index() === candidateIndex() },
              ]}
              // The input keeps the focus, so the caret sits after the name the
              // pointer picked and arguments can be typed straight on.
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => fill(name)}
            >
              {name}
            </li>
          )}
        </For>
      </ul>
    </div>
  );
};

/**
 * One entry of the output: a line the world or a command printed, the echo of
 * a command as it was typed, or the table `/help` answers with.
 */
type ConsoleEntry =
  | { kind: "line"; text: string }
  | { kind: "echo"; command: string }
  | { kind: "help"; commands: CommandHelp[] };

/** A typed command, its name and arguments coloured as `/help` colours them. */
const Echo: Component<{ command: string }> = (props) => {
  const name = (): string => props.command.split(/\s/)[0];
  const args = (): string => props.command.slice(name().length);

  return (
    <div>
      <span class={styles.prompt}>{"> "}</span>
      <span class={styles.name}>{name()}</span>
      <span class={styles.args}>{args()}</span>
    </div>
  );
};

/** Every command, its name against what it does and what it takes. */
const Help: Component<{ commands: CommandHelp[] }> = (props) => (
  <dl class={styles.help}>
    <For each={props.commands}>
      {(command) => (
        <>
          <dt class={styles.name}>{command.name}</dt>
          <dd>
            <Show when={command.args}>
              <span class={styles.args}>{command.args} </span>
            </Show>
            {command.description}
          </dd>
        </>
      )}
    </For>
  </dl>
);

const ConsoleOutput: Component<{ entries: ConsoleEntry[] }> = (props) => {
  let element: HTMLOutputElement = null!;

  // keep the output scrolled to the newest entry
  createEffect(
    () => props.entries,
    () => {
      element.scrollTop = element.scrollHeight;
    },
  );

  return (
    <output ref={element} class={styles.output}>
      <For each={props.entries}>
        {(entry) => {
          switch (entry.kind) {
            case "echo":
              return <Echo command={entry.command} />;
            case "help":
              return <Help commands={entry.commands} />;
            default:
              return <div>{entry.text}</div>;
          }
        }}
      </For>
    </output>
  );
};

export interface ConsoleProps {
  onCommand: (line: string) => CommandOutput | Promise<CommandOutput>;
  /** Every command, for completing the one being typed and hinting what it takes. */
  commands: CommandHelp[];
  /**
   * A line to append to the output that no typed command asked for, such as
   * the world reporting its atproto state at startup.
   */
  notice?: string;
}

/**
 * A collapsible command-line overlay for debugging. The `>_` button sits at
 * the top-right; pressing it reveals a small terminal where commands typed
 * in the input are handed to `onCommand`, whose return value is echoed as
 * output. Typing `/` while playing opens it too, with the slash already
 * entered.
 */
export const Console: Component<ConsoleProps> = (props) => {
  const [entries, setEntries] = createSignal<ConsoleEntry[]>([]);

  const append = (...added: ConsoleEntry[]): void => {
    setEntries((entries) => [...entries, ...added]);
  };

  /** What a command handed back, as entries to print under its echo. */
  const printed = (output: CommandOutput): ConsoleEntry[] =>
    typeof output === "string"
      ? output.split("\n").map((text) => ({ kind: "line", text }))
      : [{ kind: "help", commands: output }];

  const Popover = createPopover();

  let input: ConsoleInputHandle = null!;

  const controller = new AbortController();
  onCleanup(() => controller.abort());

  window.addEventListener(
    "keydown",
    (event) => {
      // Modified slashes belong to the browser (Ctrl+/ and friends), and a
      // slash typed into any text field is just a slash.
      if (
        event.key !== "/" ||
        event.ctrlKey ||
        event.metaKey ||
        event.altKey ||
        isEditableTarget(event)
      ) {
        return;
      }
      event.preventDefault();
      Popover.open();
      input.prefill("/");
    },
    { signal: controller.signal },
  );

  createEffect(
    () => props.notice,
    (notice) => {
      if (notice !== undefined) {
        append({ kind: "line", text: notice });
      }
    },
  );

  async function onCommand(command: string) {
    if (command === "/clear") {
      setEntries([]);
      return;
    }

    const result = props.onCommand(command);

    if (!(result instanceof Promise)) {
      append({ kind: "echo", command }, ...printed(result));
      return;
    }

    append({ kind: "echo", command }, { kind: "line", text: "…" });

    try {
      append(...printed(await result));
    } catch (error) {
      append({ kind: "line", text: `command failed: ${String(error)}` });
    }
  }

  return (
    <div class={styles.underlay}>
      <Popover.Trigger class={styles.anchor}>{">_"}</Popover.Trigger>
      <Popover.PopOver class={styles.console}>
        <ConsoleOutput entries={entries()} />
        <div class={styles["input-container"]}>
          <span class={styles.prefix}>{">"}</span>
          <ConsoleInput
            commands={props.commands}
            open={Popover.isOpen()}
            onCommand={onCommand}
            ref={(handle) => {
              input = handle;
            }}
          />
        </div>
      </Popover.PopOver>
    </div>
  );
};
