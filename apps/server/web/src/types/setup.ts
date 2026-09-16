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
 */
export type SetupStep = "network" | "agent" | "launch";

/** One row of `GET`/`PATCH /api/setup/progress`. */
export interface SetupProgress {
  /** The caller's own step, or null when no wizard is in progress */
  step: SetupStep | null;
}
