import { BackendErrorCodes } from "@internal/backend-errors";
import { Elysia } from "elysia";
import { authGuard, ForbiddenError, requireCookieActor } from "@/api/auth-guard.js";
import { loadNodeGate } from "@/api/nodes/node-gate.js";
import { NodeSharesResponseSchema, SetNodeSharesBodySchema, toNodeShareViews } from "@/api/nodes/node-view.js";
import { db } from "@/db/index.js";
import { NodeSharesRepository } from "@/db/repositories/node-shares.repository.js";
import { UsersRepository } from "@/db/repositories/users.repository.js";
import { apiErrorBody } from "@/lib/api-error.js";
import { apiModels } from "@/schema/index.js";
import { audit } from "@/services/audit.js";

/**
 * `PUT /api/nodes/:id/shares` `{shares:[{granteeUserId, permission}]}` —
 * replace the whole grant set (same contract as session-shares; null grantee
 * is the Everyone grant, unknown grantee → 400). Manager-only cookie: owner,
 * or ADMIN for `local` — where the route accepts any valid list (the UI only
 * ever toggles Everyone/edit, but the API stays the honest superset).
 *
 * Revoking a grant takes effect on the next request (access is resolved from
 * these rows per request); no key is invalidated, so no socket teardown is
 * needed here.
 */
export const setNodeSharesRoute = new Elysia()
  .use(authGuard)
  .use(apiModels)
  .put(
    "/:id/shares",
    async ({ params, body, user, actor, status }) => {
      requireCookieActor(actor, "Node sharing is restricted to browser sessions");
      const gate = await loadNodeGate(user.id, params.id);
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
      await audit({
        actorUserId: user.id,
        action: "node.shares_set",
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
      detail: {
        operationId: "setNodeShares",
        tags: ["nodes"],
        description: "Replace a node's sharing grants (manager only — owner, or admin on local)",
      },
    },
  );
