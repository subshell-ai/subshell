import { BackendErrorCodes } from "@internal/backend-errors";
import { MAX_ALLOWED_DIRS, normalizeAllowedDir } from "@internal/subshell-protocol";
import { Elysia, t } from "elysia";
import { authGuard, ForbiddenError, requireCookieActor } from "@/api/auth-guard.js";
import { loadNodeGate } from "@/api/nodes/node-gate.js";
import { NodeViewSchema, toNodeView } from "@/api/nodes/node-view.js";
import { db } from "@/db/index.js";
import { NodeAllowedDirsRepository } from "@/db/repositories/node-allowed-dirs.repository.js";
import { apiErrorBody } from "@/lib/api-error.js";
import { apiModels } from "@/schema/index.js";
import { audit } from "@/services/audit.js";
import { pushAllowedDirsBestEffort } from "@/services/nodes/allowed-dirs-sync.js";

/** Replacement set — the complete intended list, never a delta. */
const AllowedDirsBodySchema = t.Object({
  dirs: t.Array(
    t.String({ minLength: 1, maxLength: 4096, description: "Absolute directory subshells may be launched under" }),
    {
      maxItems: MAX_ALLOWED_DIRS,
      description:
        "The complete replacement set. AN EMPTY ARRAY CLEARS THE RULES and returns the node to unrestricted — it does not mean 'permit nothing'",
    },
  ),
});

/**
 * `PUT /api/nodes/:id/allowed-dirs` `{dirs}` — replace a node's directory
 * allowlist (spec 2026-09-05). Cookie-only.
 *
 * **OWNER-only** (`gate.canManage`), deliberately NOT the `nodeCanConfigure`
 * gate that harness toggles use. Any node share — even `view` — lets the
 * grantee launch subshells on the node, so an `edit` grantee who could widen
 * this list to `/` would face no restriction at all: it would stop being a
 * boundary against precisely the people it exists to constrain. Admins get the
 * seeded-`local` exception the same way every other manage route does.
 *
 * Whole-set replacement, no add/remove endpoints: the list also lives ON the
 * node (pushed), and a partial update over two copies is two things to drift.
 *
 * Entries are validated here (absolute, no `..`) so a bad rule is a 400 the
 * operator can see, then normalized by the repository — which also dedupes and
 * drops entries nested inside a broader one. The stored result is what comes
 * back, so the UI always renders what is actually in force.
 */
export const setNodeAllowedDirsRoute = new Elysia()
  .use(authGuard)
  .use(apiModels)
  .put(
    "/:id/allowed-dirs",
    async ({ params, body, user, actor, status }) => {
      requireCookieActor(actor, "Directory rules are restricted to browser sessions");
      const gate = await loadNodeGate(user.id, params.id);
      if (!gate) {
        return status(404, apiErrorBody({ code: BackendErrorCodes.NOT_FOUND_ERROR, message: "Node not found" }));
      }
      if (!gate.canManage) throw new ForbiddenError();

      // Reject rather than silently drop: a rule the operator typed and the
      // server discarded would leave them believing a directory is permitted
      // when no rule for it exists.
      const invalid = body.dirs.filter((dir) => normalizeAllowedDir(dir) === null);
      if (invalid.length > 0) {
        return status(
          400,
          apiErrorBody({
            code: BackendErrorCodes.BAD_REQUEST,
            message: `Not usable as directory rules (each must be an absolute path with no ".." segment): ${invalid.join(", ")}`,
          }),
        );
      }

      const stored = await new NodeAllowedDirsRepository(db).replaceForNode(gate.row.id, body.dirs);
      // Tell the node, best-effort. The control plane enforces the same rules
      // at create time, so a node that misses this push is not a hole — it
      // re-learns them on its next `ready` (allowed-dirs-sync.ts).
      pushAllowedDirsBestEffort(gate.row.id, stored);
      await audit({
        actorUserId: user.id,
        action: "node.allowed_dirs.update",
        targetType: "node",
        targetId: gate.row.id,
        metadataJson: JSON.stringify({ dirs: stored }),
      });
      return await toNodeView(gate.row, gate.access, gate.isAdmin);
    },
    {
      params: t.Object({ id: t.String({ description: "Node id" }) }),
      body: AllowedDirsBodySchema,
      response: {
        200: NodeViewSchema,
        400: "ApiErrorResponse",
        401: "ApiErrorResponse",
        403: "ApiErrorResponse",
        404: "ApiErrorResponse",
      },
      detail: {
        operationId: "setNodeAllowedDirs",
        tags: ["nodes"],
        description:
          "Replace the directories subshells may be created under on this node (owner-only, cookie-only). An empty array clears the rules — the node becomes unrestricted. The set is pushed to the node, which enforces it independently",
      },
    },
  );
