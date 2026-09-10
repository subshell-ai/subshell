import { BackendErrorCodes } from "@internal/backend-errors";
import { Elysia, t } from "elysia";
import { authGuard, ForbiddenError, requireCookieActor } from "@/api/auth-guard.js";
import { loadNodeGate } from "@/api/nodes/node-gate.js";
import { NodeViewSchema, toNodeView } from "@/api/nodes/node-view.js";
import { apiErrorBody } from "@/lib/api-error.js";
import { nodeCanManageFor } from "@/lib/node-access.js";
import { apiModels } from "@/schema/index.js";
import { audit } from "@/services/audit.js";
import { installNodePlugin, uninstallNodePlugin } from "@/services/nodes/plugin-sync.js";

/**
 * Installing and removing a plugin on one node (spec 2026-09-09 §6).
 *
 * **Owner-only (`canManage`), NOT `nodeCanConfigure`.** Any node share, even
 * `view`, already lets a grantee launch subshells there, so an `edit` grantee
 * who could install a plugin would face no restriction at all. The directory
 * allowlist is gated the same way for exactly this reason.
 *
 * **Both paths are audited.** Installing a plugin adds a program the node
 * will execute under its own OS user, and removing one takes launch targets
 * away from everyone that node is shared with. That is the same class of act
 * as `node.rename` and `node.shares_set`, which their own route modules audit
 * the same way.
 *
 * **An offline node is REFUSED, not queued.** The node owns its plugin set and
 * the server mirrors what it reports, so there is no desired state to
 * reconcile: a queue would mean the UI could show a plugin the node is not
 * running. This is deliberately unlike `allowed-dirs`, where the control plane
 * owns a security control and a node running stale rules must be corrected.
 */

const PluginBodySchema = t.Object({
  pluginId: t.String({ description: "Plugin id to install, e.g. 'claude-code'" }),
});

const PARAMS = t.Object({
  id: t.String({ description: "Node id" }),
  pluginId: t.String({ description: "Plugin id" }),
});

/** The response set every path here shares. */
const RESPONSES = {
  200: NodeViewSchema,
  400: "ApiErrorResponse",
  401: "ApiErrorResponse",
  403: "ApiErrorResponse",
  404: "ApiErrorResponse",
  409: "ApiErrorResponse",
} as const;

export const setNodePluginRoute = new Elysia()
  .use(authGuard)
  .use(apiModels)
  .post(
    "/:id/plugins",
    async ({ params, body, user, actor, status }) => {
      requireCookieActor(actor, "Plugin management is restricted to browser sessions");
      const gate = await loadNodeGate(user.id, params.id);
      if (!gate) {
        return status(404, apiErrorBody({ code: BackendErrorCodes.NOT_FOUND_ERROR, message: "Node not found" }));
      }
      if (!nodeCanManageFor(gate.row.kind, gate.access, gate.isAdmin)) throw new ForbiddenError();

      await installNodePlugin(gate.row, body.pluginId);
      // After the node accepted it, never before: an audit line for a change
      // an offline node refused would be a record of something that did not
      // happen.
      await audit({
        actorUserId: user.id,
        action: "node.plugin.install",
        targetType: "node",
        targetId: gate.row.id,
        metadataJson: JSON.stringify({ pluginId: body.pluginId, node: gate.row.name }),
      });
      const fresh = await loadNodeGate(user.id, params.id);
      return await toNodeView(fresh?.row ?? gate.row, gate.access, gate.isAdmin);
    },
    {
      params: t.Object({ id: t.String({ description: "Node id" }) }),
      body: PluginBodySchema,
      response: RESPONSES,
      detail: {
        operationId: "installNodePlugin",
        tags: ["nodes"],
        description:
          "Installs a plugin on one node (owner-only, cookie session). The node performs the install and reports its whole set back; an offline node is refused rather than queued",
      },
    },
  )
  .delete(
    "/:id/plugins/:pluginId",
    async ({ params, user, actor, status }) => {
      requireCookieActor(actor, "Plugin management is restricted to browser sessions");
      const gate = await loadNodeGate(user.id, params.id);
      if (!gate) {
        return status(404, apiErrorBody({ code: BackendErrorCodes.NOT_FOUND_ERROR, message: "Node not found" }));
      }
      if (!nodeCanManageFor(gate.row.kind, gate.access, gate.isAdmin)) throw new ForbiddenError();

      await uninstallNodePlugin(gate.row, params.pluginId);
      await audit({
        actorUserId: user.id,
        action: "node.plugin.uninstall",
        targetType: "node",
        targetId: gate.row.id,
        metadataJson: JSON.stringify({ pluginId: params.pluginId, node: gate.row.name }),
      });
      const fresh = await loadNodeGate(user.id, params.id);
      return await toNodeView(fresh?.row ?? gate.row, gate.access, gate.isAdmin);
    },
    {
      params: PARAMS,
      response: RESPONSES,
      detail: {
        operationId: "uninstallNodePlugin",
        tags: ["nodes"],
        description:
          "Removes a plugin from one node (owner-only, cookie session). Removing one that is already absent succeeds; an offline node is refused rather than queued",
      },
    },
  );
