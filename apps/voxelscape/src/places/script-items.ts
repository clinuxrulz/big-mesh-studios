// The items a place script defines and the local player carries: a flat count
// per item id, the definitions behind them, and the one the player is holding.
// This is separate from the block-and-tool hotbar the world builds in — a
// place's own game keeps its own items (a snack, a soda, a note) — and a plain
// class with a change callback, like `Inventory` is for the hotbar.
import type { ScriptItemDefinition } from "./effects";

export class ScriptInventory {
  /** Called whenever a count, a definition, or the held item changes. */
  onChange: (() => void) | null = null;

  private readonly definitions = new Map<string, ScriptItemDefinition>();
  private readonly counts = new Map<string, number>();
  private held: string | null = null;

  /** Registers an item, keeping any count already carried under its id. */
  define(definition: ScriptItemDefinition): void {
    this.definitions.set(definition.id, definition);
    this.emit();
  }

  /** The definition of `id`, or null when the script has not defined it. */
  definition(id: string): ScriptItemDefinition | null {
    return this.definitions.get(id) ?? null;
  }

  /** Every defined item, in the order the script defined them. */
  definitionsList(): ScriptItemDefinition[] {
    return [...this.definitions.values()];
  }

  /** Adds `n` of an item; an item the script defined as unstackable stays at one. */
  give(id: string, n: number = 1): void {
    const definition = this.definitions.get(id);
    const current = this.counts.get(id) ?? 0;
    this.counts.set(
      id,
      definition !== undefined && !definition.stackable ? 1 : current + n,
    );
    this.emit();
  }

  /** Removes `n` of an item; returns false when there weren't enough. */
  take(id: string, n: number = 1): boolean {
    const have = this.counts.get(id) ?? 0;
    if (have < n) {
      return false;
    }
    const left = have - n;
    if (left === 0) {
      this.counts.delete(id);
      if (this.held === id) {
        this.held = null;
      }
    } else {
      this.counts.set(id, left);
    }
    this.emit();
    return true;
  }

  /** How many of an item the player carries. */
  count(id: string): number {
    return this.counts.get(id) ?? 0;
  }

  /** The item the player is holding, if any. */
  get heldId(): string | null {
    return this.held;
  }

  /** The definition of what the player holds, or null when they hold nothing. */
  heldItem(): ScriptItemDefinition | null {
    return this.held === null
      ? null
      : (this.definitions.get(this.held) ?? null);
  }

  /**
   * Holds `id`, or nothing when null. An item the player does not carry cannot
   * be held, so a stale hold is dropped rather than shown.
   */
  hold(id: string | null): void {
    this.held = id !== null && this.count(id) > 0 ? id : null;
    this.emit();
  }

  clear(): void {
    this.definitions.clear();
    this.counts.clear();
    this.held = null;
    this.emit();
  }

  private emit(): void {
    this.onChange?.();
  }
}
