import { parsePreviewDisplayReadiness } from "@internal/subshell-protocol";
import { Elysia, t } from "elysia";
import { authGuard } from "@/api/auth-guard.js";
import { apiModels } from "@/api/schemas/index.js";
import { DisplayProviderIdSchema } from "@/api/schemas/virtual-display.js";
import { db } from "@/db/index.js";
import { NodeSharesRepository } from "@/db/repositories/node-shares.repository.js";
import { NodesRepository } from "@/db/repositories/nodes.repository.js";
import { UserMetaRepository } from "@/db/repositories/user-meta.repository.js";
import { loadNodeAccess } from "@/modules/nodes/access.js";
import { loadNodeGate } from "@/modules/nodes/gate.js";
import { NodeRpcError, sendCommand } from "@/modules/nodes/node-rpc.js";
import { getLocalPreviewRuntime } from "@/modules/previews/local-preview.js";
import { HttpError } from "@/shared/errors.js";

/**
 * A machine credential's read of a launch preflight: the account's node
 * access, minus the cookie-only configuration gates. It mirrors the launch
 * gate (`resolveLaunchNode`) instead of `loadNodeGate`, because the nodes this
 * route probes are now the nodes the credential may launch on — shared
 * machines and the control-plane host under its grant included (operator
 * ruling 2026-11-10). Node CONFIGURATION still goes through `loadNodeGate`.
 */
async function loadMachineReadableNode(viewerId: string, nodeId: string) {
  const { row, access } = await loadNodeAccess(
    {
      nodes: new NodesRepository(db),
      shares: new NodeSharesRepository(db),
      userMeta: new UserMetaRepository(db),
    },
    viewerId,
    nodeId,
  );
  return row && access !== "none" ? { row } : undefined;
}

/** Read-only launch preflight. A browser reads any node it can access; a machine credential reads the account's set (see above). */
export const displayReadinessRoute = new Elysia()
  .use(authGuard)
  .use(apiModels)
  .get(
    "/:id/display-readiness",
    async ({ params, query, user, actor }) => {
      const gate =
        actor === "cookie"
          ? await loadNodeGate(user.id, params.id, actor)
          : await loadMachineReadableNode(user.id, params.id);
      if (!gate) throw new HttpError(404, "Node not found");
      if (gate.row.kind === "local") return getLocalPreviewRuntime().displays.readiness(query.provider);
      try {
        const result = parsePreviewDisplayReadiness(
          await sendCommand(params.id, {
            type: "preview_display_check",
            ...(query.provider ? { provider: query.provider } : {}),
          }),
        );
        if (!result) throw new HttpError(502, "Couldn't check virtual display requirements. Recheck before launching.");
        return result;
      } catch (error) {
        if (error instanceof NodeRpcError) {
          throw new HttpError(
            409,
            error.code === "unsupported"
              ? "Update Subshell on the selected node, then recheck virtual display requirements."
              : error.code === "offline"
                ? "Couldn't reach the selected node. Bring it online, then recheck virtual display requirements."
                : "Couldn't check the selected node. Make sure it is online and up to date, then choose Recheck.",
          );
        }
        throw error;
      }
    },
    {
      query: t.Object({ provider: t.Optional(DisplayProviderIdSchema) }),
      response: {
        200: t.Object({
          supported: t.Boolean({ description: "Whether the selected display provider supports the selected node" }),
          missing: t.Array(t.String({ minLength: 1, maxLength: 128, description: "An unmet provider requirement" }), {
            maxItems: 32,
            description: "Programs, permissions, or other prerequisites needed by the provider",
          }),
        }),
        401: "ApiErrorResponse",
        403: "ApiErrorResponse",
        404: "ApiErrorResponse",
        409: "ApiErrorResponse",
        502: "ApiErrorResponse",
      },
      systemPermission: "nodes:read",
      detail: {
        operationId: "getNodeDisplayReadiness",
        tags: ["nodes"],
        description: "Check virtual display prerequisites on the selected node",
      },
    },
  );
