import { Elysia, t } from "elysia";
import { authGuard } from "@/api/auth-guard.js";
import { isCookieAdmin } from "@/api/user-utils.js";
import { SYSTEM_USER_EMAIL } from "@/auth/system-user.js";
import { db } from "@/db/index.js";
import { UsersRepository } from "@/db/repositories/users.repository.js";

const UserRowSchema = t.Object({
  id: t.String({ description: "User id" }),
  email: t.String({ description: "User email" }),
  name: t.String({ description: "Display name" }),
  role: t.Union([t.String(), t.Null()], { description: "App role (admin/user) or null when no user_meta row" }),
  createdAt: t.Union([t.String(), t.Null()], { description: "ISO 8601 creation timestamp" }),
  disabled: t.Boolean({
    description:
      "True when the account is disabled: it cannot sign in and every credential it holds is refused. A user with no user_meta row is enabled",
  }),
  providers: t.Array(t.String(), {
    description:
      'Auth provider ids this account has sign-in rows for, as a SET in unspecified order ("credential" for a password account, plus provider id slugs — a custom slug may be a google-kind door). Drives which management controls make sense (a password reset needs "credential")',
  }),
  manageable: t.Boolean({
    description:
      "False for the `system` service account, whose role and password an admin may not change. Server-derived so the UI never renders a control that is guaranteed to be refused, and never has to hardcode the service account's address",
  }),
});

/** GET /api/users response: roster + one flag describing the VIEWER. */
const ListUsersResponseSchema = t.Object({
  viewerIsAdmin: t.Boolean({
    description:
      "True only for a cookie-session admin; mirrors the POST gate, so machine credentials never see the admin UI",
  }),
  users: t.Array(UserRowSchema, { description: "All users with roles, newest first" }),
});

/**
 * `GET /api/users` — the instance-wide read-only roster: lists every user with
 * their role for any authenticated viewer (cookie or bearer) and reports
 * whether the VIEWER may manage users. Management itself is the admin-gated
 * sibling routes in this directory; the created credential accounts can sign
 * in through the normal better-auth flow.
 */
export const listUsersRoute = new Elysia().use(authGuard).get(
  "/",
  async ({ user, actor }) => {
    const rows = await new UsersRepository(db).listWithRoles();
    // Same rule `requireManageableUser` enforces, computed once here so the
    // client does not restate it. The two must agree, and the only way to
    // guarantee that is for one of them to be derived from the other's
    // constant.
    const users = rows.map((row) => ({ ...row, manageable: row.email !== SYSTEM_USER_EMAIL }));
    // The shared cookie-admin rule (user-utils) — same semantics as
    // requireAdmin: cookie actor AND user_meta role "admin". Anyone else
    // (member cookie, any bearer) sees the roster read-only.
    const viewerIsAdmin = await isCookieAdmin(user, actor);
    return { viewerIsAdmin, users };
  },
  {
    response: ListUsersResponseSchema,
    detail: {
      operationId: "listUsers",
      tags: ["users"],
      description: "Lists all users with their roles (instance-wide read; viewerIsAdmin marks management rights)",
    },
  },
);
