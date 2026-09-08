import { BackendErrorCodes } from "@internal/backend-errors";
import { Elysia, t } from "elysia";
import { authGuard, ForbiddenError, requireCookieActor } from "@/api/auth-guard.js";
import { loadNodeGate } from "@/api/nodes/node-gate.js";
import { apiErrorBody } from "@/lib/api-error.js";
import { nodeCanConfigure } from "@/lib/node-access.js";
import { apiModels } from "@/schema/index.js";
import { NodeRpcError, sendCommand } from "@/services/nodes/node-rpc.js";

/** Response of a successful re-check — the data itself rides the WS event path. */
const RecheckResponseSchema = t.Object({
  ok: t.Boolean({
    description:
      "True once the agent acknowledged the inventory command AND the fresh snapshot is stored: the inventory EVENT precedes the result on the wire, and per-socket dispatch is serialized (phase 2), so an immediate refetch sees the new inventory",
  }),
});

/**
 * `POST /api/nodes/:id/recheck` — refresh one agent node's harness inventory
 * on demand (spec 2026-08-31 §6.2/§9). Gate: `nodeCanConfigure`, cookie-only
 * like the rest of the registry.
 *
 * Sends the signed `{type:"inventory"}` command and waits for the agent's
 * `result`; the agent's `inventory` EVENT is persisted by the `/ws/node`
 * handler's `applyInventory` path. Agents send the event before the answer
 * and per-socket dispatch is serialized (phase 2, `handleNodeMessageQueued`),
 * so `{ ok: true }` truthfully attests "inventory stored" — the client's
 * refetch can never read the previous snapshot off this response.
 *
 * Error mapping from `NodeRpcError.code` (the actual enum): `offline` → 409
 * `NODE_OFFLINE`; `timeout` / `unsupported` / `failed` → 409
 * `NODE_UNREACHABLE` with the RPC's own message — the node either did not
 * answer or could not run the scan; neither is a caller-input error, so both
 * stay in the 409 conflict family (spec §9: "409 offline").
 *
 * `local` → 400: there is no agent to poke — the local view probes the binary
 * live on every read (a re-check is just another GET).
 */
export const recheckNodeRoute = new Elysia()
  .use(authGuard)
  .use(apiModels)
  .post(
    "/:id/recheck",
    async ({ params, user, actor, status }) => {
      requireCookieActor(actor, "Node re-checks are restricted to browser sessions");
      const gate = await loadNodeGate(user.id, params.id);
      if (!gate) {
        return status(404, apiErrorBody({ code: BackendErrorCodes.NOT_FOUND_ERROR, message: "Node not found" }));
      }
      if (!nodeCanConfigure(gate.access)) throw new ForbiddenError();
      if (gate.row.kind === "local") {
        return status(
          400,
          apiErrorBody({
            code: BackendErrorCodes.BAD_REQUEST,
            message: "The local node's harness state is probed live on every read — no re-check needed",
          }),
        );
      }

      try {
        await sendCommand(gate.row.id, { type: "inventory" });
      } catch (err) {
        if (err instanceof NodeRpcError) {
          return status(
            409,
            apiErrorBody({
              code: err.code === "offline" ? BackendErrorCodes.NODE_OFFLINE : BackendErrorCodes.NODE_UNREACHABLE,
              message: err.message,
            }),
          );
        }
        throw err;
      }
      return { ok: true } as const;
    },
    {
      params: t.Object({ id: t.String({ description: "Node id" }) }),
      response: {
        200: RecheckResponseSchema,
        400: "ApiErrorResponse",
        401: "ApiErrorResponse",
        403: "ApiErrorResponse",
        404: "ApiErrorResponse",
        409: "ApiErrorResponse",
      },
      detail: {
        operationId: "recheckNode",
        tags: ["nodes"],
        description: "Ask an enrolled node for a fresh harness inventory (409 when offline or unresponsive)",
      },
    },
  );
