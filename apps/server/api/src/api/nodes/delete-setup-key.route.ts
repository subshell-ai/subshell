import { Elysia, t } from "elysia";
import { authGuard, HttpError, requireCookieActor } from "@/api/auth-guard.js";
import { isCookieAdmin } from "@/api/user-utils.js";
import { db } from "@/db/index.js";
import { NodeSetupKeysRepository } from "@/db/repositories/node-setup-keys.repository.js";
import { apiModels } from "@/schema/index.js";
import { audit } from "@/services/audit.js";

const OkResponseSchema = t.Object({
  ok: t.Boolean({ description: "Always true on success" }),
});

/**
 * `DELETE /api/nodes/setup-keys/:id` — revokes (deletes) a setup key
 * (spec 2026-08-31 §9). The caller's own row goes through the owner-filtered
 * delete, so deleting another user's row — or an unknown id — affects 0 rows
 * and 404s, and ids cannot be probed. A cookie ADMIN whose own delete
 * affected nothing may delete any row (audit 2026-09 item 4): the admin's
 * instance-wide view (`?all=1`) exists precisely so an outstanding foreign
 * key is a door they can close before its 24 h expiry. A consumed row is
 * still deletable by either caller (housekeeping of spent keys). Cookie-only,
 * like the siblings.
 *
 * The audit reuses the one action name — `setup_key.revoke` — and says which
 * kind it was in metadata: `{ foreign: true, ownerUserId }` on the admin's
 * foreign path, `null` on the creator's, exactly as before. Metadata carries
 * ids, never the key text (the same rule the mint already holds to: the trail
 * is what gets screenshotted into an issue).
 */
export const deleteSetupKeyRoute = new Elysia()
  .use(authGuard)
  .use(apiModels)
  .delete(
    "/setup-keys/:id",
    async ({ params, user, actor }) => {
      requireCookieActor(actor, "Node setup keys are managed from the browser");
      const keys = new NodeSetupKeysRepository(db);
      let deleted = await keys.deleteById(params.id, user.id);
      let metadataJson: string | null = null;
      if (deleted === 0 && (await isCookieAdmin(user, actor))) {
        // The owner-filtered miss is what separates the two paths: a creator
        // deleting their own row never pays the role lookup, and the admin
        // widening opens ONLY after the owner path answered "not mine".
        const foreign = await keys.findById(params.id);
        if (foreign) {
          deleted = await keys.deleteByIdUnscoped(params.id);
          if (deleted > 0) {
            metadataJson = JSON.stringify({ foreign: true, ownerUserId: foreign.ownerUserId });
          }
        }
      }
      if (deleted === 0) throw new HttpError(404, "Key not found");
      await audit({
        actorUserId: user.id,
        action: "setup_key.revoke",
        targetType: "node-setup-key",
        targetId: params.id,
        metadataJson,
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
        description:
          "Revokes a node setup key and deletes its row — the caller's own for any signed-in user, any key for a cookie admin (audited with foreign metadata)",
      },
    },
  );
