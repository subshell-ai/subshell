import { parsePreviewDisplayReadiness } from "@internal/subshell-protocol";
import { Elysia, t } from "elysia";
import { authGuard, HttpError } from "@/api/auth-guard.js";
import { loadNodeGate } from "@/api/nodes/node-gate.js";
import { getLocalPreviewRuntime } from "@/preview/local-preview.js";
import { apiModels } from "@/schema/index.js";
import { NodeRpcError, sendCommand } from "@/services/nodes/node-rpc.js";

/** Read-only launch preflight. Machine actors may inspect owned enrolled nodes only, as in list_nodes; loadNodeGate never inherits shares or admin rights for them. */
export const displayReadinessRoute = new Elysia()
  .use(authGuard)
  .use(apiModels)
  .get(
    "/:id/display-readiness",
    async ({ params, user, actor }) => {
      const gate = await loadNodeGate(user.id, params.id, actor);
      if (!gate) throw new HttpError(404, "Node not found");
      if (gate.row.kind === "local") return getLocalPreviewRuntime().displays.readiness();
      try {
        const result = parsePreviewDisplayReadiness(await sendCommand(params.id, { type: "preview_display_check" }));
        if (!result) throw new HttpError(502, "Couldn't check virtual display requirements. Recheck before launching.");
        return result;
      } catch (error) {
        if (error instanceof NodeRpcError) {
          throw new HttpError(
            409,
            error.code === "unsupported"
              ? "Update Subshell on this machine, then recheck virtual display requirements."
              : error.code === "offline"
                ? "Couldn't reach this machine. Bring its node online, then recheck virtual display requirements."
                : "Couldn't check this machine. Make sure its node is online and up to date, then choose Recheck.",
          );
        }
        throw error;
      }
    },
    {
      response: {
        200: t.Object({
          supported: t.Boolean({ description: "Whether the selected display provider supports this machine" }),
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
        description: "Check virtual display prerequisites on this machine",
      },
    },
  );
