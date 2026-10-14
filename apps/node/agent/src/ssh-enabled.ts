import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { type NodeSshEnabledWire, parseNodeSshEnabled } from "@internal/subshell-protocol";
import { logger } from "./log.js";

/**
 * This node's MIRROR of the SSH capability flag (spec 2026-10-07 §4.3): one
 * word meaning "this machine may take part in Subshell SSH at all".
 *
 * It is the maintenance flag's twin in mechanics and its inversion in default.
 * Same file-permission doctrine (0600, temp+rename, its own file beside
 * `maintenance.json` and for the same two reasons — `config.json` is
 * snapshotted at boot and it is the node key's only home). Same fail-CLOSED
 * read: here the risk is what ENABLING lets Subshell do (egress over SSH, this
 * machine's keys and agent), so a setting this process cannot read is not a
 * permission. Absent refuses too — that is the inversion: maintenance's
 * absent meant "behave as before" and launches flowed; SSH has no before.
 *
 * **The plane is the sole writer.** There is no `subshell ssh-enabled` verb,
 * because turning a machine's egress on from a keyboard at that machine is
 * exactly the decision this gate exists to make someone make in a browser, as
 * the owner, with an audit row. So the mirror has only two authors — a
 * `set_ssh_enabled` push and a repair — and its only reader is the SSH gate
 * (this process, fail-closed) and the `ready` report that lets the plane
 * notice when the two copies disagree.
 *
 * Because no one stamps this file locally, nothing compares stamps across the
 * two ends: reconciliation never runs newer-wins here, the plane pushes its
 * row, and the node's copy converges by obeying rather than by bargaining.
 */

/** File name inside the agent data dir. */
const FILE = "ssh-enabled.json";

/** Absolute path of the SSH-capability mirror for a data dir. */
export function sshEnabledPath(dataDir: string): string {
  return join(dataDir, FILE);
}

/**
 * What the mirror says, as the three answers a caller must tell apart — the
 * gate's answers, not the file's biography.
 *
 * `on` is the only kind that permits, and it carries the stamp because
 * `ready.sshEnabled` must be buildable from what was written. A file that
 * parses to `{ on: false, changedAt }` and a file that does not exist give the
 * SAME answer to every reader (refuse; and the plane's row already says off,
 * so there is nothing to report), and no node-side writer exists whose stamp
 * anyone would later reconcile — so the off file reads as `absent` while its
 * bytes stay on disk. `unreadable` refuses too, but unlike the other two it
 * says so: the answer it produces may match a quiet row, and when the row says
 * on it is a disagreement the plane can only repair if it hears about it.
 */
export type SshEnabledRead =
  /** Nothing permits here: no file, or a file that says off. */
  | { kind: "absent" }
  /** The mirror parsed and says yes: SSH may run here. */
  | {
      kind: "on";
      /** The stored stamp, verbatim — `ready.sshEnabled` is built from it. */
      changedAt: string;
    }
  /** The file exists but is not a state: REFUSED (fail-closed), reported under the file's mtime. */
  | {
      kind: "unreadable";
      /** The file's mtime, ISO — absent only when the stat failed too, leaving nothing truthful to send. */
      changedAt?: string;
    };

/**
 * The gate's own answer, spelled once: ONLY a parsed `on` permits.
 *
 * Exported so the classifier the spec names ("absent and unreadable refuse,
 * only on:true allows") lives in one place for every reader — the SSH launch
 * path and any later status verb — rather than as `kind === "on"` typed out at
 * each call site and drifting into an `|| absent` someday.
 */
export function sshAllowed(read: SshEnabledRead): boolean {
  return read.kind === "on";
}

/**
 * Reads the mirror.
 *
 * Total — every failure answers `unreadable` (one warn line) rather than
 * throwing, because every caller is on a path where a throw would cost more
 * than the wrong answer: the SSH gate, a heartbeat tick, and the `ready`
 * builder.
 *
 * The parse is the WIRE parser, not a private one: the file holds exactly what
 * travels, and a second validator here would be a second opinion about what
 * `{ on, changedAt }` means.
 */
export function readSshEnabled(dataDir: string): SshEnabledRead {
  const file = sshEnabledPath(dataDir);
  if (!existsSync(file)) return { kind: "absent" };
  try {
    const state = parseNodeSshEnabled(JSON.parse(readFileSync(file, "utf8")));
    if (!state) throw new SyntaxError("not an ssh-enabled state");
    return state.on ? { kind: "on", changedAt: state.changedAt } : { kind: "absent" };
  } catch (err) {
    logger.withError(err).warn(`ssh-enabled: ${file} unreadable; treating this node as SSH-DISABLED`);
    // The mtime, never `now`: this answer refuses, so the plane has to hear
    // about it (a row that says on would push the clean file that repairs it),
    // and the one timestamp available that nobody invented is when the file
    // last changed. A fresh `now` per read would defeat the report memo and
    // put one frame on the wire per heartbeat, forever. A stat that fails in
    // turn leaves the stamp off: the refusal stands, and there is nothing to
    // send.
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
 * Every reporting path goes through this so the answers cannot be classified
 * differently in three places: `ready`, the heartbeat memo check and (from
 * Plan 2) the SSH gate all owe the plane the same value for the same file. An
 * unreadable mirror announces the REFUSAL it actually produces — the inverse
 * of maintenance's unreadable, which announces the `on` IT produces.
 *
 * @param read - what {@link readSshEnabled} answered
 * @returns the `{ on, changedAt }` to send, or `undefined` for absent (the
 * plane's row needs no echo from a node agreeing off) and for an unstamped
 * unreadable
 */
export function reportableSshEnabled(read: SshEnabledRead): NodeSshEnabledWire | undefined {
  if (read.kind === "on") return { on: true, changedAt: read.changedAt };
  if (read.kind === "unreadable" && read.changedAt) return { on: false, changedAt: read.changedAt };
  return undefined;
}

/**
 * Persists the mirror, 0600, via temp + rename.
 *
 * Atomic for the maintenance reason and sharper: a gate may read this at any
 * instant, and a half-written file parses as corrupt — which under the
 * fail-closed rule REFUSES every SSH act for as long as the write takes,
 * mid-connect rather than merely wide of a flag.
 *
 * The `state` is stored VERBATIM. The plane sent it; re-stamping here would
 * make the two copies differ by exactly the link delay, and the next `ready`
 * would report a disagreement this process invented — which the plane would
 * "repair" by pushing the same value again, forever.
 *
 * @returns the state as stored
 */
export function writeSshEnabled(dataDir: string, state: NodeSshEnabledWire): NodeSshEnabledWire {
  const file = sshEnabledPath(dataDir);
  const body: NodeSshEnabledWire = { on: state.on, changedAt: state.changedAt };
  // 0700, matching the data dir `identity.ts` creates. mkdir's mode is
  // umask-clamped, so it is a floor; the file's own 0600 below is set at
  // creation and is the one that matters.
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(body, null, 2), { mode: 0o600 });
  renameSync(tmp, file);
  return body;
}
