import { BackendErrorCodes } from "@internal/backend-errors";
import { Elysia, t } from "elysia";
import { requireAdmin } from "@/api/auth-guard.js";
import { requireManageableUser } from "@/api/users/require-manageable-user.js";
import { db } from "@/db/index.js";
import { UserMetaRepository } from "@/db/repositories/user-meta.repository.js";
import { UsersRepository } from "@/db/repositories/users.repository.js";
import { apiErrorBody } from "@/lib/api-error.js";
import { apiModels } from "@/schema/index.js";
import { audit } from "@/services/audit.js";

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
 * `PATCH /api/users/:id/approval` — records an approval decision for a queued
 * arrival (admin only, cookie session).
 */
export const setUserApprovalRoute = new Elysia()
  .use(requireAdmin)
  .use(apiModels)
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
      // the wire contract the /pending screen branches on. The already-
      // approved CHECK and the write are ONE transaction (final review,
      // minor, the setRole precedent): two concurrent approves could
      // otherwise both pass a separate gate and double-audit `user.approve`.
      const meta = new UserMetaRepository(db);
      if (!(await meta.setApprovalUnlessApproved(params.id, body.approvalState))) {
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
  );
