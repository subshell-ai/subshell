import { BackendErrorCodes } from "@internal/backend-errors";
import { hashPassword } from "better-auth/crypto";
import { Elysia, t } from "elysia";
import { authGuard, requireAdmin } from "@/api/auth-guard.js";
import { isCookieAdmin } from "@/api/user-utils.js";
import { SYSTEM_USER_EMAIL } from "@/auth/system-user.js";
import { db } from "@/db/index.js";
import { AuthProvidersRepository } from "@/db/repositories/auth-providers.repository.js";
import { NodesRepository } from "@/db/repositories/nodes.repository.js";
import { UserMetaRepository } from "@/db/repositories/user-meta.repository.js";
import { UsersRepository } from "@/db/repositories/users.repository.js";
import { DEFAULT_USER_ROLE, USER_ROLES } from "@/db/types/user-role.js";
import { apiErrorBody } from "@/lib/api-error.js";
import { apiModels } from "@/schema/index.js";
import { audit } from "@/services/audit.js";
import { disconnectNode, getHeld, getLive, OWNER_DISABLED_CLOSE_CODE } from "@/services/nodes/node-registry.js";
import { failConnPendings } from "@/services/nodes/node-rpc.js";
import { checkUserName, USER_NAME_MAX } from "@/services/user-name.js";
import { logger } from "@/utils/logger.js";
import { dropLiveSocketsFor } from "@/ws/live-registry.js";
import { dropTerminalSocketsFor } from "@/ws/viewers.js";
import { dropUserTokensFor } from "@/ws/ws-token.js";

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

/** One queue row: a person a door let through who is not a member yet (spec §6). */
const PendingUserSchema = t.Object({
  id: t.String({ description: "User id" }),
  email: t.String({ description: "The email the door's profile carried" }),
  name: t.String({ description: "Display name; empty for a door arrival that carried none" }),
  providerId: t.Nullable(
    t.String({
      description: "The door this arrival came through; null for an account with no sign-in row (should not happen)",
    }),
  ),
  providerName: t.Nullable(
    t.String({
      description:
        "The door's current name, resolved live; null when the provider has since been removed, which the queue renders as a removed-provider label",
    }),
  ),
  arrivedAt: t.Nullable(
    t.String({ description: "ISO 8601 stamp of the last knock while pending; null once the row left pending" }),
  ),
  approvalState: t.Union([t.Literal("pending"), t.Literal("rejected")], {
    description: "Queue state. Approved accounts are members and live in GET /api/users, never here",
  }),
});

/** GET /api/users/pending response. */
const PendingResponseSchema = t.Object({
  pending: t.Array(PendingUserSchema, { description: "Pending and rejected rows, newest arrival first" }),
});

const ApprovalStateSchema = t.Union([t.Literal("approved"), t.Literal("rejected")], {
  description: "The queue decision to record for this person",
});

const ApprovalBodySchema = t.Object({ approvalState: ApprovalStateSchema });

const ApprovalResponseSchema = t.Object({
  id: t.String({ description: "User id" }),
  // The union, not a bare string: the response says what the body accepted.
  approvalState: ApprovalStateSchema,
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
  .use(apiModels)
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
          // Spec §5 keeps this answer GENERIC for every holder, OIDC included:
          // an admin typing an email that exists does not need a provider name
          // back (they already see every email per §3 of the security rules,
          // so the name discloses nothing AND remedies nothing they cannot see
          // in the roster). The named refusal belongs to the public sign-up
          // door alone — `@/auth/held-email-guards`, where the person asking
          // genuinely cannot see who holds their address.
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
      // The drop mirrors the role change above, for the same structural
      // reason — a live feed socket authenticates at connect and is never
      // re-checked, so revoking the session rows leaves an open dashboard tab
      // streaming. The feed socket was only the FIRST socket, though: the
      // live half of the account is three stores, and the disable ends all
      // three, in this order —
      //
      //   1. outstanding ws-tokens (`dropUserTokensFor`). Redemption
      //      consults the store alone, never the account, so a token minted
      //      inside its 30 s life moments ago would re-create exactly the
      //      socket the next two lines end. Dropped FIRST so no redemption
      //      can land between the sweep and itself.
      //   2. open terminal attaches (`dropTerminalSocketsFor`) — the same
      //      never-re-checked rule as the feed, in a registry the feed sweep
      //      never walked. Keyed by the user, so it reaches a pane shared
      //      INTO the account and skips bystanders on the account's own.
      //   3. live feed sockets (`dropLiveSocketsFor`), as before.
      //
      // DISABLE-only: the next connect cannot even mint a ws-token while the
      // flag is set (the mint runs through authGuard, and the attach's own
      // cookie fallback re-asks `accountDisabled`), so nothing can hold a
      // stale socket across a re-enable and that edge drops nothing. Each
      // count lands in the audit row exactly as the demotion's does; the two
      // new ones join `nodesDisconnected` as disable-only keys.
      const tokensRevoked = body.disabled ? dropUserTokensFor(target.id) : 0;
      const terminalSocketsClosed = body.disabled ? dropTerminalSocketsFor(target.id, "account disabled") : 0;
      const droppedSockets = body.disabled ? dropLiveSocketsFor(target.id, "account disabled") : 0;
      // Operator ruling 2026-09-24: disabling an account takes its enrolled
      // nodes offline too, and this is the half that makes it true NOW —
      // `authenticateNodeUpgrade` refuses every later dial-in while the flag
      // stands, so the agents' backoff loop (capped at 60 s per retry) stays
      // outside until an admin re-enables, at which point the very next dial
      // succeeds. This is the deliberate "Honor over infrastructure-
      // preservation" choice: a disabled person's machines stop being
      // reachable by anyone they were shared with, immediately.
      //
      // The drain order is the registry's documented contract: capture each
      // record BEFORE evicting it, fail its in-flight commands AFTER (the
      // rotate/delete routes are the precedent). `local` is skipped by name —
      // it runs no agent and holds no socket, and an accidental close of it
      // would be a lie about what was disconnected. `disconnectNode` itself
      // owns the projection — the row flips offline and the node's running
      // panes are re-announced before this call returns, because the close
      // event that lands later will (correctly) find the entry gone and
      // skip — so the Nodes page and the live feed tell the truth with the
      // response, not at the stale sweep.
      let nodesDisconnected = 0;
      if (body.disabled) {
        // The sweep is AFTER the flag commits, so a throw here must not turn
        // into a 500 on a disable that already succeeded — the response the
        // admin gets must match the durable truth, and the durable truth is
        // the pre-socket gate that refuses every later dial regardless of
        // what this loop managed. What a failed sweep leaves behind is
        // ALREADY-OPEN sockets reaching the next reconnect, so the failure is
        // logged, not swallowed: the log names the count reached, and the
        // next dial-in is refused by `authenticateNodeUpgrade`. The
        // `listByOwner` read is inside the guard for the same reason — a
        // transient there is the same degraded-and-honest case, not a 500.
        try {
          for (const node of await new NodesRepository(db).listByOwner(target.id)) {
            if (node.kind === "local") continue;
            // Drain whatever records exist — the eviction now takes BOTH a
            // held and a live socket for one node, so the captured set is a
            // pair, not a single.
            const conns = [getLive(node.id), getHeld(node.id)?.conn];
            if (await disconnectNode(node.id, OWNER_DISABLED_CLOSE_CODE, "the node's owner account is disabled")) {
              for (const conn of conns) if (conn) failConnPendings(conn, "offline");
              nodesDisconnected++;
            }
          }
        } catch (err) {
          logger
            .withError(err)
            .warn(
              `users: disable of ${target.id} committed, but its node disconnect sweep failed after ${nodesDisconnected} disconnect(s) — later dials are refused by the upgrade-time owner check, live sockets drop with their owners' next reconnect`,
            );
        }
      }
      await audit({
        actorUserId: user.id,
        action: "user.disabled_change",
        targetType: "user",
        targetId: target.id,
        // The user-management family's convention: create/role/reset/disable
        // rows name their subject by email, because every admin already sees
        // every email (`GET /api/users` is the instance-wide read, §3) — the
        // trail hides nothing from its audience that it must answer, and it
        // answers who without a join. The never-values rule belongs to the
        // credential family: key text, tokens, and auth-event values stay
        // out of metadata everywhere. The counts are the act — an operator
        // reconstructs what the disable cut.
        metadataJson: JSON.stringify({
          email: target.email,
          disabled: body.disabled,
          droppedSockets,
          // Disable-only counts, the `nodesDisconnected` rule: the keys exist
          // when the act cut something and are absent on a re-enable, so the
          // shape says which edge ran. `tokensRevoked` first because the
          // sweep order above starts there.
          ...(body.disabled ? { tokensRevoked, terminalSocketsClosed, nodesDisconnected } : {}),
        }),
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
          "Disables or re-enables a user (admin only, cookie session). A disabled account cannot sign in and every credential it holds is refused; disabling signs out all of its sessions, revokes its outstanding attach tokens, closes its live feed and terminal sockets, and disconnects the nodes it owns — they stay offline until re-enabled. Refuses with 400 on self and with 409 when it would disable the last admin who can still sign in. Re-enabling is never refused",
      },
    },
  )
  .get(
    "/pending",
    async () => {
      // The queue list. Provider NAMES resolve live, from a read of the door
      // table, rather than by a JOIN that would vanish the row: a deleted
      // provider must render as "removed provider" (spec §6) — the queue is
      // the record of who knocked at a door this instance used to have.
      const rows = await new UsersRepository(db).listApprovalQueue();
      const names = new Map((await new AuthProvidersRepository(db).listAll()).map((row) => [row.id, row.name]));
      return {
        pending: rows.map((row) => ({
          ...row,
          providerName: row.providerId ? (names.get(row.providerId) ?? null) : null,
        })),
      };
    },
    {
      response: PendingResponseSchema,
      detail: {
        operationId: "listPendingApprovals",
        tags: ["users"],
        description:
          "The approval queue: pending and rejected arrivals, newest first (admin only, cookie session). Members never see it, and it never includes an approved account",
      },
    },
  )
  .patch(
    "/:id/approval",
    async ({ params, body, user, status }) => {
      // 404 / 403 (system) come first, the same way the other management
      // PATCHes ask them.
      const target = await requireManageableUser(params.id);
      // §8, the load-bearing refusal: APPROVAL moves a row OUT of the queue,
      // so writing onto an already-approved target is refused rather than
      // silently rewriting an active member (and `rejected` onto one is
      // barred the same way — disabling is that switch). Approving yourself
      // was never pending, so the same 409 covers the self case. This lives
      // as a RETURNED status, not a throw, because the named code is part of
      // the wire contract the /pending screen branches on.
      const meta = new UserMetaRepository(db);
      const current = await meta.approvalState(params.id);
      if (current === "approved") {
        return status(
          409,
          apiErrorBody({
            code: BackendErrorCodes.APPROVAL_NOOP,
            message:
              "That account is already approved. Approval only answers queue arrivals; to bar a member, disable their account.",
          }),
        );
      }
      // No session or socket work on either edge: a pending person never had
      // a session (§9), and rejection of a never-approved arrival has nothing
      // live to cut. The approve edge is the person's first, minted by their
      // next sign-in.
      await meta.setApproval(params.id, body.approvalState);
      const providerId = await new UsersRepository(db).primaryProviderId(params.id);
      await audit({
        actorUserId: user.id,
        action: body.approvalState === "approved" ? "user.approve" : "user.reject",
        targetType: "user",
        targetId: target.id,
        // The user-management family names its subject by email, and the
        // provider says which door this decision was about (spec §8).
        metadataJson: JSON.stringify({ email: target.email, providerId }),
      });
      return { id: target.id, approvalState: body.approvalState } as const;
    },
    {
      params: t.Object({ id: t.String({ description: "User id in the approval queue" }) }),
      body: ApprovalBodySchema,
      response: {
        200: ApprovalResponseSchema,
        409: "ApiErrorResponse",
      },
      detail: {
        operationId: "setUserApproval",
        tags: ["users"],
        description:
          "Records an approval decision for a queued arrival (admin only, cookie session). Approving makes them a member; rejecting keeps them out of the queue until an admin approves them. Refuses with 409 APPROVAL_NOOP when the target is already approved, so this can only ever move a row out of the queue",
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
