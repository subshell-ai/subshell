import { BackendErrorCodes } from "@internal/backend-errors";
import { Elysia, t } from "elysia";
import { authGuard, ForbiddenError, requireCookieActor } from "@/api/auth-guard.js";
import { loadNodeGate } from "@/api/nodes/node-gate.js";
import { MaintenanceResponseSchema, toNodeView } from "@/api/nodes/node-view.js";
import { db } from "@/db/index.js";
import { NodesRepository } from "@/db/repositories/nodes.repository.js";
import { apiErrorBody } from "@/lib/api-error.js";
import { apiModels } from "@/schema/index.js";
import { setNodeMaintenance } from "@/services/nodes/maintenance.js";

const MaintenanceBodySchema = t.Object({
  on: t.Boolean({
    description:
      "True takes the node out of service: it stops every subshell running there and accepts no new ones until this is turned off. False returns it to service and starts nothing back up",
  }),
});

/**
 * `PUT /api/nodes/:id/maintenance` `{on}` — take one machine out of service,
 * or put it back (spec 2026-09-14 §5.4). Cookie-only.
 *
 * **OWNER-only** (`gate.canManage`, with the seeded-`local` admin exception),
 * deliberately NOT the `nodeCanConfigure` gate the service verbs use. The act
 * is what decides it: turning maintenance on stops every subshell running on
 * that machine, including ones belonging to people the node's owner cannot
 * see — any node share lets a grantee launch there, and what they launch stays
 * private to them. An `edit` grantee may restart the agent or read its log;
 * ending everyone else's work on a machine they do not own is a different act,
 * and it sits on the same gate as delete and re-share for the same reason.
 *
 * The four steps (write the flag, stop what is running, tell the machine,
 * record it) all live in `setNodeMaintenance`, because the node's own CLI
 * reaches them too — a second implementation here would be the one that drifts.
 *
 * It answers on an OFFLINE node rather than refusing: the flag is the plane's
 * record, each row retires with its kill unverified, and the machine learns
 * the value at its next `ready`. Refusing would make the one state an operator
 * most wants to set — "this machine is down, stop sending work there" —
 * settable only while the machine is up.
 */
export const setNodeMaintenanceRoute = new Elysia()
  .use(authGuard)
  .use(apiModels)
  .put(
    "/:id/maintenance",
    async ({ params, body, user, actor, status }) => {
      requireCookieActor(actor, "Node maintenance is restricted to browser sessions");
      const gate = await loadNodeGate(user.id, params.id);
      if (!gate) {
        return status(404, apiErrorBody({ code: BackendErrorCodes.NOT_FOUND_ERROR, message: "Node not found" }));
      }
      if (!gate.canManage) throw new ForbiddenError();

      const { stopped, failed } = await setNodeMaintenance({
        nodeId: gate.row.id,
        on: body.on,
        changedAt: new Date().toISOString(),
        source: "plane",
        actorUserId: user.id,
      });
      // Re-read rather than patching the gate's snapshot: `setNodeMaintenance`
      // wrote the row, and the view must render what is stored — including the
      // stamp it chose — rather than what this handler believes it asked for.
      const row = (await new NodesRepository(db).findById(gate.row.id)) ?? gate.row;
      const view = await toNodeView(row, gate.access, gate.isAdmin, gate.granted);
      return { ...view, stopped, ...(failed.length > 0 ? { failed } : {}) };
    },
    {
      params: t.Object({ id: t.String({ description: "Node id" }) }),
      body: MaintenanceBodySchema,
      response: {
        200: MaintenanceResponseSchema,
        400: "ApiErrorResponse",
        401: "ApiErrorResponse",
        403: "ApiErrorResponse",
        404: "ApiErrorResponse",
      },
      detail: {
        operationId: "setNodeMaintenance",
        tags: ["nodes"],
        description:
          "Take a node out of service or return it (owner only; admin on the control-plane host). Turning it on stops every subshell running there, whoever owns them.",
      },
    },
  );
