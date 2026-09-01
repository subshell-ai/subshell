import { BackendErrorCodes } from "@internal/backend-errors";
import { Elysia } from "elysia";
import { authGuard, ForbiddenError, requireCookieActor } from "@/api/auth-guard.js";
import { loadNodeGate } from "@/api/nodes/node-gate.js";
import { NodeSharesResponseSchema, toNodeShareViews } from "@/api/nodes/node-view.js";
import { apiErrorBody } from "@/lib/api-error.js";
import { apiModels } from "@/schema/index.js";

/**
 * `GET /api/nodes/:id/shares` — the current grant set. Manager-only
 * (cookie): the real owner of an agent node, or an ADMIN for the seeded
 * `local` node (T3 ruling). An edit grantee — admins included, on foreign
 * agent nodes — cannot read the grant list: managing who can see a node is
 * the owner's act (session-shares parity).
 */
export const getNodeSharesRoute = new Elysia()
  .use(authGuard)
  .use(apiModels)
  .get(
    "/:id/shares",
    async ({ params, user, actor, status }) => {
      requireCookieActor(actor, "Node sharing is restricted to browser sessions");
      const gate = await loadNodeGate(user.id, params.id);
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
      detail: {
        operationId: "getNodeShares",
        tags: ["nodes"],
        description: "List a node's sharing grants (manager only — owner, or admin on local)",
      },
    },
  );
