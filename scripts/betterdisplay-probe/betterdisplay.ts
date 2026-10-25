import { execFileSync } from "node:child_process";

/** This module is an experiment, not a registered VirtualDisplayProvider. */
export interface OwnedDisplay {
  name: string;
  UUID: string;
  tagID: string;
  displayID: string;
  deviceType: "VirtualScreen";
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NAME_PREFIX = "Subshell-Probe-";
const MAX_OUTPUT = 128 * 1024;
export type Run = (args: string[]) => string;

export class ExistingProbeDisplayError extends Error {}

export function probeName(id: string): string {
  if (!UUID_PATTERN.test(id)) throw new Error("Expected a UUID for the probe name.");
  return `${NAME_PREFIX}${id}`;
}

export function validateName(name: string): void {
  if (!name.startsWith(NAME_PREFIX) || !UUID_PATTERN.test(name.slice(NAME_PREFIX.length))) {
    throw new Error("This isn't a display name owned by the probe.");
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
    throw new Error("BetterDisplay didn't identify exactly the virtual display this probe created.");
  }
  return {
    name: expectedName,
    UUID: value.UUID,
    tagID: value.tagID,
    displayID: value.displayID,
    deviceType: "VirtualScreen",
  };
}

export function inspectDisplay(run: Run, name: string): OwnedDisplay | null {
  validateName(name);
  // A name-filtered query exits 1 with only "Failed." for an absent display,
  // indistinguishable from other CLI failures. A successful full inventory
  // proves absence without treating a failed command as an empty list.
  const entries = parseIdentifiers(run(["get", "-identifiers"]));
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
  if (matches.length !== 1) throw new Error("The probe name matches several displays; refusing to choose one.");
  return ownedDisplay(matches[0], name);
}

export function createDisplay(run: Run, name: string): OwnedDisplay {
  validateName(name);
  if (inspectDisplay(run, name)) throw new ExistingProbeDisplayError("A display already uses this probe name.");
  run([
    "create",
    "-type=VirtualScreen",
    `-virtualScreenName=${name}`,
    "-useResolutionList=on",
    "-resolutionList=1280x800",
    "-virtualScreenHiDPI=off",
  ]);
  run(["set", "-type=VirtualScreen", `-name=${name}`, "-connected=on"]);
  const display = inspectDisplay(run, name);
  if (!display) throw new Error("BetterDisplay didn't create the probe display. Check its setup and license.");
  return display;
}

export function removeDisplay(run: Run, expected: OwnedDisplay): void {
  ownedDisplay(expected, expected.name);
  const current = inspectDisplay(run, expected.name);
  if (!current) return;
  if (current.tagID !== expected.tagID || current.UUID.toLowerCase() !== expected.UUID.toLowerCase()) {
    throw new Error("The display's identity changed. Refusing to delete it.");
  }
  // An unqualified `discard` deletes every virtual display. Never let a blank
  // selector, stale journal, or failed query reach that operation.
  run(["discard", "-type=VirtualScreen", `-tagID=${current.tagID}`, `-name=${current.name}`]);
  if (inspectDisplay(run, expected.name))
    throw new Error("BetterDisplay still reports the probe display after removal.");
}

export function commandRunner(executable: string): Run {
  if (!executable.startsWith("/")) throw new Error("Pass the absolute path to BetterDisplay's executable.");
  return (args) =>
    execFileSync(executable, args, {
      encoding: "utf8",
      timeout: 10_000,
      maxBuffer: MAX_OUTPUT,
      stdio: ["ignore", "pipe", "pipe"],
    });
}
