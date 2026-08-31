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
   * 1 = receive session notifications (per-user master switch); 0 = never push.
   * `Generated` mirrors the column's `NOT NULL DEFAULT 1`: inserts may omit it,
   * reads always yield a number.
   */
  notifyEnabled: Generated<number>;
}

/**
 * Insert shape. `notifyEnabled` is optional so registration (which knows only
 * id + role) stays valid; an omitted value takes the DB default (1 = on).
 */
export type NewUserMeta = Omit<UserMetaTable, "notifyEnabled"> & { notifyEnabled?: number };
