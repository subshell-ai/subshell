import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { type NodeMaintenanceWire, parseNodeMaintenance } from "@internal/subshell-protocol";
import { logger } from "./log.js";

/**
 * This node's MIRROR of the maintenance flag (spec 2026-09-14 §2/§4.1): one
 * word meaning "this machine stays enrolled and answers everything, but takes
 * no new subshells".
 *
 * **It is its own file, not a field in `config.json`**, for two reasons that
 * are both about lifetime. `config.json` is snapshotted at daemon boot, so a
 * value written there would not reach a running daemon until it restarted —
 * and the whole point of the CLI verb is that the person at the keyboard can
 * flip it under a live agent. And `config.json` is the node key's only home:
 * a value the operator flips several times a day does not belong in the file
 * whose every rewrite risks the machine's credential.
 *
 * **Reading is fail-CLOSED, deliberately unlike `allowed-dirs.ts` beside it.**
 * That file treats an unreadable allowlist as unrestricted, because the list
 * is a restriction an owner opts into and a disk hiccup must not brick every
 * launch. Here the direction inverts: a refusal that fails open is not a
 * refusal. If this file cannot be read, the honest answer is that the machine
 * may have been put into maintenance and this process cannot tell — so it
 * refuses, and `subshell maintenance status` says exactly that instead of
 * reporting a tidy "off". The cost of being wrong is one node that launches
 * nothing until someone looks at it; the cost of the other direction is
 * launching onto a machine an operator took down.
 *
 * Absent is the third answer and is NOT fail-closed: a node that has never
 * been told anything behaves exactly as it did before this existed. Absence
 * also travels differently from `{ on: false }` — the plane reconciles on
 * `changedAt`, and a node with no file has no stamp to reconcile with.
 *
 * **An unreadable file is REPORTED, as the state it actually produces.** It
 * refuses every launch, so a node that reported nothing about it was a
 * permanent disagreement rather than a self-repairing one: with no row of its
 * own the plane has nothing to reconcile, so it keeps showing the node as
 * launchable while every create against it 409s, and nothing on either side
 * ever rewrites the file. Reported as `on`, the plane adopts it, the operator
 * sees the node in maintenance, and turning it off in the browser pushes a
 * clean `set_maintenance` — which is what actually repairs this machine. The
 * stamp is the FILE'S OWN mtime: honest (it is when that file last changed)
 * and, unlike `now`, STABLE, so the report memo suppresses the repeat instead
 * of announcing the same broken file on every heartbeat.
 */

/** File name inside the agent data dir. */
const FILE = "maintenance.json";

/** Absolute path of the maintenance mirror for a data dir. */
export function maintenancePath(dataDir: string): string {
  return join(dataDir, FILE);
}

/**
 * What the mirror says, as three answers a caller must tell apart.
 *
 * A bare `boolean` would collapse the two that differ: `absent` is reported to
 * the plane by OMITTING the `ready` field (the plane's own row then wins
 * outright), while `unreadable` is an ON this process cannot attribute to a
 * stamp anyone wrote — so it carries the file's own mtime instead, and is
 * silent only when even that could not be read.
 */
export type MaintenanceRead =
  /** No file has ever been written here: off, and nothing to report. */
  | { kind: "absent" }
  /** The file parsed: this is the machine's half of the flag, verbatim. */
  | { kind: "state"; state: NodeMaintenanceWire }
  /** The file exists but is not a state: ON, reported under the file's mtime. */
  | {
      kind: "unreadable";
      /** The file's mtime, ISO — absent only when the stat failed too, leaving nothing truthful to send. */
      changedAt?: string;
    };

/**
 * Reads the mirror.
 *
 * Total — every failure answers `unreadable` (one warn line) rather than
 * throwing, because every caller is on a path where a throw would cost more
 * than the wrong answer: the launch gate, a heartbeat tick, and the `ready`
 * builder.
 *
 * The parse is the WIRE parser, not a private one: the file holds exactly what
 * travels in either direction, and a second validator here would be a second
 * opinion about what `{ on, changedAt }` means.
 */
export function readMaintenance(dataDir: string): MaintenanceRead {
  const file = maintenancePath(dataDir);
  if (!existsSync(file)) return { kind: "absent" };
  try {
    const state = parseNodeMaintenance(JSON.parse(readFileSync(file, "utf8")));
    if (!state) throw new SyntaxError("not a maintenance state");
    return { kind: "state", state };
  } catch (err) {
    logger.withError(err).warn(`maintenance: ${file} unreadable; treating this node as IN MAINTENANCE`);
    // The mtime, never `now`: this answer refuses launches, so the plane has
    // to hear about it, and the one timestamp available that nobody invented
    // is when the file last changed. A fresh `now` per read would also defeat
    // the report memo and put one frame on the wire per heartbeat, forever.
    // A stat that fails in turn (the file went away between the two calls)
    // leaves the stamp off: the refusal stands, and there is nothing to send.
    const changedAt = mtimeOf(file);
    return changedAt ? { kind: "unreadable", changedAt } : { kind: "unreadable" };
  }
}

/**
 * A file's mtime as an ISO stamp. TOTAL — every caller is on a path where the
 * answer is optional and a throw would cost the whole read.
 */
function mtimeOf(file: string): string | undefined {
  try {
    return statSync(file).mtime.toISOString();
  } catch {
    return undefined;
  }
}

/**
 * The wire value a read is worth announcing, or `undefined` when there is
 * nothing truthful to say.
 *
 * Every reporting path goes through this so the three answers cannot be
 * classified differently in three places: `ready`, the heartbeat memo check
 * and the launch gate all owe the plane the same value for the same file.
 *
 * @param read - what {@link readMaintenance} answered
 * @returns the `{ on, changedAt }` to send, or `undefined` for absent (the
 * plane's own row wins outright) and for an unstamped unreadable
 */
export function reportableMaintenance(read: MaintenanceRead): NodeMaintenanceWire | undefined {
  if (read.kind === "state") return read.state;
  if (read.kind === "unreadable" && read.changedAt) return { on: true, changedAt: read.changedAt };
  return undefined;
}

/**
 * Persists the mirror, 0600, via temp + rename.
 *
 * Atomic for a sharper reason than the allowlist's: a launch may read this at
 * any instant, and a half-written file parses as corrupt — which under the
 * fail-closed rule above refuses every launch for as long as the write takes,
 * rather than merely widening the node for that window.
 *
 * The `state` is stored VERBATIM. When the plane sent it, re-stamping here
 * would make the two copies differ by exactly the delay between them, and the
 * next reconnect would reconcile a disagreement this process invented.
 *
 * @returns the state as stored
 */
export function writeMaintenance(dataDir: string, state: NodeMaintenanceWire): NodeMaintenanceWire {
  const file = maintenancePath(dataDir);
  const body: NodeMaintenanceWire = { on: state.on, changedAt: state.changedAt };
  // 0700, matching the data dir `identity.ts` creates. mkdir's mode is
  // umask-clamped, so it is a floor; the file's own 0600 below is set at
  // creation and is the one that matters.
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(body, null, 2), { mode: 0o600 });
  renameSync(tmp, file);
  return body;
}
