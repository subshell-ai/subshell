import { BackendErrorCodes } from "@internal/backend-errors";
import { Elysia, t } from "elysia";
import { apiErrorBody } from "@/api/api-error.js";
import { nodeManagementGuard } from "@/api/nodes/node-management-guard.js";
import { NodeViewSchema, toNodeView } from "@/api/nodes/node-view.js";
import { apiModels } from "@/api/schemas/index.js";
import { db } from "@/db/index.js";
import { NodesRepository } from "@/db/repositories/nodes.repository.js";
import { loadNodeGate } from "@/modules/nodes/gate.js";
import { setNodeMcpEnabled } from "@/modules/nodes/mcp-enabled.js";
import { ForbiddenError } from "@/shared/errors.js";

const McpEnabledBodySchema = t.Object({
  on: t.Boolean({
    description:
      "Allow the subshell MCP in panes launched on this machine. On by default: turning it off strips the MCP from every new launch here, whoever the pane's owner is and whatever their own preference says. Owner only; admin on the control-plane host.",
  }),
});

/**
 * `PUT /api/nodes/:id/mcp-enabled` `{on}`: allow or refuse the subshell MCP on
 * one machine. Browser session or an API key holding the `nodes:mcp` grant.
 *
 * **OWNER-only** (`gate.canManage`, with the seeded-`local` admin exception),
 * the same gate as SSH and previews: an `edit` grantee may restart the agent
 * or read its log, but deciding whether the MCP may run on this machine is not
 * theirs. The grant is its OWN catalog id: a key scoped to SSH must not be
 * able to flip MCP access, because the two answer different questions.
 *
 * Off here outranks every account preference: the machine's owner is saying
 * nothing of that tool surface runs on their hardware, and the node enforces
 * it on itself (mirror file, launch-frame strip, `subshell mcp` refusal), so
 * the refusal holds even for a harness the plane never wired per-launch.
 *
 * The route writes nothing and audits nothing itself: `setNodeMcpEnabled` is
 * the one change-site (row + audit + best-effort push), so no caller can
 * perform half the act.
 *
 * It answers on an OFFLINE node rather than refusing: the flag is the plane's
 * record, and the machine learns the value at its next `ready` reconcile.
 * Refusing would make a gate that exists to be closable openable only while
 * the machine happens to be reachable.
 */
export const setNodeMcpEnabledRoute = new Elysia()
  .use(nodeManagementGuard)
  .use(apiModels)
  .put(
    "/:id/mcp-enabled",
    async ({ params, body, user, actor, status }) => {
      const gate = await loadNodeGate(user.id, params.id, actor);
      if (!gate) {
        return status(404, apiErrorBody({ code: BackendErrorCodes.NOT_FOUND_ERROR, message: "Node not found" }));
      }
      if (!gate.canManage) throw new ForbiddenError();

      await setNodeMcpEnabled(gate.row.id, user.id, body.on);
      // Re-read rather than patching the gate's snapshot: the service wrote
      // the row, and the view must render what is stored, not what this
      // handler believes it asked for.
      const row = (await new NodesRepository(db).findById(gate.row.id)) ?? gate.row;
      return await toNodeView(row, gate.access, gate.isAdmin, gate.granted);
    },
    {
      params: t.Object({ id: t.String({ description: "Node id" }) }),
      body: McpEnabledBodySchema,
      response: {
        200: NodeViewSchema,
        400: "ApiErrorResponse",
        401: "ApiErrorResponse",
        403: "ApiErrorResponse",
        404: "ApiErrorResponse",
      },
      systemPermission: "nodes:mcp",
      detail: {
        operationId: "setNodeMcpEnabled",
        tags: ["nodes"],
        description:
          "Allow or refuse the subshell MCP on a node (owner only; admin on the control-plane host). On by default; off strips the MCP from every new launch on this machine and outranks any account preference.",
      },
    },
  );
