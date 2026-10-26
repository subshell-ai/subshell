import { BackendErrorCodes } from "@internal/backend-errors";
import { CROSS_AGENT_DIR_MAX, CROSS_AGENT_DIRS_MAX, CROSS_AGENT_NOTES_MAX } from "@internal/subshell-protocol";
import { Elysia, t } from "elysia";
import { apiErrorBody } from "@/api/api-error.js";
import { nodeManagementGuard } from "@/api/nodes/node-management-guard.js";
import { apiModels } from "@/api/schemas/index.js";
import { db } from "@/db/index.js";
import { NodesRepository } from "@/db/repositories/nodes.repository.js";
import { audit } from "@/modules/audit.js";
import { loadNodeGate } from "@/modules/nodes/gate.js";
import { ForbiddenError } from "@/shared/errors.js";

const GuidanceBodySchema = t.Object({
  crossCommNotes: t.Nullable(
    t.String({ maxLength: CROSS_AGENT_NOTES_MAX, description: "Notes for calling agents; null clears them" }),
  ),
  recommendedStartingDirs: t.Array(
    t.String({
      minLength: 1,
      maxLength: CROSS_AGENT_DIR_MAX,
      pattern: "^/[^\\u0000\\r\\n]*$",
      description: "Suggested absolute directory on this node",
    }),
    {
      maxItems: CROSS_AGENT_DIRS_MAX,
      description: "Advisory starting directories, independent of directory permissions",
    },
  ),
});
const GuidanceResponseSchema = t.Object({ ok: t.Literal(true, { description: "Guidance saved" }) });

/** Owner-managed discovery metadata; no node RPC or launch-policy changes. */
export const setNodeCrossAgentRoute = new Elysia()
  .use(nodeManagementGuard)
  .use(apiModels)
  .put(
    "/:id/cross-agent",
    async ({ params, body, user, actor, status }) => {
      const gate = await loadNodeGate(user.id, params.id, actor);
      if (!gate)
        return status(404, apiErrorBody({ code: BackendErrorCodes.NOT_FOUND_ERROR, message: "Node not found" }));
      if (!gate.canManage) throw new ForbiddenError();
      await new NodesRepository(db).setCrossAgentGuidance(gate.row.id, body.crossCommNotes, [
        ...new Set(body.recommendedStartingDirs),
      ]);
      await audit({
        actorUserId: user.id,
        action: "node.cross-agent.update",
        metadataJson: null,
        targetType: "node",
        targetId: gate.row.id,
      });
      return { ok: true as const };
    },
    {
      params: t.Object({ id: t.String({ description: "Node id" }) }),
      body: GuidanceBodySchema,
      response: {
        200: GuidanceResponseSchema,
        400: "ApiErrorResponse",
        401: "ApiErrorResponse",
        403: "ApiErrorResponse",
        404: "ApiErrorResponse",
        422: "ApiErrorResponse",
      },
      systemPermission: "nodes:configure",
      detail: {
        operationId: "setNodeCrossAgentGuidance",
        tags: ["nodes"],
        description: "Save calling-agent guidance. Node owner only, or a server admin for the server's node.",
      },
    },
  );
