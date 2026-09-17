/**
 * Hand-written mirror of the setup wizard's progress shapes — restated the
 * way `types/network.ts` restates `NetworkState`, since Eden's inferred types
 * are not imported into the SPA (spec 2026-09-16 § 2.5).
 */

/**
 * Where the first-run wizard left off for the caller.
 *
 * A bookmark, not a gate: it names the step to REOPEN on, and nothing a
 * person may do depends on it. `null` (absent) is the state of every account
 * that never started a wizard or finished one, and also the fail-safe
 * reading of anything stored outside this list.
 *
 * There is no `account` member — the wizard's first screen creates the
 * account, so the earliest a bookmark can exist is the screen after it.
 *
 * `tmux` is bookmarked by the browser wizard's Tmux step. The step does not
 * exist inside Subshell Server (the native assistant shows its own tmux
 * screen), and a `"tmux"` bookmark read there opens the Agent step — the same
 * fallback `stepFromBookmark` applies to any step the active list lacks.
 */
export type SetupStep = "network" | "tmux" | "agent" | "launch";

/** One row of `GET`/`PATCH /api/setup/progress`. */
export interface SetupProgress {
  /** The caller's own step, or null when no wizard is in progress */
  step: SetupStep | null;
}
