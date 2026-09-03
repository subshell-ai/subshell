import { BackendErrorCodes } from "@internal/backend-errors";
import { Elysia, t } from "elysia";
import { authGuard, ForbiddenError, requireCookieActor } from "@/api/auth-guard.js";
import { loadNodeGate } from "@/api/nodes/node-gate.js";
import type { CreatedApiKey, NodeKeyMetadata } from "@/auth/apikey-store.js";
import { setApiKeyEnabled } from "@/auth/apikey-store.js";
import { getAuth } from "@/auth.js";
import { db } from "@/db/index.js";
import { NodesRepository } from "@/db/repositories/nodes.repository.js";
import { apiErrorBody } from "@/lib/api-error.js";
import { apiModels } from "@/schema/index.js";
import { audit } from "@/services/audit.js";
import { disconnectNode, getLive, REVOKED_CLOSE_CODE } from "@/services/nodes/node-registry.js";
import { failConnPendings } from "@/services/nodes/node-rpc.js";

/** One-time key reveal + the manual step the operator still owns. */
const RotateResponseSchema = t.Object({
  nodeKey: t.String({ description: "Plaintext node bearer key — shown exactly once here; only its hash is stored" }),
  message: t.String({
    description: "Operator guidance: the agent's stored config does NOT update itself — re-configure it by hand",
  }),
});

/**
 * `POST /api/nodes/:id/rotate-key` — mint a replacement node key (spec §9).
 * Manager-only cookie: owner, or ADMIN for `local`.
 *
 * Write order is the ANTI-FORGERY order (T7 carry): mint new → flip
 * `nodes.apiKeyId` → disable old. There is never a window where the node has
 * no valid key row; if the mint throws, the old key is untouched. The old
 * row is DISABLED, not deleted (history stays). Finally a live socket — still
 * authenticated with the old key — is evicted with 4401, since the agent
 * keeps its stored key and re-dials only after the operator re-configures it
 * (the response message says so; remote re-config is phase 2).
 */
export const rotateNodeKeyRoute = new Elysia()
  .use(authGuard)
  .use(apiModels)
  .post(
    "/:id/rotate-key",
    async ({ params, user, actor, status }) => {
      requireCookieActor(actor, "Node key rotation is restricted to browser sessions");
      const gate = await loadNodeGate(user.id, params.id);
      if (!gate) {
        return status(404, apiErrorBody({ code: BackendErrorCodes.NOT_FOUND_ERROR, message: "Node not found" }));
      }
      if (!gate.canManage) throw new ForbiddenError();

      // 1. Mint FIRST (least-privilege + kind-tagged, exactly like enroll).
      const metadata: NodeKeyMetadata = { kind: "node", nodeId: gate.row.id };
      const created = (await getAuth().api.createApiKey({
        body: {
          name: `node:${gate.row.id}`,
          userId: gate.row.ownerUserId,
          metadata,
          permissions: { nodes: ["read", "write"] },
        },
      })) as unknown as CreatedApiKey;

      // 2. Flip the binding, THEN 3. disable the old key.
      await new NodesRepository(db).setApiKeyId(gate.row.id, created.id);
      if (gate.row.apiKeyId) setApiKeyEnabled(gate.row.apiKeyId, false);

      // 4. The live socket authenticated with the OLD key — evict it after
      //    the DB truth changed (no post-revoke frames get even one beat).
      //    Capture the conn BEFORE disconnecting (the map entry dies with it)
      //    and drain its in-flight commands AFTER (P1-T9 carry: an eviction
      //    must failConnPendings itself — no real socket close may ever fire).
      const evicted = getLive(gate.row.id);
      disconnectNode(gate.row.id, REVOKED_CLOSE_CODE, "node key rotated");
      if (evicted) failConnPendings(evicted, "offline", "node key rotated");

      await audit({
        actorUserId: user.id,
        action: "node.key_rotate",
        targetType: "node",
        targetId: gate.row.id,
        metadataJson: JSON.stringify({ oldApiKeyId: gate.row.apiKeyId ?? null, newApiKeyId: created.id }),
      });
      return {
        nodeKey: created.key,
        message:
          "New key active. Re-configure the agent with it manually (subshell config keeps the old key until you replace it); the live connection was closed.",
      };
    },
    {
      response: {
        200: RotateResponseSchema,
        401: "ApiErrorResponse",
        403: "ApiErrorResponse",
        404: "ApiErrorResponse",
        500: "ApiErrorResponse",
      },
      detail: {
        operationId: "rotateNodeKey",
        tags: ["nodes"],
        description:
          "Rotate a node's bearer key (manager only); the plaintext is returned once and the agent needs manual re-configuration",
      },
    },
  );
