import { previewDisplayReadiness } from "@internal/pane-runtime";
import { parsePreviewDisplayReadiness } from "@internal/subshell-protocol";
import { Elysia, t } from "elysia";
import { HttpError } from "@/api/auth-guard.js";
import { loadNodeGate } from "@/api/nodes/node-gate.js";
import { nodeManagementGuard } from "@/api/nodes/node-management-guard.js";
import { apiModels } from "@/schema/index.js";
import { NodeRpcError, sendCommand } from "@/services/nodes/node-rpc.js";

/** Read-only launch preflight; check the selected machine, never the browser's host. */
export const previewDisplayRoute = new Elysia()
  .use(nodeManagementGuard)
  .use(apiModels)
  .get(
    "/:id/preview-display",
    async ({ params, user, actor }) => {
      const gate = await loadNodeGate(user.id, params.id, actor);
      if (!gate) throw new HttpError(404, "Node not found");
      if (gate.row.kind === "local") return previewDisplayReadiness();
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
          supported: t.Boolean(),
          missing: t.Array(t.Union([t.Literal("Xvfb"), t.Literal("x11vnc"), t.Literal("xauth")])),
        }),
        401: "ApiErrorResponse",
        403: "ApiErrorResponse",
        404: "ApiErrorResponse",
        409: "ApiErrorResponse",
        502: "ApiErrorResponse",
      },
      systemPermission: "nodes:read",
      detail: {
        operationId: "getNodePreviewDisplay",
        tags: ["nodes"],
        description: "Check virtual display prerequisites on this machine",
      },
    },
  );
