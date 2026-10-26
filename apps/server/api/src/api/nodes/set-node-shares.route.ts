import { BackendErrorCodes } from "@internal/backend-errors";
import { Elysia } from "elysia";
import { apiErrorBody } from "@/api/api-error.js";
import { nodeManagementGuard } from "@/api/nodes/node-management-guard.js";
import { NodeSharesResponseSchema, SetNodeSharesBodySchema, toNodeShareViews } from "@/api/nodes/node-view.js";
import { apiModels } from "@/api/schemas/index.js";
import { db } from "@/db/index.js";
import { NodeSharesRepository } from "@/db/repositories/node-shares.repository.js";
import { UsersRepository } from "@/db/repositories/users.repository.js";
import { LOCAL_NODE_ID } from "@/db/types/nodes.db-types.js";
import { audit } from "@/modules/audit.js";
import { loadNodeGate } from "@/modules/nodes/gate.js";
import { getRelayBroker } from "@/modules/ssh/relay-broker.js";
import { ForbiddenError } from "@/shared/errors.js";

/**
 * `PUT /api/nodes/:id/shares` `{shares:[{granteeUserId, permission}]}` —
 * replace the whole grant set (same contract as subshell-shares; null grantee
 * is the Everyone grant, unknown grantee → 400). Manager-only: owner,
 * or ADMIN for `local` — where the route accepts any valid list (the UI only
 * ever toggles Everyone/edit, but the API stays the honest superset).
 *
 * Access is resolved from these rows on each request. After replacement,
 * close relay sessions whose users no longer have launch access to both ends.
 */
export const setNodeSharesRoute = new Elysia()
  .use(nodeManagementGuard)
  .use(apiModels)
  .put(
    "/:id/shares",
    async ({ params, body, user, actor, status }) => {
      const gate = await loadNodeGate(user.id, params.id, actor);
      if (!gate) {
        return status(404, apiErrorBody({ code: BackendErrorCodes.NOT_FOUND_ERROR, message: "Node not found" }));
      }
      if (!gate.canManage) throw new ForbiddenError();

      const entries = body.shares.map((s) => ({ granteeUserId: s.granteeUserId ?? null, permission: s.permission }));
      const named = entries.map((e) => e.granteeUserId).filter((x): x is string => x !== null);
      if (named.length > 0) {
        const names = await new UsersRepository(db).displayNamesByIds(named);
        const unknown = named.find((uid) => !names.has(uid));
        if (unknown) {
          return status(
            400,
            apiErrorBody({ code: BackendErrorCodes.BAD_REQUEST, message: "Cannot share with an unknown user" }),
          );
        }
      }
      const rows = await new NodeSharesRepository(db).replaceForNode(gate.row.id, entries, user.id);
      await getRelayBroker().closeUnauthorizedForNode(gate.row.id);
      await audit({
        actorUserId: user.id,
        // Spec §9 names only `node.local_share_changed` (the local-launch
        // switch is exactly this route on `local`); it lists no generic
        // shares action, so other nodes get `node.shares_set` as a documented
        // extension of the spec's audit vocabulary.
        action: gate.row.id === LOCAL_NODE_ID ? "node.local_share_changed" : "node.shares_set",
        targetType: "node",
        targetId: gate.row.id,
        metadataJson: JSON.stringify({ grants: entries.length }),
      });
      return { shares: await toNodeShareViews(rows) };
    },
    {
      body: SetNodeSharesBodySchema,
      response: {
        200: NodeSharesResponseSchema,
        400: "ApiErrorResponse",
        401: "ApiErrorResponse",
        403: "ApiErrorResponse",
        404: "ApiErrorResponse",
      },
      systemPermission: "nodes:share",
      detail: {
        operationId: "setNodeShares",
        tags: ["nodes"],
        description: "Replace a node's sharing grants (manager only: owner, or admin on local)",
      },
    },
  );
