// The scenarios a report measured, linked, at the top of the page.
//
// A report is several screens of charts per scenario, and a reader arrives
// asking about one of them. Without this the only way to the third scenario is
// to scroll past the first two.
import { For } from "solid-js";
import type { JSX } from "@solidjs/web/jsx-runtime";

/** One heading a report's contents links to. */
export interface ContentsEntry {
  /** The `id` of the section, which the link jumps to. */
  id: string;
  label: string;
}

/**
 * A heading's `id`, made from the text a reader sees so a link to it can be
 * written down and kept: lowercase, and anything that is not a letter or digit
 * becomes a hyphen.
 */
export const anchorFor = (label: string): string =>
  label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

/** The scenarios of a report, in the order the page holds them. */
export function Contents(props: { entries: ContentsEntry[] }): JSX.Element {
  return (
    <nav class="contents" aria-label="The scenarios this report measured">
      <span>scenarios:</span>
      <For each={props.entries}>
        {(entry) => <a href={`#${entry.id}`}>{entry.label}</a>}
      </For>
    </nav>
  );
}
