// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { ScriptInventory } from "./script-items";

const chips = { id: "chips", name: "Chips", sprite: "apple", stackable: true };
const note = { id: "note", name: "Note", sprite: "", stackable: false };

describe("ScriptInventory", () => {
  it("gives, counts, and takes a stackable item", () => {
    const inv = new ScriptInventory();
    inv.define(chips);
    inv.give("chips", 2);
    inv.give("chips", 3);
    expect(inv.count("chips")).toBe(5);
    expect(inv.take("chips", 4)).toBe(true);
    expect(inv.count("chips")).toBe(1);
    expect(inv.take("chips", 2)).toBe(false);
  });

  it("keeps an unstackable item at one no matter how often it is given", () => {
    const inv = new ScriptInventory();
    inv.define(note);
    inv.give("note", 5);
    expect(inv.count("note")).toBe(1);
  });

  it("holds an item the player carries, and drops a stale hold", () => {
    const inv = new ScriptInventory();
    inv.define(chips);
    inv.give("chips", 1);
    inv.hold("chips");
    expect(inv.heldId).toBe("chips");
    expect(inv.heldItem()).toEqual(chips);
    inv.take("chips", 1);
    expect(inv.heldId).toBeNull();
    expect(
      inv.hold("chips"),
      "cannot hold what is not carried",
    ).toBeUndefined();
    expect(inv.heldId).toBeNull();
  });

  it("reports changes through its callback", () => {
    const inv = new ScriptInventory();
    const spy = vi.fn();
    inv.onChange = spy;
    inv.define(chips);
    inv.give("chips");
    inv.hold("chips");
    inv.clear();
    expect(spy).toHaveBeenCalledTimes(4);
  });
});
