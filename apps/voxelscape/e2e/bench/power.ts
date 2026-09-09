// Where the machine was drawing its power while a run was measured, and
// whether it was holding itself back to save it. A laptop on its battery runs
// its graphics slower than the same laptop on the wall, and a low-power mode
// slows it further still, so two runs made either side of a charger being
// plugged in are two different machines however alike the numbers look.
//
// Being on the wall is asked of the system where the system can be asked, and
// of the browser otherwise: the page can read it wherever the benchmark runs.
// A low-power mode has no such common ground — every system names its own and
// means something different by it — so it is read where it is known and left
// unanswered where it is not.
import { execFileSync } from "node:child_process";
import { platform } from "node:os";

/** How a machine was powered, as far as anything could tell. */
export interface PowerState {
  /** Whether the machine was drawing from the wall or from its battery. */
  source: "wall" | "battery" | "unknown";
  /** The battery's charge, from 0 to 1, or null where nothing could read it. */
  charge: number | null;
  /** Whether the system was holding itself back, or null where that cannot be read. */
  lowPower: boolean | null;
}

/** What nothing could answer. */
export const UNKNOWN_POWER: PowerState = {
  source: "unknown",
  charge: null,
  lowPower: null,
};

/** Which power source `pmset -g batt` says the machine is drawing from. */
export const sourceFromPmset = (text: string): PowerState["source"] => {
  if (text.includes("'AC Power'")) {
    return "wall";
  }
  if (text.includes("'Battery Power'")) {
    return "battery";
  }
  return "unknown";
};

/** The charge `pmset -g batt` reports, from 0 to 1, or null if it reports none. */
export const chargeFromPmset = (text: string): number | null => {
  const percent = /(\d+)%/.exec(text);
  return percent === null ? null : Number(percent[1]) / 100;
};

/** Whether `pmset -g` reports the low-power mode as on, or null if it says nothing. */
export const lowPowerFromPmset = (text: string): boolean | null => {
  const flag = /lowpowermode\s+(\d+)/.exec(text);
  return flag === null ? null : flag[1] !== "0";
};

/** What a command prints, or null when it cannot be run at all. */
const output = (command: string, args: string[]): string | null => {
  try {
    return execFileSync(command, args, { encoding: "utf8" });
  } catch {
    return null;
  }
};

/**
 * What the system this is running on says about its own power.
 *
 * Only macOS is asked so far; everywhere else this answers that it does not
 * know, and the browser is asked about the power source instead.
 */
export const systemPower = (): PowerState => {
  if (platform() !== "darwin") {
    return UNKNOWN_POWER;
  }
  const battery = output("pmset", ["-g", "batt"]);
  const settings = output("pmset", ["-g"]);
  return {
    source: battery === null ? "unknown" : sourceFromPmset(battery),
    charge: battery === null ? null : chargeFromPmset(battery),
    lowPower: settings === null ? null : lowPowerFromPmset(settings),
  };
};

/**
 * Whether two runs were powered alike. The charge is not part of the answer:
 * it falls a little through any run and says nothing about how fast the
 * machine was allowed to go, while the source and the low-power mode each do.
 */
export const samePower = (one: PowerState, two: PowerState): boolean =>
  one.source === two.source && one.lowPower === two.lowPower;

/** One line about a machine's power, for a report's heading. */
export const describePower = (power: PowerState): string => {
  const charge =
    power.charge === null ? "" : ` at ${Math.round(power.charge * 100)}%`;
  const source =
    power.source === "unknown"
      ? "power source unknown"
      : `on the ${power.source === "wall" ? "wall" : `battery${charge}`}`;
  if (power.lowPower === null) {
    return source;
  }
  return `${source}, low power mode ${power.lowPower ? "on" : "off"}`;
};
