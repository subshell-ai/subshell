import { UsersError } from "@/api/users/users-error.js";
import { SYSTEM_USER_EMAIL } from "@/auth/system-user.js";
import { db } from "@/db/index.js";
import { UsersRepository } from "@/db/repositories/users.repository.js";

/**
 * Loads a user an admin may act on, or throws.
 *
 * The `system` service user is excluded: it owns the system API keys, has no
 * credential account to reset, and a role change on it means nothing. Letting
 * either endpoint touch it would create state the rest of the app does not
 * expect — a password login on an account that must not have one.
 */
export async function requireManageableUser(id: string): Promise<{ id: string; email: string }> {
  const row = await new UsersRepository(db).findByIdBasic(id);
  if (!row) throw new UsersError("not_found", "User not found", 404);
  if (row.email === SYSTEM_USER_EMAIL) {
    // 403, not 400: the body is perfectly valid, the caller simply may not do
    // this to this account.
    throw new UsersError("forbidden", "The system service account cannot be modified.", 403);
  }
  return row;
}
