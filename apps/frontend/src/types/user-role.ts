/**
 * The app's user roles, mirroring `apps/server/src/db/types/user-role.ts`.
 *
 * A hand-written mirror like the rest of `src/types/` — the frontend cannot
 * import from the server package, and spelling `"admin" | "user"` inline in
 * components is what the shared definition exists to stop.
 */
export type UserRole = "admin" | "user";

/** Every role, in the order the role picker offers them. */
export const USER_ROLES: readonly UserRole[] = ["admin", "user"];
