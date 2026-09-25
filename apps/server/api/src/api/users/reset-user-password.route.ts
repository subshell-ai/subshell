import { hashPassword } from "better-auth/crypto";
import { Elysia, t } from "elysia";
import { requireAdmin } from "@/api/auth-guard.js";
import { assertPasswordLength } from "@/api/users/assert-password-length.js";
import { requireManageableUser } from "@/api/users/require-manageable-user.js";
import { UsersError } from "@/api/users/users-error.js";
import { db } from "@/db/index.js";
import { UsersRepository } from "@/db/repositories/users.repository.js";
import { audit } from "@/services/audit.js";

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

/**
 * `PATCH /api/users/:id/password` — sets another user's password and signs out
 * all of their sessions (admin only, cookie session).
 */
export const resetUserPasswordRoute = new Elysia().use(requireAdmin).patch(
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
);
