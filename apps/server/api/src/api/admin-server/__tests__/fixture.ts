import { hashPassword } from "better-auth/crypto";
import { db } from "@/db/index.js";
import { SubshellsRepository } from "@/db/repositories/subshells.repository.js";
import { UsersRepository } from "@/db/repositories/users.repository.js";
import { issueSubshellToken } from "@/services/subshell-tokens.js";
import { deleteUserByEmailOrId, setupAuthTables, signIn } from "../../__tests__/helpers/auth-tables.js";

/**
 * The three credentials every `/api/admin/server` route has to be tested
 * against, created once per suite.
 *
 * Shared because all four routes in this directory carry the SAME gate —
 * cookie session, admin role, bearer refused — and four copies of the fixture
 * is four places for one of them to quietly stop testing the actor clause. The
 * subshell key is deliberately owned by the ADMIN: `authGuard` maps a bearer
 * token's `user` to the subshell's owner, so an admin-owned key is the one
 * that would slip through a gate checking only the role.
 */
export interface AdminServerFixture {
  /** Session cookie for an admin user. */
  adminCookie: string;
  /** Session cookie for an ordinary user. */
  userCookie: string;
  /** A subshell bearer key whose owner is the admin. */
  bearer: string;
  /** Drops every row the fixture created. */
  cleanup: () => Promise<void>;
}

/** Create the admin, the ordinary user and the admin-owned subshell key. */
export async function setupAdminServerFixture(prefix: string): Promise<AdminServerFixture> {
  await setupAuthTables();
  const users = new UsersRepository(db);
  const adminEmail = `${prefix}-admin-${crypto.randomUUID()}@subshell.local`;
  const userEmail = `${prefix}-user-${crypto.randomUUID()}@subshell.local`;
  const adminId = await users.createUser({
    email: adminEmail,
    passwordHash: await hashPassword("srv-admin-pass-1"),
    role: "admin",
  });
  const userId = await users.createUser({
    email: userEmail,
    passwordHash: await hashPassword("srv-user-pass-1"),
    role: "user",
  });
  const adminCookie = await signIn(adminEmail, "srv-admin-pass-1");
  const userCookie = await signIn(userEmail, "srv-user-pass-1");
  const subshellId = crypto.randomUUID();
  await new SubshellsRepository(db).create({
    id: subshellId,
    userId: adminId,
    profileId: "p",
    harnessId: "claude-code",
    name: `${prefix}-fixture`,
    workingDir: "/tmp",
    tmuxSocket: null,
  });
  const bearer = await issueSubshellToken(subshellId, adminId);
  return {
    adminCookie,
    userCookie,
    bearer,
    cleanup: async () => {
      // The test database is shared by every suite in one `bun test` process,
      // and there are no foreign keys from the app tables to better-auth's —
      // so deleting the users cascades nothing and each row has to go by hand.
      await new SubshellsRepository(db).delete(subshellId);
      await deleteUserByEmailOrId(adminId);
      await deleteUserByEmailOrId(userId);
    },
  };
}

/** A request carrying a bearer key instead of a session cookie. */
export function bearerRequest(path: string, key: string, init?: RequestInit): Request {
  const headers = new Headers(init?.headers);
  headers.set("authorization", `Bearer ${key}`);
  if (init?.body && !headers.has("content-type")) headers.set("content-type", "application/json");
  return new Request(`http://localhost:3080${path}`, { ...init, headers });
}
