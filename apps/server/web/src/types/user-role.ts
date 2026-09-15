/**
 * The app's user roles, mirroring `apps/server/api/src/db/types/user-role.ts`.
 *
 * A hand-written mirror like the rest of `src/types/` — the frontend cannot
 * import from the server package, and spelling `"admin" | "user"` inline in
 * components is what the shared definition exists to stop.
 */
export type UserRole = "admin" | "user";

/** Every role, in the order the role picker offers them. */
export const USER_ROLES: readonly UserRole[] = ["admin", "user"];

/** How every role picker spells each role. */
export const USER_ROLE_LABELS: Record<UserRole, string> = { admin: "Admin", user: "User" };

/**
 * The roles as a Base UI Select root wants them.
 *
 * Both role selects — the Add user dialog and the per-row one — pass this as
 * `items`, because Base UI's `Value` renders the RAW value and a root whose
 * labels differ from its values otherwise shows a trigger reading "admin"
 * under a menu reading "Admin" (see `components/ui/select.tsx`). One list, so
 * the two controls on the page cannot spell a role two ways.
 */
export const USER_ROLE_OPTIONS: { value: UserRole; label: string }[] = USER_ROLES.map((value) => ({
  value,
  label: USER_ROLE_LABELS[value],
}));

/**
 * Narrows a stored role to one the pickers can show: `null` for a user with no
 * `user_meta` row, and anything a newer server knows and this build does not,
 * both read as the ordinary member role — which is what the server itself
 * treats an absent row as.
 */
export function asUserRole(role: string | null | undefined): UserRole {
  return role === "admin" ? "admin" : "user";
}
