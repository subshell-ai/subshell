import { BackendErrorCodes } from "@internal/backend-errors";
import { Elysia } from "elysia";
import { apiErrorBody } from "@/api/api-error.js";
import { nodeManagementGuard } from "@/api/nodes/node-management-guard.js";
import { NodeSharesResponseSchema, toNodeShareViews } from "@/api/nodes/node-view.js";
import { apiModels } from "@/api/schemas/index.js";
import { loadNodeGate } from "@/modules/nodes/gate.js";
import { ForbiddenError } from "@/shared/errors.js";

/**
 * `GET /api/nodes/:id/shares` — the current grant set. Manager-only
 * (browser or explicitly enabled system key): the real owner of an agent node, or an ADMIN for the seeded
 * `local` node (T3 ruling). An edit grantee — admins included, on foreign
 * agent nodes — cannot read the grant list: managing who can see a node is
 * the owner's act (subshell-shares parity).
 */
export const getNodeSharesRoute = new Elysia()
  .use(nodeManagementGuard)
  .use(apiModels)
  .get(
    "/:id/shares",
    async ({ params, user, actor, status }) => {
      const gate = await loadNodeGate(user.id, params.id, actor);
      if (!gate) {
        return status(404, apiErrorBody({ code: BackendErrorCodes.NOT_FOUND_ERROR, message: "Node not found" }));
      }
      if (!gate.canManage) throw new ForbiddenError();
      return { shares: await toNodeShareViews(gate.shares) };
    },
    {
      response: {
        200: NodeSharesResponseSchema,
        401: "ApiErrorResponse",
        403: "ApiErrorResponse",
        404: "ApiErrorResponse",
      },
      systemPermission: "nodes:read",
      detail: {
        operationId: "getNodeShares",
        tags: ["nodes"],
        description: "List a node's sharing grants (manager only: owner, or admin on local)",
      },
    },
  );
