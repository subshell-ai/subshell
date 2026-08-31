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
}

export type NewUserMeta = UserMetaTable;
