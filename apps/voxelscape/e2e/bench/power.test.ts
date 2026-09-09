import { describe, expect, it } from "vitest";
import {
  chargeFromPmset,
  describePower,
  samePower,
  lowPowerFromPmset,
  sourceFromPmset,
} from "./power.ts";

const ON_BATTERY = `Now drawing from 'Battery Power'
 -InternalBattery-0 (id=7798883)\t100%; discharging; (no estimate) present: true`;

const ON_WALL = `Now drawing from 'AC Power'
 -InternalBattery-0 (id=7798883)\t93%; charging; 0:24 remaining present: true`;

describe("reading what pmset prints", () => {
  it("tells the wall from the battery", () => {
    expect(sourceFromPmset(ON_WALL)).toBe("wall");
    expect(sourceFromPmset(ON_BATTERY)).toBe("battery");
  });

  it("does not guess when neither is named", () => {
    expect(sourceFromPmset("no power source here")).toBe("unknown");
  });

  it("takes the charge as a fraction", () => {
    expect(chargeFromPmset(ON_BATTERY)).toBe(1);
    expect(chargeFromPmset(ON_WALL)).toBeCloseTo(0.93);
  });

  it("reads no charge from a machine with no battery", () => {
    expect(chargeFromPmset("Now drawing from 'AC Power'")).toBeNull();
  });

  it("reads the low power mode flag both ways", () => {
    expect(lowPowerFromPmset(" lowpowermode         1")).toBe(true);
    expect(lowPowerFromPmset(" lowpowermode         0")).toBe(false);
  });

  it("leaves the low power mode unanswered when it is not printed", () => {
    expect(lowPowerFromPmset(" hibernatemode        3")).toBeNull();
  });
});

describe("describePower", () => {
  it("says the battery and its charge", () => {
    expect(
      describePower({ source: "battery", charge: 1, lowPower: true }),
    ).toBe("on the battery at 100%, low power mode on");
  });

  it("says nothing of a charge on the wall", () => {
    expect(
      describePower({ source: "wall", charge: 0.93, lowPower: false }),
    ).toBe("on the wall, low power mode off");
  });

  it("leaves out a low power mode nothing could read", () => {
    expect(
      describePower({ source: "wall", charge: null, lowPower: null }),
    ).toBe("on the wall");
  });

  it("admits when it knows nothing", () => {
    expect(
      describePower({ source: "unknown", charge: null, lowPower: null }),
    ).toBe("power source unknown");
  });
});

describe("samePower", () => {
  it("holds two runs on the wall to be alike", () => {
    expect(
      samePower(
        { source: "wall", charge: 1, lowPower: false },
        { source: "wall", charge: 0.94, lowPower: false },
      ),
    ).toBe(true);
  });

  it("tells the wall from the battery", () => {
    expect(
      samePower(
        { source: "wall", charge: 1, lowPower: false },
        { source: "battery", charge: 1, lowPower: false },
      ),
    ).toBe(false);
  });

  it("tells the low power mode apart on the same source", () => {
    expect(
      samePower(
        { source: "wall", charge: 1, lowPower: true },
        { source: "wall", charge: 1, lowPower: false },
      ),
    ).toBe(false);
  });
});
