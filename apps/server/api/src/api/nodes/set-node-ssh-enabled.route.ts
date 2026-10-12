import { BackendErrorCodes } from "@internal/backend-errors";
import { Elysia, t } from "elysia";
import { authGuard, ForbiddenError, requireCookieActor } from "@/api/auth-guard.js";
import { loadNodeGate } from "@/api/nodes/node-gate.js";
import { NodeViewSchema, toNodeView } from "@/api/nodes/node-view.js";
import { db } from "@/db/index.js";
import { NodesRepository } from "@/db/repositories/nodes.repository.js";
import { apiErrorBody } from "@/lib/api-error.js";
import { apiModels } from "@/schema/index.js";
import { setNodeSshEnabled } from "@/services/nodes/ssh-enabled.js";

const SshEnabledBodySchema = t.Object({
  on: t.Boolean({
    description:
      "Allow this machine to be used for Subshell SSH (outbound ssh and serving its keys). Off by default. Owner only; admin on the control-plane host.",
  }),
});

/**
 * `PUT /api/nodes/:id/ssh-enabled` `{on}` — open or close Subshell SSH on one
 * machine (spec 4.3). Cookie-only.
 *
 * **OWNER-only** (`gate.canManage`, with the seeded-`local` admin exception),
 * the same gate as maintenance, delete and re-share — deliberately NOT the
 * `nodeCanConfigure` gate an `edit` grantee holds. Enabling SSH widens what
 * can be done THROUGH this machine's OS account (dial out with its keys,
 * serve them to peers); restarting the agent or reading its log is
 * administration, deciding who may SSH from it is a different act.
 *
 * The route writes nothing and audits nothing itself: `setNodeSshEnabled` is
 * the one change-site (row + audit, and from Task 7 the best-effort push to
 * the machine), so no caller — including the node-side paths Task 7 adds —
 * can perform half the act.
 *
 * It answers on an OFFLINE node rather than refusing: the flag is the plane's
 * record, and the machine learns the value at its next `ready` (Task 7's
 * reconcile). Refusing would make the flag settable only while the machine is
 * reachable, which is backwards for a gate that exists to be closed.
 */
export const setNodeSshEnabledRoute = new Elysia()
  .use(authGuard)
  .use(apiModels)
  .put(
    "/:id/ssh-enabled",
    async ({ params, body, user, actor, status }) => {
      requireCookieActor(actor, "Node SSH enablement is restricted to browser sessions");
      const gate = await loadNodeGate(user.id, params.id);
      if (!gate) {
        return status(404, apiErrorBody({ code: BackendErrorCodes.NOT_FOUND_ERROR, message: "Node not found" }));
      }
      if (!gate.canManage) throw new ForbiddenError();

      await setNodeSshEnabled({
        nodeId: gate.row.id,
        on: body.on,
        changedAt: new Date().toISOString(),
        actorUserId: user.id,
      });
      // Re-read rather than patching the gate's snapshot: the service wrote
      // the row, and the view must render what is stored, not what this
      // handler believes it asked for.
      const row = (await new NodesRepository(db).findById(gate.row.id)) ?? gate.row;
      return await toNodeView(row, gate.access, gate.isAdmin, gate.granted);
    },
    {
      params: t.Object({ id: t.String({ description: "Node id" }) }),
      body: SshEnabledBodySchema,
      response: {
        200: NodeViewSchema,
        400: "ApiErrorResponse",
        401: "ApiErrorResponse",
        403: "ApiErrorResponse",
        404: "ApiErrorResponse",
      },
      detail: {
        operationId: "setNodeSshEnabled",
        tags: ["nodes"],
        description:
          "Allow or refuse Subshell SSH on a node (owner only; admin on the control-plane host). Off by default; enabling lets the plane dial out of and serve keys from this machine.",
      },
    },
  );
