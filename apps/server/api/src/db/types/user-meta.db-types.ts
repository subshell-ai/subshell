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
}

/**
 * Insert shape. `notifyEnabled` and `disabled` are optional so registration
 * (which knows only id + role) stays valid; an omitted value takes the DB
 * default (1 = notifications on, 0 = not disabled).
 */
export type NewUserMeta = Omit<UserMetaTable, "notifyEnabled" | "terminalReplayLines" | "disabled"> & {
  notifyEnabled?: number;
  terminalReplayLines?: number | null;
  disabled?: number;
};
