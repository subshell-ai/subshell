import { BackendErrorCodes } from "@internal/backend-errors";
import { NODE_NAME_MAX_UNITS, normalizeNodeName } from "@internal/subshell-protocol";
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

/**
 * Rename body — the same name shape enroll enforces (keeps picker labels sane),
 * including the cap: `NODE_NAME_MAX` and `normalizeNodeName` come from
 * `@internal/subshell-protocol` since 2026-09-17, so the route that names a node at
 * enroll and the route that renames it afterwards cannot disagree about what a name is,
 * and neither can the agent's `--name` preflight or the desktop Enroll field. The
 * `maxLength` is the unit-sized transport guard, not that cap: JSON Schema counts
 * UTF-16 code units, so `NODE_NAME_MAX` here would refuse a name `normalizeNodeName`
 * counts as legal.
 */
const RenameBodySchema = t.Object({
  name: t.String({
    minLength: 1,
    maxLength: NODE_NAME_MAX_UNITS,
    description: "New display name (unique per owner); control characters are stripped and whitespace collapsed",
  }),
});

/**
 * `PATCH /api/nodes/:id` `{name}` — rename, OWNER-only (an admin's effective
 * edit does not extend to renaming a foreign agent; spec §9).
 *
 * The control-plane host's `local` row IS renameable here (spec 2026-09-08):
 * its `canManage` already resolves to admin, so the gate below is the whole
 * rule and no permission concept was added. It used to be refused outright,
 * which left every user but the operator reading "Local" as their own machine
 * in the Nodes list and in every launch picker.
 *
 * The name is normalized before it is stored — a node name reaches log lines
 * and menu labels, and length was previously the only thing enforced.
 * Per-owner collision rides `idx_nodes_owner_name` → 409 `NODE_NAME_TAKEN`
 * (the index is the authority; no pre-check race). Cookie-only.
 */
export const renameNodeRoute = new Elysia()
  .use(authGuard)
  .use(apiModels)
  .patch(
    "/:id",
    async ({ params, body, user, actor, status }) => {
      requireCookieActor(actor, "Node renaming is restricted to browser sessions");
      const gate = await loadNodeGate(user.id, params.id);
      if (!gate) {
        return status(404, apiErrorBody({ code: BackendErrorCodes.NOT_FOUND_ERROR, message: "Node not found" }));
      }
      if (!gate.canManage) throw new ForbiddenError();

      const name = normalizeNodeName(body.name);
      if (!name) {
        return status(
          400,
          apiErrorBody({
            code: BackendErrorCodes.BAD_REQUEST,
            message: "A node name needs at least one printable character",
          }),
        );
      }

      const nodes = new NodesRepository(db);
      let renamed;
      try {
        renamed = await nodes.rename(gate.row.id, name);
      } catch (err) {
        if (isUniqueNameViolation(err)) {
          return status(
            409,
            apiErrorBody({
              code: BackendErrorCodes.NODE_NAME_TAKEN,
              message: `You already have a node named "${name}"`,
              metadataSafe: { name },
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
        metadataJson: JSON.stringify({ from: gate.row.name, to: name }),
      });
      return await toNodeView(renamed ?? { ...gate.row, name }, gate.access, gate.isAdmin, gate.granted);
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
        description:
          "Rename a node. Owner-only for an enrolled agent; the control-plane host's own row is managed by an admin",
      },
    },
  );
