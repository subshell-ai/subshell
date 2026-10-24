import { BackendErrorCodes } from "@internal/backend-errors";
import { Elysia, t } from "elysia";
import { ForbiddenError } from "@/api/auth-guard.js";
import { loadNodeGate } from "@/api/nodes/node-gate.js";
import { nodeManagementGuard } from "@/api/nodes/node-management-guard.js";
import { NodeViewSchema, toNodeView } from "@/api/nodes/node-view.js";
import { db } from "@/db/index.js";
import { NodesRepository } from "@/db/repositories/nodes.repository.js";
import { apiErrorBody } from "@/lib/api-error.js";
import { apiModels } from "@/schema/index.js";
import { setPreviewEnabled } from "@/services/nodes/preview-enabled.js";

const PreviewEnabledBodySchema = t.Object({
  on: t.Boolean({
    description:
      "Allow this machine's pane content to be watched (live preview and screencasts). Off by default. Owner only; admin on the control-plane host.",
  }),
});

/**
 * `PUT /api/nodes/:id/preview-enabled` `{on}`: open or close pane preview on
 * one machine (pane-preview spec Task 3). Browser session or an API key
 * holding the `nodes:preview` grant.
 *
 * **OWNER-only** (`gate.canManage`, with the seeded-`local` admin exception),
 * the same gate as SSH and maintenance: a grantee may restart the agent or
 * read its log, but deciding whether this machine's pane content may be
 * watched is not theirs. The permission is its OWN catalog id, not
 * `nodes:ssh`. A key scoped to SSH must not be able to flip preview; the
 * grants answer different questions.
 *
 * The route writes nothing and audits nothing itself: `setPreviewEnabled` is
 * the one change-site (row + audit + push), so no caller can perform half the
 * act. The route is the only place the acting human is wired in.
 *
 * It answers on an OFFLINE node rather than refusing: the flag is the plane's
 * record, and the machine learns the value at its next `ready` reconcile.
 * Refusing would make the flag settable only while the machine is reachable,
 * which is backwards for a gate that exists to be closed.
 */
export const setNodePreviewEnabledRoute = new Elysia()
  .use(nodeManagementGuard)
  .use(apiModels)
  .put(
    "/:id/preview-enabled",
    async ({ params, body, user, actor, status }) => {
      const gate = await loadNodeGate(user.id, params.id, actor);
      if (!gate) {
        return status(404, apiErrorBody({ code: BackendErrorCodes.NOT_FOUND_ERROR, message: "Node not found" }));
      }
      if (!gate.canManage) throw new ForbiddenError();

      await setPreviewEnabled(gate.row.id, user.id, body.on);
      // Re-read rather than patching the gate's snapshot: the service wrote
      // the row, and the view must render what is stored, not what this
      // handler believes it asked for.
      const row = (await new NodesRepository(db).findById(gate.row.id)) ?? gate.row;
      return await toNodeView(row, gate.access, gate.isAdmin, gate.granted);
    },
    {
      params: t.Object({ id: t.String({ description: "Node id" }) }),
      body: PreviewEnabledBodySchema,
      response: {
        200: NodeViewSchema,
        400: "ApiErrorResponse",
        401: "ApiErrorResponse",
        403: "ApiErrorResponse",
        404: "ApiErrorResponse",
      },
      systemPermission: "nodes:preview",
      detail: {
        operationId: "setNodePreviewEnabled",
        tags: ["nodes"],
        description:
          "Allow or refuse pane preview on a node (owner only; admin on the control-plane host). Off by default; enabling lets authorized viewers watch this machine's pane content.",
      },
    },
  );
