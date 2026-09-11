// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { createEndingLog, endingLogKey } from "./ending-log";

const store = new Map<string, string>();
const fakeStorage = {
  getItem: (key: string): string | null => store.get(key) ?? null,
  setItem: (key: string, value: string): void => {
    store.set(key, value);
  },
};

afterEach(() => {
  store.clear();
  vi.unstubAllGlobals();
});

describe("an ending log", () => {
  it("remembers each ending once, in the order first reached", () => {
    vi.stubGlobal("localStorage", fakeStorage);
    const log = createEndingLog(endingLogKey(4_004, "main.ts"));
    expect(log.seen()).toEqual([]);
    log.record("Sleep");
    log.record("Bullied");
    log.record("Sleep");
    expect(log.seen()).toEqual(["Sleep", "Bullied"]);
  });

  it("reads as empty and drops writes when storage is absent", () => {
    vi.stubGlobal("localStorage", undefined);
    const log = createEndingLog("key");
    expect(log.seen()).toEqual([]);
    expect(() => log.record("Sleep")).not.toThrow();
    expect(log.seen()).toEqual([]);
  });
});
