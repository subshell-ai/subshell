import type { Generated } from "kysely";

/**
 * Database table schema for extra app fields on better-auth users.
 *
 * Separate from better-auth's `user` table so auth internals stay untouched
 * and we remain multi-user ready. The first user to register becomes admin.
 */
export interface UserMetaTable {
  /** better-auth user id */
  userId: string;
  /** Role: "admin" or "user" */
  role: string;
  /**
   * 1 = receive subshell notifications (per-user master switch); 0 = never push.
   * `Generated` mirrors the column's `NOT NULL DEFAULT 1`: inserts may omit it,
   * reads always yield a number.
   */
  notifyEnabled: Generated<number>;
  /**
   * Per-user terminal attach history cap (trailing lines replayed before the
   * live tail). NULL = no preference → instance default
   * (`SUBSHELL_TERMINAL_REPLAY_LINES`, 100); readers clamp to [1, 200].
   * Spec 2026-09-03 close-vocabulary design.
   */
  terminalReplayLines: Generated<number | null>;
  /**
   * 1 = the account is DISABLED: better-auth refuses to mint a session for it
   * and `authGuard` rejects its bearer keys, so it cannot authenticate at all.
   * `Generated` mirrors the column's `NOT NULL DEFAULT 0`, and an absent
   * `user_meta` row reads the same way — enabled. Inverting that would lock
   * every pre-existing account out on upgrade.
   */
  disabled: Generated<number>;
  /**
   * Where the first-run wizard left off for this user, or NULL for "no wizard
   * in progress" — which is every account but the first one, and every account
   * that finished. Typed as a plain string rather than {@link SetupStep}
   * because a row can hold anything a hand edit put there; readers narrow it
   * with `asSetupStep`, which answers null for the rest.
   *
   * Written by `promoteFirstUserAtomically` (`'network'` for the first user)
   * and by `PATCH /api/setup/progress` as the wizard moves. Spec 2026-09-16.
   */
  setupStep: Generated<string | null>;
}

/**
 * Insert shape. `notifyEnabled`, `disabled` and `setupStep` are optional so
 * registration (which knows only id + role) stays valid; an omitted value
 * takes the DB default (1 = notifications on, 0 = not disabled, NULL = no
 * wizard in progress).
 */
export type NewUserMeta = Omit<UserMetaTable, "notifyEnabled" | "terminalReplayLines" | "disabled" | "setupStep"> & {
  notifyEnabled?: number;
  terminalReplayLines?: number | null;
  disabled?: number;
};
