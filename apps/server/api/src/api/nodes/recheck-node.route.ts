import { BackendErrorCodes } from "@internal/backend-errors";
import { Elysia, t } from "elysia";
import { authGuard, ForbiddenError, requireCookieActor } from "@/api/auth-guard.js";
import { loadNodeGate } from "@/api/nodes/node-gate.js";
import { apiErrorBody } from "@/lib/api-error.js";
import { nodeCanConfigure } from "@/lib/node-access.js";
import { apiModels } from "@/schema/index.js";
import { detectOnNode } from "@/services/nodes/inventory.js";
import { NodeRpcError, sendCommand } from "@/services/nodes/node-rpc.js";
import { logger } from "@/utils/logger.js";

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
 * `result`; a paired pre-inversion agent's `inventory` EVENT is persisted by
 * the `/ws/node` handler's `applyInventory` path (agents send the event
 * before the answer and per-socket dispatch is serialized (phase 2,
 * `handleNodeMessageQueued`)). Since Task 7 the post-inversion agent answers
 * with an EMPTY harness claim the handler (correctly) does not apply, so for
 * those agents the freshness below is the whole story; `{ ok: true }` still
 * truthfully attests "fresh state stored" because the awaited detect pass
 * lands after this response's precondition either way.
 *
 * Then it runs the plane's own `detect` pass (spec 2026-09-10 §4), awaited for
 * the same reason: the detection rows (raw answers parsed HERE by the plugin)
 * merge over the snapshot the agent just pushed, and a response claiming the
 * fresh state is stored must not land before they are. ONE exception: a
 * deployed v2 agent predates the `detect` handler (the add did not bump the
 * protocol; the bump is Task 8), and the switch's contract answer is
 * `unsupported`. That is not a failed re-check — on those agents the node's
 * own inventory scan stored its self-parsed versions above, exactly as before
 * the command existed — so ONLY `NodeRpcError("unsupported")` from the detect
 * pass is swallowed (debug-logged); every other failure keeps the ladder.
 *
 * Error mapping from `NodeRpcError.code` (the actual enum): `offline` → 409
 * `NODE_OFFLINE`; `timeout` / `unsupported` / `failed` → 409
 * `NODE_UNREACHABLE` with the RPC's own message — the node either did not
 * answer or could not run the scan; neither is a caller-input error, so both
 * stay in the 409 conflict family (spec §9: "409 offline"). `unsupported`
 * participates in that mapping for the INVENTORY command; for the detect
 * pass it is the one swallowed code (see above).
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
            message: "The local node's harness state is probed live on every read; no re-check needed",
          }),
        );
      }

      // The existing ladder, shared by both commands: NodeRpcError → 409,
      // anything else propagates to the global handler.
      const rpcConflict = (err: unknown) => {
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
      };
      try {
        await sendCommand(gate.row.id, { type: "inventory" });
      } catch (err) {
        return rpcConflict(err);
      }
      try {
        await detectOnNode(gate.row.id);
      } catch (err) {
        // TWO try blocks on purpose: by here the inventory command has
        // succeeded and its EVENT has already stored the snapshot, so a
        // 409 from the detect pass would contradict this route's own
        // contract ("ok:true attests inventory stored"). An agent deployed
        // before `detect` (the add kept protocol 2; the bump is Task 8)
        // answers the switch's contract arm `unsupported` — that is today's
        // behavior, not a failed re-check, so ONLY that code is swallowed.
        // A genuine failure (timeout, failed, a later offline) stays on the
        // ladder, exactly as the inventory command's own failures do.
        if (err instanceof NodeRpcError && err.code === "unsupported") {
          logger.debug(`recheck: node ${gate.row.id} predates the detect command; its own inventory scan stands`);
        } else {
          return rpcConflict(err);
        }
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
