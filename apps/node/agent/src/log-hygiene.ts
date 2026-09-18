import { launchLogPath, type ServiceDeps } from "./service.js";

/**
 * Housekeeping for the log the SERVICE MANAGER writes — not the agent's own
 * capped file (`log-file.ts`), which is created 0600 by the writer itself.
 *
 * **Why this file needs a repair at all.** On macOS the daemon's stdout and
 * stderr are redirected by launchd, from the plist's `StandardOutPath`, and
 * launchd creates that file itself before the agent exists: `open(2)` with the
 * job's umask, which is 022, so the file lands **0644** and nothing the agent
 * writes afterwards changes it. Measured on 2026-09-18: this repo's own two
 * launchd jobs, same plist shape, disagreed — `~/Library/Logs/subshell.log`
 * was 0644 while `~/Library/Logs/subshell-server.log` was 0600, because the
 * server's copy had first been CREATED at 0600 by Subshell Server's supervisor
 * (`apps/server/desktop`'s `open_console_log`) and launchd, which opens the
 * redirect `O_APPEND|O_CREAT`, left the mode of a file that already existed
 * alone. So a mode set once sticks — which is exactly what makes a chmod at
 * daemon start a repair rather than a thing to redo forever.
 *
 * **Why it is worth repairing.** That file holds the same lines the agent's
 * own 0600 log holds — launches, refusals, connection errors, whatever an
 * error carried with it — and the project's rule for everything it writes
 * about a machine is 0600 in a 0700 directory
 * (`.claude/rules/security-context.md`). World-readable was the accident of
 * whoever created the file, not a decision.
 *
 * Shaped after the server's `services/pane-log-hygiene.ts`: a boot-time,
 * idempotent, best-effort repair that must never take the daemon down. What it
 * does NOT do is create the file — an absent log is launchd's to make on the
 * next line, and pre-creating one would be this agent writing into
 * `~/Library/Logs` on a machine that may not even have a service installed.
 */

/** What {@link tightenServiceLogMode} needs; a subset of {@link ServiceDeps}, wired by the CLI. */
export type LogHygieneDeps = Pick<ServiceDeps, "platform" | "home" | "fileExists" | "chmodFile">;

/** Why one pass did or did not change anything. */
export type TightenServiceLogReason =
  /** This platform's manager redirects to no file (systemd: the journal). */
  | "no-file"
  /** There is a path, but nothing has been written there yet. */
  | "absent"
  /** No `chmodFile` seam was wired — a stubbed deps object in a test. */
  | "no-seam"
  /** The chmod ran. */
  | "tightened"
  /** The chmod was refused (another owner, a read-only mount). */
  | "failed";

/** What one pass did. */
export interface TightenServiceLogResult {
  /** The file considered, or `null` where the platform has none. */
  path: string | null;
  /** Whether the mode was actually set. */
  tightened: boolean;
  /** Which of the five cases this was. */
  reason: TightenServiceLogReason;
  /** The refusal, when `reason` is `failed`. */
  error?: unknown;
}

/**
 * Force the service manager's own log file to 0600, where the platform has one.
 *
 * Runs at daemon start, unconditionally and idempotently: launchd re-creates
 * the file at 0644 whenever it is missing, so there is no one-time install
 * step that could hold this. The window it leaves is the one between launchd
 * creating the file for a fresh job and this line running — microseconds on a
 * file that has one line in it — and closing that would mean this agent
 * creating files in `~/Library/Logs` on machines with no service at all.
 *
 * Total by construction: every outcome is a value, and a refused chmod is
 * `failed` rather than a throw. The caller logs it; the daemon starts either
 * way.
 *
 * @param deps - platform, home and the file seams (production: `DEFAULT_DEPS`)
 */
export async function tightenServiceLogMode(deps: LogHygieneDeps): Promise<TightenServiceLogResult> {
  // The path comes from the module that WRITES the plist, so the two cannot
  // describe different files.
  const path = deps.platform === "darwin" ? launchLogPath(deps.home) : null;
  if (path === null) return { path: null, tightened: false, reason: "no-file" };
  if (!(await deps.fileExists(path))) return { path, tightened: false, reason: "absent" };
  if (!deps.chmodFile) return { path, tightened: false, reason: "no-seam" };
  try {
    await deps.chmodFile(path, 0o600);
    return { path, tightened: true, reason: "tightened" };
  } catch (error) {
    return { path, tightened: false, reason: "failed", error };
  }
}
