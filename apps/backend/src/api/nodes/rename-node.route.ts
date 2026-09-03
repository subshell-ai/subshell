import { BackendErrorCodes } from "@internal/backend-errors";
import { Elysia, t } from "elysia";
import { authGuard, ForbiddenError, requireCookieActor } from "@/api/auth-guard.js";
import { loadNodeGate } from "@/api/nodes/node-gate.js";
import { NodeViewSchema, toNodeView } from "@/api/nodes/node-view.js";
import { db } from "@/db/index.js";
import { NodesRepository } from "@/db/repositories/nodes.repository.js";
import { apiErrorBody } from "@/lib/api-error.js";
import { isUniqueNameViolation } from "@/lib/node-errors.js";
import { apiModels } from "@/schema/index.js";
import { audit } from "@/services/audit.js";

/** Rename body — same name shape enroll enforces (keeps picker labels sane). */
const RenameBodySchema = t.Object({
  name: t.String({ minLength: 1, maxLength: 64, description: "New display name (unique per owner)" }),
});

/**
 * `PATCH /api/nodes/:id` `{name}` — rename, OWNER-only (an admin's effective
 * edit does not extend to renaming a foreign agent; spec §9). The seeded
 * `local` node's name is IMMUTABLE — 400 for everyone, admin included.
 * Per-owner collision rides `idx_nodes_owner_name` → 409 `NODE_NAME_TAKEN`
 * (the index is the authority; no pre-check race). Cookie-only.
 */
export const renameNodeRoute = new Elysia()
  .use(authGuard)
  .use(apiModels)
  .patch(
    "/:id",
    async ({ params, body, user, actor, status }) => {
      requireCookieActor(actor, "Node renaming is restricted to browser subshells");
      const gate = await loadNodeGate(user.id, params.id);
      if (!gate) {
        return status(404, apiErrorBody({ code: BackendErrorCodes.NOT_FOUND_ERROR, message: "Node not found" }));
      }
      if (gate.row.kind === "local") {
        return status(
          400,
          apiErrorBody({ code: BackendErrorCodes.BAD_REQUEST, message: "The local node's name is fixed" }),
        );
      }
      if (!gate.canManage) throw new ForbiddenError();

      const nodes = new NodesRepository(db);
      let renamed;
      try {
        renamed = await nodes.rename(gate.row.id, body.name);
      } catch (err) {
        if (isUniqueNameViolation(err)) {
          return status(
            409,
            apiErrorBody({
              code: BackendErrorCodes.NODE_NAME_TAKEN,
              message: `You already have a node named "${body.name}"`,
              metadataSafe: { name: body.name },
            }),
          );
        }
        throw err;
      }
      await audit({
        actorUserId: user.id,
        action: "node.rename",
        targetType: "node",
        targetId: gate.row.id,
        metadataJson: JSON.stringify({ from: gate.row.name, to: body.name }),
      });
      return await toNodeView(renamed ?? { ...gate.row, name: body.name }, gate.access, gate.isAdmin);
    },
    {
      body: RenameBodySchema,
      response: {
        200: NodeViewSchema,
        400: "ApiErrorResponse",
        401: "ApiErrorResponse",
        403: "ApiErrorResponse",
        404: "ApiErrorResponse",
        409: "ApiErrorResponse",
      },
      detail: {
        operationId: "renameNode",
        tags: ["nodes"],
        description: "Rename a node (owner only; the local node's name is fixed)",
      },
    },
  );
