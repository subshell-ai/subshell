import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * A private marker naming the restore worker that currently owns the swap.
 *
 * The control-plane restore stops the serving process with a plain SIGTERM,
 * and the native parents that supervise it — `container-supervisor` here, and
 * the Subshell Server app's supervisor thread (`supervisor.rs`) — respawn
 * after five seconds. Without this marker, whether the swap or the respawn
 * wins the instance lock is a timing question. While the file names a LIVE
 * worker still inside its age bound, both parents defer respawning.
 *
 * Nothing may hold the parents off FOREVER, so a hold is active only while it
 * is live AND young. Two independent facts keep a marker from stranding a
 * machine:
 *
 * - **Age (`at`).** A worker SIGKILLed mid-swap (an OOM kill is the realistic
 *   one) can leave its marker behind as an unreaped ZOMBIE — a dead process
 *   still in the pid table that keeps answering `kill -0`. Age bounds the
 *   deferral so the parents respawn once a hold is older than any real apply,
 *   whether or not the marker is ever cleaned up.
 * - **Session sweep.** Each supervisor removes a stale marker when it starts a
 *   fresh supervising session (`clearRestoreHold` / `clear_restore_hold`), so a
 *   boot does not wait out the age bound for a swap that died with a previous
 *   container or app session.
 *
 * A premature respawn is safe: the swap's OWN exclusion is the sqlite
 * `instance-state.lock`, which a live worker holds and a dead one has already
 * released. So respawning too early just makes a new server fail to acquire the
 * lock and exit until the swap is done — noise, never a lost restore — while a
 * hold that never expired would be a server that never comes back.
 *
 * The FILE NAME and its fields are the cross-language contract:
 * `supervisor.rs` reads exactly this name in the config directory it spawns the
 * child in, parses `pid` and `at`, treats a nonzero `kill -0` as not-alive, and
 * ignores a marker older than `RESTORE_HOLD_MAX_MS`.
 */
const HOLD_FILE = "restore-in-progress.json";

/** Longer than any legitimate apply (stop + swap + a 5-minute boot confirm),
 * yet short enough that an abandoned marker self-heals well inside an outage. */
export const RESTORE_HOLD_MAX_MS = 15 * 60_000;

export const restoreHoldPath = (configDir: string) => join(configDir, HOLD_FILE);

/** Claim the hold for THIS process, stamped with the time it began. Callers stop the server only after this returns. */
export function writeRestoreHold(configDir: string): void {
  writeFileSync(restoreHoldPath(configDir), JSON.stringify({ pid: process.pid, kind: "restore", at: Date.now() }), {
    mode: 0o600,
  });
}

export function clearRestoreHold(configDir: string): void {
  rmSync(restoreHoldPath(configDir), { force: true });
}

/** True only when the marker parses, names a live process, and is inside its age bound. */
export function activeRestoreHold(configDir: string): boolean {
  let marker: { pid?: unknown; at?: unknown };
  try {
    marker = JSON.parse(readFileSync(restoreHoldPath(configDir), "utf8")) as { pid?: unknown; at?: unknown };
  } catch {
    return false;
  }
  const { pid, at } = marker;
  if (!Number.isSafeInteger(pid) || (pid as number) <= 0) return false;
  // An unusable `at` (missing from an older marker, or not a sane number) is
  // treated as NOT a hold — fail open to a respawn. The sqlite instance lock is
  // the real exclusion; deferring for a timestamp we cannot trust would trade a
  // harmless early-respawn flap for a possible never-coming-back stall.
  if (typeof at !== "number" || !Number.isFinite(at)) return false;
  if (Date.now() - at > RESTORE_HOLD_MAX_MS) return false;
  // Liveness is EXACTLY "we can signal it" — a successful `kill -0` — the same
  // rule `supervisor.rs` applies (a nonzero exit is not-alive). The worker is
  // always the same OS user as its parent, so a real hold always signals clean;
  // a reused pid now owned by someone else is not the worker we wait for.
  try {
    process.kill(pid as number, 0);
    return true;
  } catch {
    return false;
  }
}
