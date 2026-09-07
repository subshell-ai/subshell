/**
 * The app's user roles — one definition, plus the runtime list.
 *
 * Was spelled inline as `"admin" | "user"` in five places (two Elysia
 * schemas, two repository signatures and a React prop), which is exactly the
 * drift the Type Discriminants rule exists to prevent: a sixth role would have
 * had to be found in all of them.
 */
export type UserRole = "admin" | "user";

/** Every role, for iteration and validation. */
export const USER_ROLES: readonly UserRole[] = ["admin", "user"];

/** The role a user has when no `user_meta` row names one. */
export const DEFAULT_USER_ROLE: UserRole = "user";
