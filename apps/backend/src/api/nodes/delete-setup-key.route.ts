import { Elysia, t } from "elysia";
import { authGuard, HttpError, requireCookieActor } from "@/api/auth-guard.js";
import { db } from "@/db/index.js";
import { NodeSetupKeysRepository } from "@/db/repositories/node-setup-keys.repository.js";
import { apiModels } from "@/schema/index.js";
import { audit } from "@/services/audit.js";

const OkResponseSchema = t.Object({
  ok: t.Boolean({ description: "Always true on success" }),
});

/**
 * `DELETE /api/nodes/setup-keys/:id` — revokes (deletes) the caller's own
 * setup key (spec 2026-08-31 §9). Deleting another user's row — or an unknown
 * id — affects 0 rows and 404s, so ids cannot be probed. A consumed row is
 * still deletable (housekeeping of spent keys). Cookie-only, like the siblings.
 */
export const deleteSetupKeyRoute = new Elysia()
  .use(authGuard)
  .use(apiModels)
  .delete(
    "/setup-keys/:id",
    async ({ params, user, actor }) => {
      requireCookieActor(actor, "Node setup keys are managed from the browser");
      const deleted = await new NodeSetupKeysRepository(db).deleteById(params.id, user.id);
      if (deleted === 0) throw new HttpError(404, "Key not found");
      await audit({
        actorUserId: user.id,
        action: "setup_key.revoke",
        targetType: "node-setup-key",
        targetId: params.id,
        metadataJson: null,
      });
      return { ok: true };
    },
    {
      params: t.Object({ id: t.String({ description: "Setup key id" }) }),
      response: {
        200: OkResponseSchema,
        401: "ApiErrorResponse",
        403: "ApiErrorResponse",
        404: "ApiErrorResponse",
      },
      detail: {
        operationId: "deleteNodeSetupKey",
        tags: ["nodes"],
        description: "Revokes one of the caller's node setup keys and deletes its row",
      },
    },
  );
