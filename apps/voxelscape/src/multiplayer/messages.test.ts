// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  MAX_DAMAGE,
  MAX_MONSTERS_PER_MESSAGE,
  decodeMessage,
  encodeMessage,
} from "./messages";

const update = (): Record<string, unknown> => ({
  id: "m1_0_0_0",
  kind: "zombie",
  x: 1.23456,
  y: 11.1,
  z: -4.567,
  yaw: 0.5,
  vx: 2.4,
  vz: -0.5,
  hp: 20,
  state: "chase",
  updatedAt: 1_000,
});

describe("monster message codec", () => {
  it("round-trips a monster broadcast", () => {
    const encoded = encodeMessage({
      v: 1,
      type: "monster",
      seq: 3,
      t: 500,
      updates: [update() as never],
    });
    const decoded = decodeMessage(encoded);
    expect(decoded).not.toBeNull();
    expect(decoded!.type).toBe("monster");
    const message = decoded as Extract<typeof decoded, { type: "monster" }>;
    expect(message.seq).toBe(3);
    expect(message.t).toBe(500);
    expect(message.updates).toHaveLength(1);
    expect(message.updates[0]).toMatchObject({
      id: "m1_0_0_0",
      kind: "zombie",
      state: "chase",
      hp: 20,
    });
    // coordinates are quantized to keep the payload small
    expect(message.updates[0].x).toBeCloseTo(1.23, 2);
    expect(message.updates[0].z).toBeCloseTo(-4.57, 2);
    expect(message.updates[0].vx).toBeCloseTo(2.4, 2);
  });

  it("accepts a valid monster broadcast", () => {
    const encoded = encodeMessage({
      v: 1,
      type: "monster",
      seq: 1,
      t: 1,
      updates: [update() as never],
    });
    expect(decodeMessage(encoded)).not.toBeNull();
  });

  it("rejects monster updates with an out-of-grammar id", () => {
    const encoded = encodeMessage({
      v: 1,
      type: "monster",
      seq: 1,
      t: 1,
      updates: [{ ...update(), id: "garbage!!" } as never],
    });
    expect(decodeMessage(encoded)).toBeNull();
  });

  it("rejects monster updates with an unknown state", () => {
    const encoded = encodeMessage({
      v: 1,
      type: "monster",
      seq: 1,
      t: 1,
      updates: [{ ...update(), state: "fly" } as never],
    });
    expect(decodeMessage(encoded)).toBeNull();
  });

  it("rejects monster updates with impossible speed, health, or coordinates", () => {
    const cases: Array<Record<string, unknown>> = [
      { ...update(), vx: 500 },
      { ...update(), vz: -1_000 },
      { ...update(), hp: -1 },
      { ...update(), hp: 1_000 },
      { ...update(), x: 1_000_000 },
      { ...update(), yaw: "north" },
    ];
    for (const bad of cases) {
      const encoded = encodeMessage({
        v: 1,
        type: "monster",
        seq: 1,
        t: 1,
        updates: [bad as never],
      });
      expect(decodeMessage(encoded), JSON.stringify(bad)).toBeNull();
    }
  });

  it("rejects an oversized monster batch", () => {
    const encoded = encodeMessage({
      v: 1,
      type: "monster",
      seq: 1,
      t: 1,
      updates: Array.from({ length: MAX_MONSTERS_PER_MESSAGE + 1 }, () =>
        update(),
      ) as never,
    });
    expect(decodeMessage(encoded)).toBeNull();
  });
});

describe("damage message codec", () => {
  const damage = (
    overrides: Record<string, unknown> = {},
  ): Record<string, unknown> => ({
    v: 1,
    type: "damage",
    seq: 4,
    t: 600,
    id: "m1_0_0_0",
    amount: 8,
    attackerX: 12.3456,
    attackerZ: -4.5,
    ...overrides,
  });

  it("round-trips a swing's damage", () => {
    const encoded = encodeMessage({
      v: 1,
      type: "damage",
      seq: 4,
      t: 600,
      id: "m1_0_0_0",
      amount: 8,
      attackerX: 12.3456,
      attackerZ: -4.5,
    });
    const decoded = decodeMessage(encoded);
    expect(decoded).not.toBeNull();
    expect(decoded!.type).toBe("damage");
    const message = decoded as Extract<typeof decoded, { type: "damage" }>;
    expect(message.seq).toBe(4);
    expect(message.t).toBe(600);
    expect(message.id).toBe("m1_0_0_0");
    expect(message.amount).toBe(8);
    // the attacker's position is quantized like the monster positions
    expect(message.attackerX).toBeCloseTo(12.35, 2);
    expect(message.attackerZ).toBeCloseTo(-4.5, 2);
  });

  it("accepts a valid damage message", () => {
    const encoded = encodeMessage({
      v: 1,
      type: "damage",
      seq: 1,
      t: 1,
      id: "m1_0_0_0",
      amount: 1,
      attackerX: 0,
      attackerZ: 0,
    });
    expect(decodeMessage(encoded)).not.toBeNull();
  });

  it("rejects damage with an out-of-grammar id or an impossible amount", () => {
    const cases = [
      damage({ id: "garbage!!" }),
      damage({ amount: 0 }),
      damage({ amount: -8 }),
      damage({ amount: MAX_DAMAGE + 1 }),
      damage({ amount: 1.5 }),
      damage({ attackerX: 1_000_000 }),
      damage({ attackerZ: "north" }),
      damage({ attackerX: undefined }),
    ];
    for (const bad of cases) {
      expect(
        decodeMessage(JSON.stringify(bad)),
        JSON.stringify(bad),
      ).toBeNull();
    }
  });
});

describe("player-damage message codec", () => {
  const hit = (
    overrides: Record<string, unknown> = {},
  ): Record<string, unknown> => ({
    v: 1,
    type: "player-damage",
    seq: 5,
    t: 700,
    target: "did:plc:abc123",
    amount: 2,
    ...overrides,
  });

  it("round-trips a zombie swing's damage", () => {
    const encoded = encodeMessage({
      v: 1,
      type: "player-damage",
      seq: 5,
      t: 700,
      target: "did:plc:abc123",
      amount: 2,
    });
    const decoded = decodeMessage(encoded);
    expect(decoded).not.toBeNull();
    expect(decoded!.type).toBe("player-damage");
    const message = decoded as Extract<
      typeof decoded,
      { type: "player-damage" }
    >;
    expect(message.seq).toBe(5);
    expect(message.t).toBe(700);
    expect(message.target).toBe("did:plc:abc123");
    expect(message.amount).toBe(2);
  });

  it("accepts a valid player-damage message", () => {
    expect(decodeMessage(JSON.stringify(hit()))).not.toBeNull();
  });

  it("rejects player-damage with a missing target or an impossible amount", () => {
    const cases = [
      hit({ target: "" }),
      hit({ target: undefined }),
      hit({ target: "x".repeat(257) }),
      hit({ amount: 0 }),
      hit({ amount: -2 }),
      hit({ amount: MAX_DAMAGE + 1 }),
      hit({ amount: 1.5 }),
    ];
    for (const bad of cases) {
      expect(
        decodeMessage(JSON.stringify(bad)),
        JSON.stringify(bad),
      ).toBeNull();
    }
  });
});

describe("time message codec", () => {
  const ping = (t1: number): Record<string, unknown> => ({
    v: 1,
    type: "time",
    t1,
  });
  const answer = (t1: number, t2: number): Record<string, unknown> => ({
    v: 1,
    type: "time",
    t1,
    t2,
  });

  it("round-trips a clock ping", () => {
    const decoded = decodeMessage(JSON.stringify(ping(12_345)));
    expect(decoded).not.toBeNull();
    expect(decoded!.type).toBe("time");
    const message = decoded as Extract<typeof decoded, { type: "time" }>;
    expect(message.t1).toBe(12_345);
    expect(message.t2).toBeUndefined();
  });

  it("round-trips a clock answer", () => {
    const decoded = decodeMessage(JSON.stringify(answer(12_345, 12_480)));
    expect(decoded).not.toBeNull();
    expect(decoded!.type).toBe("time");
    const message = decoded as Extract<typeof decoded, { type: "time" }>;
    expect(message.t1).toBe(12_345);
    expect(message.t2).toBe(12_480);
  });

  it("encodes whole-millisecond timestamps", () => {
    const encoded = encodeMessage({
      v: 1,
      type: "time",
      t1: 12_345.6,
      t2: 12_480.4,
    });
    expect(encoded).toContain('"t1":12346');
    expect(encoded).toContain('"t2":12480');
  });

  it("rejects malformed time messages", () => {
    const cases = [
      { v: 1, type: "time" },
      { v: 1, type: "time", t1: "soon" },
      { v: 1, type: "time", t1: -1 },
      { v: 1, type: "time", t1: 1e13 + 1 },
      { v: 1, type: "time", t1: 1, t2: "later" },
      { v: 2, type: "time", t1: 1 },
      { v: 1, type: "edit", t1: 1 },
    ];
    for (const bad of cases) {
      expect(
        decodeMessage(JSON.stringify(bad)),
        JSON.stringify(bad),
      ).toBeNull();
    }
  });
});
