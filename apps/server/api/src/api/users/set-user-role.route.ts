import { Elysia, t } from "elysia";
import { requireAdmin } from "@/api/auth-guard.js";
import { requireManageableUser } from "@/api/users/require-manageable-user.js";
import { UsersError } from "@/api/users/users-error.js";
import { db } from "@/db/index.js";
import { UserMetaRepository } from "@/db/repositories/user-meta.repository.js";
import { DEFAULT_USER_ROLE, USER_ROLES } from "@/db/types/user-role.js";
import { audit } from "@/services/audit.js";
import { dropLiveSocketsFor } from "@/ws/live-registry.js";

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

/**
 * `PATCH /api/users/:id/role` — changes a user's role (admin only, cookie
 * session).
 */
export const setUserRoleRoute = new Elysia().use(requireAdmin).patch(
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
      throw new UsersError("bad_request", "You cannot change your own role. Another admin has to do it for you.", 400);
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
        "Changes a user's role (admin only, cookie session). Refuses with 409 when it would remove the last admin, and with 400 on self: an admin cannot change their own role, another admin has to",
    },
  },
);
