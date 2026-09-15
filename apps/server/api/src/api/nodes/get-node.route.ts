import { BackendErrorCodes } from "@internal/backend-errors";
import { Elysia } from "elysia";
import { authGuard, requireCookieActor } from "@/api/auth-guard.js";
import { loadNodeGate } from "@/api/nodes/node-gate.js";
import { GetNodeResponseSchema, toNodeShareViews, toNodeView } from "@/api/nodes/node-view.js";
import { db } from "@/db/index.js";
import { NodesRepository } from "@/db/repositories/nodes.repository.js";
import { apiErrorBody } from "@/lib/api-error.js";
import { nodeCanConfigure } from "@/lib/node-access.js";
import { apiModels } from "@/schema/index.js";
import { detectOnNodeBestEffort } from "@/services/nodes/inventory.js";
import { getLive } from "@/services/nodes/node-registry.js";

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
      // Detection on demand (spec 2026-09-10 §4): opening the node's page IS
      // the request to re-probe it. Fire-and-forget — this response renders the
      // cached last-known inventory, and the page's next refetch sees the
      // fresh rows. `local` probes live on every read, so it is not asked.
      if (gate.row.kind !== "local") detectOnNodeBestEffort(gate.row.id);
      const view = await toNodeView(gate.row, gate.access, gate.isAdmin, gate.granted);
      if (!nodeCanConfigure(gate.access)) return view;
      // How the agent process runs (spec 2026-09-12 § 6.2), on the same gate
      // as `shares` and for the same reason: a `view` grantee may LAUNCH here,
      // which needs none of the paths this block names. It rides the live
      // CONNECTION, so an offline node simply has none — the facts would be
      // stale by definition. `local` reports nothing: the control-plane host's
      // own deployment is the Service page's subject, not a node's.
      const runtime = gate.row.kind === "agent" ? getLive(gate.row.id)?.agent?.runtime : undefined;
      // What entering maintenance would cost, on a NARROWER gate than the two
      // fields above (spec 2026-09-14 §5.5): `canManage`, not
      // `nodeCanConfigure`. Only a manager can flip that switch, so only a
      // manager needs its price — and the number itself is a fact about other
      // people's work on this machine, which an `edit` grantee has no call to
      // learn from a node they do not own.
      const runningSubshells = gate.canManage
        ? await new NodesRepository(db).countRunningSubshells(gate.row.id)
        : undefined;
      return {
        ...view,
        shares: await toNodeShareViews(gate.shares),
        ...(runtime ? { runtime } : {}),
        ...(runningSubshells === undefined ? {} : { runningSubshells }),
      };
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
