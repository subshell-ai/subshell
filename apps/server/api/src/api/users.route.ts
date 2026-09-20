import { hashPassword } from "better-auth/crypto";
import { Elysia, t } from "elysia";
import { authGuard, requireAdmin } from "@/api/auth-guard.js";
import { isCookieAdmin } from "@/api/user-utils.js";
import { SYSTEM_USER_EMAIL } from "@/auth/system-user.js";
import { db } from "@/db/index.js";
import { UserMetaRepository } from "@/db/repositories/user-meta.repository.js";
import { UsersRepository } from "@/db/repositories/users.repository.js";
import { DEFAULT_USER_ROLE, USER_ROLES } from "@/db/types/user-role.js";
import { audit } from "@/services/audit.js";
import { checkUserName, USER_NAME_MAX } from "@/services/user-name.js";
import { dropLiveSocketsFor } from "@/ws/live-registry.js";

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
  manageable: t.Boolean({
    description:
      "False for the `system` service account, whose role and password an admin may not change. Server-derived so the UI never renders a control that is guaranteed to be refused, and never has to hardcode the service account's address",
  }),
});

const CreateUserBodySchema = t.Object({
  name: t.String({
    description:
      "Display name for the new account. Control characters are stripped, whitespace collapsed, and the result must be 1-64 characters. Enforced in the handler rather than by schema bounds, which would both accept a run of spaces and echo a rejected value back (see MIN_PASSWORD_LENGTH)",
  }),
  email: t.String({ description: "Email address for the new credential account" }),
  password: t.String({
    description:
      "Initial password, at least 8 characters. Checked in the handler, not by the schema, so a rejection cannot echo it back (see MIN_PASSWORD_LENGTH)",
  }),
  role: t.Union(
    USER_ROLES.map((role) => t.Literal(role)),
    { default: DEFAULT_USER_ROLE, description: "App role for the new user" },
  ),
});

const CreateUserResponseSchema = t.Object({
  id: t.String({ description: "New user id" }),
  email: t.String({ description: "New user email" }),
  name: t.String({ description: "Display name" }),
  role: t.String({ description: "Assigned role" }),
  createdAt: t.String({ description: "ISO 8601 creation timestamp" }),
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
 * Minimum password length, enforced in the HANDLERS rather than as a
 * `minLength` on the schema.
 *
 * Elysia renders a schema failure by putting the offending VALUE in the error
 * message, and `error-handler.plugin.ts` copies that message into the response
 * body — so a `minLength: 8` here would echo a rejected password back in the
 * 400. It reaches only the admin who typed it, so the disclosure is small, but
 * a password in a response body is a password in every proxy log and browser
 * devtools panel between here and them, and this route's whole contract is
 * that it never echoes one.
 *
 * The cost is that the bound is no longer in the OpenAPI schema; the field
 * descriptions state it instead.
 */
const MIN_PASSWORD_LENGTH = 8;

/** Refuses a too-short password WITHOUT naming it. */
function assertPasswordLength(password: string): void {
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new UsersError("bad_request", `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`, 400);
  }
}

/**
 * Cleans the submitted display name and refuses an empty or over-long result
 * WITHOUT naming it.
 *
 * In the handler for the same reason the password bound is: schema
 * `minLength`/`maxLength` would both accept `"   "` and, on a failure, put the
 * offending value in the message `error-handler.plugin.ts` copies into the
 * response body. The name is not the admin's private label — it is rendered
 * to everyone a subshell is shared with and it reaches log lines — so it goes
 * through the same normalizer node names and the instance name do; the rule
 * itself lives in `services/user-name.ts`, which the sign-up hook shares.
 */
function requireName(name: string): string {
  const result = checkUserName(name);
  if (result.ok) return result.name;
  if (result.reason === "too_long") {
    throw new UsersError("bad_request", `Name must be at most ${USER_NAME_MAX} characters.`, 400);
  }
  // Copy unchanged from when this only trimmed: a name made entirely of
  // control characters is still an admin who has not supplied one.
  throw new UsersError("bad_request", "Name is required.", 400);
}

const RoleSchema = t.Union(
  USER_ROLES.map((role) => t.Literal(role)),
  { description: "App role" },
);

const RoleBodySchema = t.Object({ role: RoleSchema });

const RoleResponseSchema = t.Object({
  id: t.String({ description: "User id" }),
  email: t.String({ description: "User email" }),
  // The union, not a bare string: the response says the same thing the body
  // accepts, so the generated client narrows it.
  role: RoleSchema,
});

const PasswordBodySchema = t.Object({
  password: t.String({
    description:
      "New password, at least 8 characters. Never logged, echoed, or audited; the length bound is checked in the handler precisely so a rejection cannot quote it",
  }),
});

const PasswordResponseSchema = t.Object({
  id: t.String({ description: "User id" }),
  email: t.String({ description: "User email" }),
  sessionsRevoked: t.Number({
    description: "How many of that user's sessions were signed out; a reset always evicts every one of them",
  }),
});

const DisabledBodySchema = t.Object({
  disabled: t.Boolean({ description: "True to disable the account, false to re-enable it" }),
});

const DisabledResponseSchema = t.Object({
  id: t.String({ description: "User id" }),
  email: t.String({ description: "User email" }),
  disabled: t.Boolean({ description: "The account's state after the change" }),
  sessionsRevoked: t.Number({
    description:
      "How many of that user's sessions were signed out. A disable always evicts every one of them; re-enabling revokes nothing, so this is 0",
  }),
});

/**
 * Loads a user an admin may act on, or throws.
 *
 * The `system` service user is excluded: it owns the system API keys, has no
 * credential account to reset, and a role change on it means nothing. Letting
 * either endpoint touch it would create state the rest of the app does not
 * expect — a password login on an account that must not have one.
 */
async function requireManageableUser(id: string): Promise<{ id: string; email: string }> {
  const row = await new UsersRepository(db).findByIdBasic(id);
  if (!row) throw new UsersError("not_found", "User not found", 404);
  if (row.email === SYSTEM_USER_EMAIL) {
    // 403, not 400: the body is perfectly valid, the caller simply may not do
    // this to this account.
    throw new UsersError("forbidden", "The system service account cannot be modified.", 403);
  }
  return row;
}

// POST stays admin-only via the shared requireAdmin derive (401 anonymous /
// 403 bearer-or-non-admin); GET is instance-wide per the roster spec, so the
// plugins are mounted per-route: authGuard for the whole prefix, then a
// route-bearing sub-instance composed with requireAdmin for POST.
const adminOnly = new Elysia()
  .use(requireAdmin)
  .post(
    "/",
    async ({ body, user }) => {
      const name = requireName(body.name);
      assertPasswordLength(body.password);
      const repo = new UsersRepository(db);
      const email = body.email.trim().toLowerCase();
      const passwordHash = await hashPassword(body.password);
      let id: string;
      try {
        id = await repo.createUser({ name, email, passwordHash, role: body.role });
      } catch (err) {
        if (err instanceof Error && err.message.includes("UNIQUE") && err.message.includes("user.email")) {
          throw new UsersError("conflict", "Email already registered");
        }
        throw err;
      }
      // Audit the admin action; best-effort (never breaks the create).
      await audit({
        actorUserId: user.id,
        action: "user.create",
        targetType: "user",
        targetId: id,
        metadataJson: JSON.stringify({ email }),
      });
      return { id, email, name, role: body.role, createdAt: new Date().toISOString() } as const;
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
  .patch(
    "/:id/role",
    async ({ params, body, user }) => {
      const target = await requireManageableUser(params.id);
      // An admin may not change their OWN role, even to the role they already
      // hold — so this sits BEFORE the no-op early return below. Unlike the
      // password case there is no self-service path to point at: an admin who
      // removes their own administration by accident cannot undo it, and on a
      // single-admin instance nobody else can either. Another admin has to do
      // it.
      if (target.id === user.id) {
        throw new UsersError(
          "bad_request",
          "You cannot change your own role. Another admin has to do it for you.",
          400,
        );
      }
      const meta = new UserMetaRepository(db);
      const from = (await meta.getRole(target.id)) ?? DEFAULT_USER_ROLE;
      // A no-op write would still land an audit row reading `from === to`,
      // which is noise in the one log an operator reads to reconstruct what
      // actually happened.
      if (from === body.role) return { id: target.id, email: target.email, role: body.role } as const;
      // The guard is inside the repository because the count and the write
      // must be one transaction — see `setRole`. A refusal here means the
      // instance would have been left with no admin at all.
      if (!(await meta.setRole(target.id, body.role))) {
        throw new UsersError(
          "conflict",
          "This is the only admin. Promote someone else before changing this role, or the instance would be left with nobody who can administer it.",
        );
      }
      // A live-feed socket chooses its topics ONCE, at connect, and a demoted
      // admin's would still be the instance-wide one — every subshell on the
      // instance, for as long as that tab stayed open. Nothing else closes it:
      // neither this write nor a session revoke reaches a WebSocket, which
      // authenticates at connect and is never re-checked. Dropping them makes
      // the client reconnect and re-derive what it may subscribe to.
      const droppedSockets = dropLiveSocketsFor(target.id);
      await audit({
        actorUserId: user.id,
        action: "user.role_change",
        targetType: "user",
        targetId: target.id,
        metadataJson: JSON.stringify({ email: target.email, from, to: body.role, droppedSockets }),
      });
      return { id: target.id, email: target.email, role: body.role } as const;
    },
    {
      params: t.Object({ id: t.String({ description: "User id to re-role" }) }),
      body: RoleBodySchema,
      response: RoleResponseSchema,
      detail: {
        operationId: "setUserRole",
        tags: ["users"],
        description:
          "Changes a user's role (admin only, cookie session). Refuses with 409 when it would remove the last admin, and with 400 on self — an admin cannot change their own role, another admin has to",
      },
    },
  )
  .patch(
    "/:id/password",
    async ({ params, body, user }) => {
      const target = await requireManageableUser(params.id);
      // An admin's OWN password goes through Account → better-auth, which
      // demands the current one. Allowing it here would turn an unlocked
      // laptop into a full credential takeover with no knowledge of the
      // existing password — a strictly worse path to the same place.
      if (target.id === user.id) {
        throw new UsersError(
          "bad_request",
          "Change your own password under Account, where the current one is required.",
          400,
        );
      }
      assertPasswordLength(body.password);
      const revoked = await new UsersRepository(db).setPassword(target.id, await hashPassword(body.password));
      if (revoked === null) {
        throw new UsersError("conflict", "That user has no password login to reset.");
      }
      // The password itself is never audited, logged, or echoed — only that a
      // reset happened, by whom, and how many sessions it cut.
      await audit({
        actorUserId: user.id,
        action: "user.password_reset",
        targetType: "user",
        targetId: target.id,
        metadataJson: JSON.stringify({ email: target.email, sessionsRevoked: revoked }),
      });
      return { id: target.id, email: target.email, sessionsRevoked: revoked } as const;
    },
    {
      params: t.Object({ id: t.String({ description: "User id whose password to reset" }) }),
      body: PasswordBodySchema,
      response: PasswordResponseSchema,
      detail: {
        operationId: "resetUserPassword",
        tags: ["users"],
        description:
          "Sets another user's password and signs out all of their sessions (admin only, cookie session). Refuses on self; use Account, which requires the current password",
      },
    },
  )
  .patch(
    "/:id/disabled",
    async ({ params, body, user }) => {
      const target = await requireManageableUser(params.id);
      // Same rule as the self-role refusal, for the same reason: disabling
      // yourself signs you out immediately, and only another admin could
      // reverse it — on a single-admin instance, nobody could.
      if (target.id === user.id) {
        throw new UsersError(
          "bad_request",
          "You cannot disable your own account. Another admin has to do it for you.",
          400,
        );
      }
      // The guard is inside the repository because the count, the flag write
      // and the session revocation must be one transaction — see setDisabled.
      const result = await new UserMetaRepository(db).setDisabled(target.id, body.disabled);
      if (!result.ok) {
        throw new UsersError(
          "conflict",
          "This is the only admin who can still sign in. Promote or re-enable someone else first, or the instance would be left with nobody who can administer it.",
        );
      }
      await audit({
        actorUserId: user.id,
        action: "user.disabled_change",
        targetType: "user",
        targetId: target.id,
        metadataJson: JSON.stringify({ email: target.email, disabled: body.disabled }),
      });
      return {
        id: target.id,
        email: target.email,
        disabled: body.disabled,
        sessionsRevoked: result.sessionsRevoked,
      } as const;
    },
    {
      params: t.Object({ id: t.String({ description: "User id to disable or re-enable" }) }),
      body: DisabledBodySchema,
      response: DisabledResponseSchema,
      detail: {
        operationId: "setUserDisabled",
        tags: ["users"],
        description:
          "Disables or re-enables a user (admin only, cookie session). A disabled account cannot sign in and every credential it holds is refused; disabling signs out all of its sessions. Refuses with 400 on self and with 409 when it would disable the last admin who can still sign in. Re-enabling is never refused",
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
  )
  .use(adminOnly);

class UsersError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status = 409) {
    super(message);
    this.code = code;
    this.status = status;
  }
}
