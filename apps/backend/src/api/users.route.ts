import { hashPassword } from "better-auth/crypto";
import { Elysia, t } from "elysia";
import { authGuard, requireAdmin } from "@/api/auth-guard.js";
import { db } from "@/db/index.js";
import { UserMetaRepository } from "@/db/repositories/user-meta.repository.js";
import { UsersRepository } from "@/db/repositories/users.repository.js";
import { audit } from "@/services/audit.js";
import { ensureDefaultProfilesForUser } from "@/services/default-profiles.js";
import { logger } from "@/utils/logger.js";

const UserRowSchema = t.Object({
  id: t.String({ description: "User id" }),
  email: t.String({ description: "User email" }),
  role: t.Union([t.String(), t.Null()], { description: "App role (admin/user) or null when no user_meta row" }),
  createdAt: t.Union([t.String(), t.Null()], { description: "ISO 8601 creation timestamp" }),
});

const CreateUserBodySchema = t.Object({
  email: t.String({ description: "Email address for the new credential account" }),
  password: t.String({ minLength: 8, description: "Initial password (min 8 chars)" }),
  role: t.Union([t.Literal("admin"), t.Literal("user")], {
    default: "user",
    description: "App role for the new user",
  }),
});

const CreateUserResponseSchema = t.Object({
  id: t.String({ description: "New user id" }),
  email: t.String({ description: "New user email" }),
  role: t.String({ description: "Assigned role" }),
  createdAt: t.String({ description: "ISO 8601 creation timestamp" }),
});

/** GET /api/users response: roster + one flag describing the VIEWER. */
const ListUsersResponseSchema = t.Object({
  viewerIsAdmin: t.Boolean({
    description:
      "True only for a cookie-session admin — mirrors the POST gate, so machine credentials never see the admin UI",
  }),
  users: t.Array(UserRowSchema, { description: "All users with roles, newest first" }),
});

// POST stays admin-only via the shared requireAdmin derive (401 anonymous /
// 403 bearer-or-non-admin); GET is instance-wide per the roster spec, so the
// plugins are mounted per-route: authGuard for the whole prefix, then a
// route-bearing sub-instance composed with requireAdmin for POST.
const adminOnly = new Elysia()
  .use(requireAdmin)
  .post(
    "/",
    async ({ body, user }) => {
      const repo = new UsersRepository(db);
      const email = body.email.trim().toLowerCase();
      const passwordHash = await hashPassword(body.password);
      let id: string;
      try {
        id = await repo.createUser({ email, passwordHash, role: body.role });
      } catch (err) {
        if (err instanceof Error && err.message.includes("UNIQUE") && err.message.includes("user.email")) {
          throw new UsersError("conflict", "Email already registered");
        }
        throw err;
      }
      // An admin-minted user bypasses the better-auth registration hook, so
      // seed their Default profiles here too — best-effort like the audit
      // below (a seed failure leaves them without a default until the next
      // boot/harness-enable sweep, but must not 500 an otherwise-good create).
      await ensureDefaultProfilesForUser(db, id).catch((err) => {
        // Logged, not silenced: without a line here a user lands on zero
        // profiles with nothing to trace (the repair only runs at next boot).
        logger.withError(err).warn(`default-profile seeding failed for admin-created user ${id}`);
      });
      // Audit the admin action; best-effort (never breaks the create).
      await audit({
        actorUserId: user.id,
        action: "user.create",
        targetType: "user",
        targetId: id,
        metadataJson: JSON.stringify({ email }),
      });
      return { id, email, role: body.role, createdAt: new Date().toISOString() } as const;
    },
    {
      body: CreateUserBodySchema,
      response: CreateUserResponseSchema,
      detail: {
        operationId: "createUser",
        tags: ["users"],
        description: "Creates a credential user with a role (admin only, cookie session)",
      },
    },
  )
  .as("scoped");

/**
 * Instance-wide read-only roster; management (create, audit) stays
 * admin-cookie-only. GET lists every user with their role for any
 * authenticated viewer (cookie or bearer) and reports whether the VIEWER may
 * manage users; POST goes through requireAdmin, so anonymous requests get a
 * 401 and bearers/non-admins a 403. The created credential accounts can sign
 * in through the normal better-auth flow.
 */
export const usersRoutes = new Elysia({ prefix: "/api/users" })
  .use(authGuard)
  .get(
    "/",
    async ({ user, actor }) => {
      const users = await new UsersRepository(db).listWithRoles();
      // Same semantics as requireAdmin: cookie actor AND user_meta role
      // "admin". Anyone else (member cookie, any bearer) sees the roster
      // read-only.
      const viewerIsAdmin =
        actor === "cookie" && !!user && (await new UserMetaRepository(db).getRole(user.id)) === "admin";
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
  )
  .use(adminOnly);

class UsersError extends Error {
  readonly code: string;
  readonly status = 409;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}
