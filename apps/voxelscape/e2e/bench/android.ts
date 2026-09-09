// Measuring on a phone plugged into this machine, through the Chrome already
// installed on it.
//
// The phone is a different machine in every way that matters here: its own
// graphics card, its own screen and pixel ratio, its own power. So a run on it
// takes the screen it has rather than a page size chosen here, reads its
// battery rather than this machine's, and refuses the flags that only mean
// something on a desktop.
//
// What a phone cannot answer is how long the card spent drawing: Chrome does
// not expose `EXT_disjoint_timer_query_webgl2` on Android, so the frame gap and
// the main thread's phases are all a run has. The report already says as much
// where the timing would go.
import { execFileSync } from "node:child_process";
import { _android as android } from "playwright";
import type { AndroidDevice } from "playwright";
import { UNKNOWN_POWER } from "./power.ts";
import type { PowerState } from "./power.ts";

/**
 * The one phone attached to this machine, or a refusal naming what was found
 * instead: a run has to know which machine its numbers came from, and two
 * phones cannot both be that machine.
 */
export const attachedPhone = async (): Promise<AndroidDevice> => {
  const devices = await android.devices();
  if (devices.length === 0) {
    throw new Error(
      "no phone answered: plug one in, unlock it, and allow the computer to debug it",
    );
  }
  if (devices.length > 1) {
    const models = devices.map((device) => device.model()).join(", ");
    throw new Error(
      `${devices.length} phones answered (${models}); unplug all but the one to measure`,
    );
  }
  return devices[0];
};

/**
 * Points the phone's own `localhost:port` at this machine's, so the page the
 * phone loads is the preview server running here. Returns the undo.
 *
 * @param serial Which phone to forward, as `adb` names it.
 * @param port The port the preview server answers on, on both ends.
 */
export const forwardPort = (serial: string, port: number): (() => void) => {
  const adb = (...args: string[]): void => {
    execFileSync("adb", ["-s", serial, ...args], { stdio: "ignore" });
  };
  try {
    adb("reverse", `tcp:${port}`, `tcp:${port}`);
  } catch {
    throw new Error(
      `could not point the phone's port ${port} at this machine's; is \`adb\` installed and the phone allowed to debug?`,
    );
  }
  return () => {
    try {
      adb("reverse", "--remove", `tcp:${port}`);
    } catch {
      // The phone may already be gone, which is the state this wanted anyway.
    }
  };
};

/** Whether `dumpsys battery` reports the phone drawing from something other than itself. */
export const sourceFromDumpsys = (text: string): PowerState["source"] => {
  const powered = /(?:AC|USB|Wireless) powered: (true|false)/g;
  let external = false;
  let answered = false;
  for (const match of text.matchAll(powered)) {
    answered = true;
    external = external || match[1] === "true";
  }
  return answered ? (external ? "wall" : "battery") : "unknown";
};

/** The charge `dumpsys battery` reports, from 0 to 1, or null if it reports none. */
export const chargeFromDumpsys = (text: string): number | null => {
  const level = /^\s*level: (\d+)/m.exec(text);
  return level === null ? null : Number(level[1]) / 100;
};

/**
 * How the phone was powered while it was measured. A phone measured over USB is
 * charging, which is worth reading as "on the wall": it is the fast, cool state,
 * and a run made on its battery is a different machine — as is the same phone
 * once it has grown hot, which nothing here can see.
 */
export const devicePower = async (
  device: AndroidDevice,
): Promise<PowerState> => {
  const read = async (command: string): Promise<string | null> => {
    try {
      return (await device.shell(command)).toString();
    } catch {
      return null;
    }
  };
  const battery = await read("dumpsys battery");
  const saver = await read("settings get global low_power");
  if (battery === null) {
    return UNKNOWN_POWER;
  }
  return {
    source: sourceFromDumpsys(battery),
    charge: chargeFromDumpsys(battery),
    lowPower: saver === null ? null : saver.trim() === "1",
  };
};

/**
 * Turns the phone on its side for the run and hands back the undo, because a
 * phone held upright gives the page a tall narrow frustum that is neither how
 * the world is played nor the shape any other run measured it at.
 *
 * Automatic rotation goes off while this holds: a phone lying on a desk reports
 * whatever way up it feels like, which would decide the page size mid-run.
 */
export const rotateLandscape = async (
  device: AndroidDevice,
): Promise<() => Promise<void>> => {
  const setting = async (name: string): Promise<string | null> => {
    try {
      const value = (await device.shell(`settings get system ${name}`))
        .toString()
        .trim();
      return value === "null" ? null : value;
    } catch {
      return null;
    }
  };
  const put = async (name: string, value: string): Promise<void> => {
    await device.shell(`settings put system ${name} ${value}`);
  };
  const wasAutomatic = await setting("accelerometer_rotation");
  const wasRotation = await setting("user_rotation");
  await put("accelerometer_rotation", "0");
  // 1 is a quarter turn, which is the phone on its side.
  await put("user_rotation", "1");
  return async () => {
    try {
      await put("user_rotation", wasRotation ?? "0");
      await put("accelerometer_rotation", wasAutomatic ?? "1");
    } catch {
      // The phone may already be gone, and its own rotation outlives this run
      // either way.
    }
  };
};

/** One line naming the phone a run was measured on, for the console. */
export const describePhone = (device: AndroidDevice): string =>
  `${device.model()} (${device.serial()})`;
