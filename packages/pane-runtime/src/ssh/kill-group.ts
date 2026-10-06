/**
 * Stop a child and everything it spawned, as ONE unit. Every SSH child the
 * runtime starts is spawned detached into its own process group, so the
 * kill addresses `-pid` (the group) and only falls back to the bare pid
 * when the group is already gone or was never ours. Extracted from the
 * retired structured-run child module so the brokered-session supervisor
 * and the child keep sharing ONE implementation (the run family died with
 * the destination product; this helper outlived it by the retirement
 * brief's "extract shared helpers" rule).
 */
export function killGroup(pid: number, signal: "SIGTERM" | "SIGKILL"): void {
  try {
    process.kill(-pid, signal);
    return;
  } catch {
    // ESRCH / EPERM: no group (or not ours) — fall to the single pid.
  }
  try {
    process.kill(pid, signal);
  } catch {
    // already reaped
  }
}
