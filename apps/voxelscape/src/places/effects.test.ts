// @vitest-environment node
import { describe, expect, it } from "vitest";
import { parseEffect } from "./effects";
import type { ScriptEffect } from "./sandbox";

const effect = (tag: string, payload: unknown): ScriptEffect => ({
  tag,
  payload: typeof payload === "string" ? payload : JSON.stringify(payload),
});

describe("effect parsing", () => {
  it("accepts a well-formed effect of every tag", () => {
    expect(
      parseEffect(effect("npc", { id: "sable", x: 40, z: 12, name: "Sable" })),
    ).toEqual({
      tag: "npc",
      payload: { id: "sable", x: 40, z: 12, name: "Sable" },
    });
    expect(parseEffect(effect("npc-remove", { id: "sable" }))).not.toBeNull();
    expect(
      parseEffect(
        effect("prop", {
          id: "fridge",
          model: "fridge.zip",
          x: 3,
          z: 4,
          yaw: 1.5,
          height: 3,
        }),
      ),
    ).toEqual({
      tag: "prop",
      payload: {
        id: "fridge",
        model: "fridge.zip",
        x: 3,
        z: 4,
        yaw: 1.5,
        height: 3,
      },
    });
    expect(parseEffect(effect("prop-remove", { id: "fridge" }))).not.toBeNull();
    expect(
      parseEffect(
        effect("item-define", {
          id: "chips",
          name: "Chips",
          sprite: "apple",
          stackable: true,
        }),
      ),
    ).toEqual({
      tag: "item-define",
      payload: { id: "chips", name: "Chips", sprite: "apple", stackable: true },
    });
    expect(
      parseEffect(effect("item-give", { player: "", item: "chips", count: 2 })),
    ).not.toBeNull();
    expect(
      parseEffect(effect("item-take", { player: "", item: "chips", count: 1 })),
    ).not.toBeNull();
    expect(
      parseEffect(effect("item-hold", { player: "", item: "chips" })),
    ).not.toBeNull();
    expect(
      parseEffect(effect("item-hold", { player: "", item: "" })),
    ).not.toBeNull();
    expect(
      parseEffect(
        effect("ending", {
          player: "",
          title: "Chips",
          text: "You ate the chips.",
        }),
      ),
    ).not.toBeNull();
    expect(parseEffect(effect("restart", { player: "" }))).not.toBeNull();
    expect(
      parseEffect(
        effect("zone", {
          id: "kitchen",
          name: "Kitchen",
          min: [0, 0, 0],
          max: [4, 4, 4],
        }),
      ),
    ).not.toBeNull();
    expect(
      parseEffect(effect("zone-remove", { id: "kitchen" })),
    ).not.toBeNull();
    expect(
      parseEffect(
        effect("narrate", { player: "", name: "You", text: "Oh no." }),
      ),
    ).not.toBeNull();
    expect(
      parseEffect(
        effect("npc", { id: "sable", x: 1, z: 2, model: "sable.zip" }),
      ),
    ).not.toBeNull();
    expect(
      parseEffect(effect("npc", { id: "dad", x: 1, z: 2, yaw: 1.5 })),
    ).not.toBeNull();
    expect(
      parseEffect(effect("timer", { id: "cook", afterMs: 1_000 })),
    ).toEqual({ tag: "timer", payload: { id: "cook", afterMs: 1_000 } });
    expect(
      parseEffect(effect("player-place", { player: "", x: 1, z: 2, yaw: 0.5 })),
    ).not.toBeNull();
    expect(
      parseEffect(effect("player-place", { player: "", x: 1, z: 2 })),
    ).not.toBeNull();
    expect(
      parseEffect(effect("player-face", { player: "", x: 1, z: 2 })),
    ).not.toBeNull();
    expect(parseEffect(effect("time", { seconds: 100 }))).not.toBeNull();
    expect(parseEffect(effect("time", { speed: 0 }))).not.toBeNull();
    expect(parseEffect(effect("time", { clear: true }))).not.toBeNull();
    expect(parseEffect(effect("toast", { player: "", text: "hello" }))).toEqual(
      { tag: "toast", payload: { player: "", text: "hello" } },
    );
    expect(
      parseEffect(
        effect("dialog", {
          player: "",
          npcId: "sable",
          prompt: "Hi",
          options: ["Buy", "Leave"],
        }),
      ),
    ).not.toBeNull();
    expect(
      parseEffect(effect("dialog-close", { player: "", npcId: "sable" })),
    ).not.toBeNull();
  });

  it("refuses a payload that does not fit its tag", () => {
    const cases: Array<[string, unknown]> = [
      ["npc", { id: "" }],
      ["npc", { id: "x", x: "40", z: 12 }],
      ["npc", { id: "x".repeat(65), x: 0, z: 0 }],
      ["npc", { id: "x", x: 1e7, z: 0 }],
      ["npc", { id: "x", x: 1, z: 2, yaw: "n" }],
      ["npc-remove", {}],
      ["timer", { id: "cook" }],
      ["timer", { id: "cook", afterMs: -1 }],
      ["timer", { id: "cook", afterMs: 1e9 }],
      ["timer", { id: "", afterMs: 1 }],
      ["player-place", { player: "", x: 1 }],
      ["player-place", { player: "", x: 1, z: 2, yaw: "n" }],
      ["player-face", { player: "", x: 1 }],
      ["prop", { id: "fridge", x: 0, z: 0 }],
      ["prop", { id: "fridge", model: "fridge.zip", x: 0, z: 0, height: 0 }],
      ["prop", { id: "fridge", model: "fridge.zip", x: 0, z: 0, yaw: "n" }],
      ["prop-remove", {}],
      ["item-define", { id: "chips", name: "Chips", sprite: "apple" }],
      ["item-give", { player: "", item: "chips", count: 0 }],
      ["item-take", { player: "", item: "", count: 1 }],
      ["item-hold", { player: "" }],
      ["ending", { player: "", title: "", text: "x" }],
      ["ending", { player: "", title: "T", text: "x".repeat(1001) }],
      ["restart", {}],
      ["zone", { id: "x", min: [0, 0, 0] }],
      ["zone", { id: "x", min: [2, 0, 0], max: [1, 1, 1] }],
      ["zone", { id: "x", min: [0, 0, 0], max: [0, 0, "z"] }],
      ["zone-remove", {}],
      ["narrate", { player: "", name: "You" }],
      ["narrate", { player: "", name: "", text: "x" }],
      ["time", {}],
      ["time", { seconds: -1 }],
      ["time", { speed: "fast" }],
      ["toast", { text: "x" }],
      ["toast", { player: "", text: "x".repeat(301) }],
      ["dialog", { player: "", npcId: "sable", prompt: "Hi", options: [] }],
      [
        "dialog",
        {
          player: "",
          npcId: "sable",
          prompt: "Hi",
          options: ["1", "2", "3", "4", "5", "6", "7", "8", "9"],
        },
      ],
      [
        "dialog",
        { player: "", npcId: "sable", prompt: "Hi", options: ["x".repeat(81)] },
      ],
      ["dialog-close", { npcId: "sable" }],
      ["something-else", { id: "x" }],
      ["npc", "not an object"],
    ];
    for (const [tag, payload] of cases) {
      expect(
        parseEffect(effect(tag, payload)),
        `${tag} ${JSON.stringify(payload)}`,
      ).toBeNull();
    }
  });

  it("refuses a payload that is not JSON", () => {
    expect(parseEffect({ tag: "npc", payload: "{nope" })).toBeNull();
  });
});
