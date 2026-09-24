import { BackendErrorCodes } from "@internal/backend-errors";
import { Elysia, t } from "elysia";
import { authGuard, ForbiddenError, requireCookieActor } from "@/api/auth-guard.js";
import { loadNodeGate } from "@/api/nodes/node-gate.js";
import { deleteApiKey, setApiKeyEnabled } from "@/auth/apikey-store.js";
import { db } from "@/db/index.js";
import { NodesRepository } from "@/db/repositories/nodes.repository.js";
import { apiErrorBody } from "@/lib/api-error.js";
import { apiModels } from "@/schema/index.js";
import { audit } from "@/services/audit.js";
import { disconnectNode, getLive, REVOKED_CLOSE_CODE } from "@/services/nodes/node-registry.js";
import { failConnPendings } from "@/services/nodes/node-rpc.js";

/** `?force=true` skips the running-subshells guard (string form — no coercion surprises). */
const QuerySchema = t.Object({
  force: t.Optional(t.String({ description: "'true' proceeds despite running subshells (offline nodes only)" })),
});

const OkSchema = t.Object({ ok: t.Boolean({ description: "Always true on success" }) });

/**
 * `DELETE /api/nodes/:id` — retire a node (spec 2026-08-31 §5.4/§9). OWNER
 * only (admins included NOT — effective edit never extends to delete),
 * cookie-only, and `local` is undeletable (400). Guards, in order:
 * running subshells → 409 unless `?force=true`; force on a node that is
 * ONLINE → 409 (force may not ambush a live machine — remote terminate is
 * phase 2, so "go offline first" is the honest instruction).
 *
 * Teardown: disable + delete the node's api key, delete the row (shares/
 * harness states ride the FK cascade; the `node:<id>` E2EE identity row is
 * dropped explicitly), then
 * evict + close a live socket (4401) and fail its in-flight commands —
 * AFTER the DB changes, so the socket can never outlive its credential by
 * even one frame's worth of trust.
 * Force-deleting an OFFLINE node deliberately leaves subshell rows alone:
 * the machines are gone; those rows crash/reconcile on their own.
 */
export const deleteNodeRoute = new Elysia()
  .use(authGuard)
  .use(apiModels)
  .delete(
    "/:id",
    async ({ params, query, user, actor, status }) => {
      requireCookieActor(actor, "Node deletion is restricted to browser sessions");
      const gate = await loadNodeGate(user.id, params.id);
      if (!gate) {
        return status(404, apiErrorBody({ code: BackendErrorCodes.NOT_FOUND_ERROR, message: "Node not found" }));
      }
      if (gate.row.kind === "local") {
        return status(
          400,
          apiErrorBody({ code: BackendErrorCodes.BAD_REQUEST, message: "The local node cannot be deleted" }),
        );
      }
      if (!gate.canManage) throw new ForbiddenError();

      const nodes = new NodesRepository(db);
      const force = query.force === "true";
      const running = await nodes.countRunningSubshells(gate.row.id);
      if (running > 0 && !force) {
        return status(
          409,
          apiErrorBody({
            code: BackendErrorCodes.NODE_RUNNING_SUBSHELLS,
            message: `Node has ${running} running subshell${running === 1 ? "" : "s"}; delete again with ?force=true`,
            metadataSafe: { runningSubshells: running },
          }),
        );
      }
      // Live truth = the registry first (a heartbeat-stalled socket is still
      // live), the status projection as fallback (e.g. a local-node test seam).
      const online = getLive(gate.row.id) !== undefined || gate.row.status === "online";
      if (force && online) {
        return status(
          409,
          apiErrorBody({
            code: BackendErrorCodes.NODE_ONLINE,
            message: "Node is online; force-delete only applies to offline nodes (remote terminate lands in phase 2)",
          }),
        );
      }

      if (gate.row.apiKeyId) {
        setApiKeyEnabled(gate.row.apiKeyId, false);
        deleteApiKey(gate.row.apiKeyId);
      }
      await nodes.deleteById(gate.row.id);
      await db.deleteFrom("identities").where("principalId", "=", `node:${gate.row.id}`).execute();
      // Capture the conn BEFORE evicting (disconnectNode drops the map entry)
      // and drain its in-flight commands AFTER (P1-T9 carry: eviction must
      // failConnPendings itself — no real socket close may ever fire).
      const evicted = getLive(gate.row.id);
      await disconnectNode(gate.row.id, REVOKED_CLOSE_CODE, "node deleted");
      if (evicted) failConnPendings(evicted, "offline", "node deleted");

      await audit({
        actorUserId: user.id,
        action: "node.delete",
        targetType: "node",
        targetId: gate.row.id,
        metadataJson: JSON.stringify({ name: gate.row.name, runningSubshells: running, forced: force }),
      });
      return { ok: true };
    },
    {
      query: QuerySchema,
      response: {
        200: OkSchema,
        400: "ApiErrorResponse",
        401: "ApiErrorResponse",
        403: "ApiErrorResponse",
        404: "ApiErrorResponse",
        409: "ApiErrorResponse",
      },
      detail: {
        operationId: "deleteNode",
        tags: ["nodes"],
        description: "Delete a node (owner only; revokes its key; ?force=true for offline nodes with subshells)",
      },
    },
  );
