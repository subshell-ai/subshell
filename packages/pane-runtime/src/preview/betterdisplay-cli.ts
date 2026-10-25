import { execFile } from "node:child_process";
import { promisify } from "node:util";

/** BetterDisplay identity checks shared by allocation and durable cleanup. */
export interface OwnedDisplay {
  name: string;
  UUID: string;
  tagID: string;
  displayID: string;
  deviceType: "VirtualScreen";
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NAME_PREFIX = "Subshell-";
const MAX_OUTPUT = 128 * 1024;
export type Run = (args: string[]) => Promise<string>;

export class ExistingDisplayError extends Error {}

export function displayName(id: string): string {
  if (!UUID_PATTERN.test(id)) throw new Error("Expected a UUID for the subshell name.");
  return `${NAME_PREFIX}${id}`;
}

export function validateName(name: string): void {
  if (!name.startsWith(NAME_PREFIX) || !UUID_PATTERN.test(name.slice(NAME_PREFIX.length))) {
    throw new Error("This isn't a display name owned by the subshell.");
  }
}

/** BetterDisplay 5.1.1 emits comma-separated JSON objects without array brackets. */
export function parseIdentifiers(output: string): unknown[] {
  if (Buffer.byteLength(output) > MAX_OUTPUT) throw new Error("BetterDisplay returned too much data.");
  const trimmed = output.trim();
  if (!trimmed) return [];
  const result: unknown = JSON.parse(trimmed.startsWith("[") ? trimmed : `[${trimmed}]`);
  if (!Array.isArray(result) || result.length > 64) throw new Error("Unexpected BetterDisplay display list.");
  return result;
}

function numericID(value: unknown): value is string {
  return typeof value === "string" && /^[1-9][0-9]{0,9}$/.test(value) && Number(value) <= 0xffff_ffff;
}

export function ownedDisplay(value: unknown, expectedName: string): OwnedDisplay {
  validateName(expectedName);
  if (
    typeof value !== "object" ||
    value === null ||
    !("name" in value) ||
    value.name !== expectedName ||
    !("deviceType" in value) ||
    value.deviceType !== "VirtualScreen" ||
    !("UUID" in value) ||
    typeof value.UUID !== "string" ||
    !UUID_PATTERN.test(value.UUID) ||
    !("tagID" in value) ||
    !numericID(value.tagID) ||
    !("displayID" in value) ||
    !numericID(value.displayID)
  ) {
    throw new Error("BetterDisplay didn't identify exactly the virtual display this subshell created.");
  }
  return {
    name: expectedName,
    UUID: value.UUID,
    tagID: value.tagID,
    displayID: value.displayID,
    deviceType: "VirtualScreen",
  };
}

export async function inspectDisplay(run: Run, name: string): Promise<OwnedDisplay | null> {
  validateName(name);
  // A name-filtered query exits 1 with only "Failed." for an absent display,
  // indistinguishable from other CLI failures. A successful full inventory
  // proves absence without treating a failed command as an empty list.
  const entries = parseIdentifiers(await run(["get", "-identifiers"]));
  if (entries.length === 0) throw new Error("BetterDisplay didn't return a display inventory.");
  for (const entry of entries) {
    if (
      typeof entry !== "object" ||
      entry === null ||
      !("name" in entry) ||
      typeof entry.name !== "string" ||
      !("deviceType" in entry) ||
      !["Display", "VirtualScreen", "DisplayGroup"].includes(String(entry.deviceType))
    ) {
      throw new Error("BetterDisplay returned an unrecognized inventory entry.");
    }
  }
  const matches = entries.filter(
    (entry) => typeof entry === "object" && entry !== null && "name" in entry && entry.name === name,
  );
  if (matches.length === 0) return null;
  if (matches.length !== 1) throw new Error("The subshell name matches several displays; refusing to choose one.");
  return ownedDisplay(matches[0], name);
}

export async function createDisplay(run: Run, name: string, width: number, height: number): Promise<OwnedDisplay> {
  validateName(name);
  if (await inspectDisplay(run, name)) throw new ExistingDisplayError("A display already uses this subshell name.");
  await run([
    "create",
    "-type=VirtualScreen",
    `-virtualScreenName=${name}`,
    "-useResolutionList=on",
    `-resolutionList=${width}x${height}`,
    "-virtualScreenHiDPI=off",
  ]);
  await run(["set", "-type=VirtualScreen", `-name=${name}`, "-connected=on"]);
  const display = await inspectDisplay(run, name);
  if (!display) throw new Error("BetterDisplay didn't create the subshell display. Check its setup and license.");
  return display;
}

export async function removeDisplay(run: Run, expected: OwnedDisplay): Promise<void> {
  ownedDisplay(expected, expected.name);
  const current = await inspectDisplay(run, expected.name);
  if (!current) return;
  if (current.tagID !== expected.tagID || current.UUID.toLowerCase() !== expected.UUID.toLowerCase()) {
    throw new Error("The display's identity changed. Refusing to delete it.");
  }
  // An unqualified `discard` deletes every virtual display. Never let a blank
  // selector, stale journal, or failed query reach that operation.
  await run(["discard", "-type=VirtualScreen", `-tagID=${current.tagID}`, `-name=${current.name}`]);
  if (await inspectDisplay(run, expected.name))
    throw new Error("BetterDisplay still reports the subshell display after removal.");
}

/** The executable belongs to the already-running BetterDisplay app. Never launch its GUI. */
export function commandRunner(executable: string): Run {
  if (!executable.startsWith("/")) throw new Error("Expected BetterDisplay's absolute executable path.");
  return async (args) => {
    const result = await promisify(execFile)(executable, args, {
      encoding: "utf8",
      timeout: 5000,
      maxBuffer: MAX_OUTPUT,
      killSignal: "SIGKILL",
    });
    return result.stdout;
  };
}
