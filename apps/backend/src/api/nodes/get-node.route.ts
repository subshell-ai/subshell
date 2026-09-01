import { BackendErrorCodes } from "@internal/backend-errors";
import { Elysia } from "elysia";
import { authGuard, requireCookieActor } from "@/api/auth-guard.js";
import { loadNodeGate } from "@/api/nodes/node-gate.js";
import { GetNodeResponseSchema, toNodeShareViews, toNodeView } from "@/api/nodes/node-view.js";
import { apiErrorBody } from "@/lib/api-error.js";
import { nodeCanConfigure } from "@/lib/node-access.js";
import { apiModels } from "@/schema/index.js";

/**
 * `GET /api/nodes/:id` — one node view for the caller. Missing and invisible
 * are the same 404 (no id probing). `shares` is included only when the
 * viewer can configure the node (owner/edit grant or admin on `local`);
 * otherwise the key is ABSENT, not null — a view grantee learns nothing
 * about the grant set.
 *
 * COOKIE-ONLY for phase 1 (see the list route's note).
 */
export const getNodeRoute = new Elysia()
  .use(authGuard)
  .use(apiModels)
  .get(
    "/:id",
    async ({ params, user, actor, status }) => {
      requireCookieActor(
        actor,
        "Node reads are restricted to browser sessions (bearer read deferred until a machine consumer exists)",
      );
      const gate = await loadNodeGate(user.id, params.id);
      if (!gate) {
        return status(404, apiErrorBody({ code: BackendErrorCodes.NOT_FOUND_ERROR, message: "Node not found" }));
      }
      const view = await toNodeView(gate.row, gate.access);
      if (!nodeCanConfigure(gate.access)) return view;
      return { ...view, shares: await toNodeShareViews(gate.shares) };
    },
    {
      response: {
        200: GetNodeResponseSchema,
        401: "ApiErrorResponse",
        403: "ApiErrorResponse",
        404: "ApiErrorResponse",
      },
      detail: {
        operationId: "getNode",
        tags: ["nodes"],
        description: "Get one node; includes the grant set only for config-capable viewers",
      },
    },
  );
