import { BackendErrorCodes } from "@internal/backend-errors";
import { Elysia, t } from "elysia";
import { authGuard, ForbiddenError, requireCookieActor } from "@/api/auth-guard.js";
import { loadNodeGate } from "@/api/nodes/node-gate.js";
import { db } from "@/db/index.js";
import { NodeSetupKeysRepository } from "@/db/repositories/node-setup-keys.repository.js";
import { apiErrorBody } from "@/lib/api-error.js";
import { apiModels } from "@/schema/index.js";
import { audit } from "@/services/audit.js";

/**
 * Mint recovery consent. The old credentials stay active until redemption.
 * The RETIRE gate (real owner or any admin, `nodeCanRetire`), same ruling as
 * delete: the mint touches no existing row and disconnects nothing, and an
 * admin who can already delete this machine outright is not being widened by
 * being allowed to replace its credentials instead. Redemption is the real
 * power (it re-homes the node row onto whatever machine presents the new key),
 * so the admin holding this is the same instance-wide credential reach they
 * already hold over key rotation's TARGET even though the rotate ROUTE stays
 * owner-only: delete dominates both, and the security posture does not
 * constrain an admin (`docs/security.md` §11, no separation of duties). `local`
 * is refused by kind.
 */
export const reregisterNodeRoute = new Elysia()
  .use(authGuard)
  .use(apiModels)
  .post(
    "/:id/reregister",
    async ({ params, user, actor, status }) => {
      requireCookieActor(actor, "Node re-registration is restricted to browser sessions");
      const gate = await loadNodeGate(user.id, params.id);
      if (!gate)
        return status(404, apiErrorBody({ code: BackendErrorCodes.NOT_FOUND_ERROR, message: "Node not found" }));
      if (!gate.canRetire) throw new ForbiddenError();
      if (gate.row.kind !== "agent") {
        return status(
          400,
          apiErrorBody({
            code: BackendErrorCodes.BAD_REQUEST,
            message: "The server node cannot re-register as an agent",
          }),
        );
      }
      // The key is minted under the NODE'S owner, not the caller. Recovery
      // preserves ownership (spec 2026-08-31; `reregister-node.ts` redemption
      // asserts `key.ownerUserId === node.ownerUserId`), so a key minted under
      // an ADMIN would be dead on arrival. The admin is the ACTOR (audited below
      // by `user.id`); the node owner is the KEY OWNER, who also sees it in their
      // Setup-keys list.
      const row = await new NodeSetupKeysRepository(db).create(gate.row.ownerUserId, undefined, gate.row.id);
      await audit({
        actorUserId: user.id,
        action: "node.reregister_key",
        targetType: "node",
        targetId: gate.row.id,
        metadataJson: JSON.stringify({ setupKeyId: row.id }),
      });
      return status(201, { id: row.id, key: row.key, expiresAt: row.expiresAt });
    },
    {
      response: {
        201: t.Object({ id: t.String(), key: t.String(), expiresAt: t.String() }),
        400: "ApiErrorResponse",
        401: "ApiErrorResponse",
        403: "ApiErrorResponse",
        404: "ApiErrorResponse",
      },
      detail: {
        operationId: "reregisterNode",
        tags: ["nodes"],
        description: "Mint a single-use setup key that replaces credentials on this existing node when redeemed",
      },
    },
  );
