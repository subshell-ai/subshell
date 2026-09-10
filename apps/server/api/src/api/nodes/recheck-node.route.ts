import { BackendErrorCodes } from "@internal/backend-errors";
import { Elysia, t } from "elysia";
import { authGuard, ForbiddenError, requireCookieActor } from "@/api/auth-guard.js";
import { loadNodeGate } from "@/api/nodes/node-gate.js";
import { apiErrorBody } from "@/lib/api-error.js";
import { nodeCanConfigure } from "@/lib/node-access.js";
import { apiModels } from "@/schema/index.js";
import { detectOnNode } from "@/services/nodes/inventory.js";
import { NodeRpcError } from "@/services/nodes/node-rpc.js";

/** Response of a successful re-check — the data itself is already stored. */
const RecheckResponseSchema = t.Object({
  ok: t.Boolean({
    description:
      "True once the agent answered the `detect` command AND the parsed rows are stored: the command is awaited, and the answer merges over the snapshot before this response is sent, so an immediate refetch sees the new state",
  }),
});

/**
 * `POST /api/nodes/:id/recheck` — refresh one agent node's harness inventory
 * on demand (spec 2026-08-31 §6.2/§9; detection-shaped by the inversion spec
 * 2026-09-10 §4). Gate: `nodeCanConfigure`, cookie-only like the rest of the
 * registry.
 *
 * Sends the plane's `detect` command (spec §4) AWAITED: the node probes with
 * the shipped rules and answers RAW version text, the raw text is parsed HERE
 * by the plugin's `parseVersion`, the rows merge over the cached snapshot,
 * and the env values the answer carries refresh the resume-path inputs — all
 * before `{ ok: true }` is honest. Awaited, not fire-and-forget, because a
 * response claiming "fresh state stored" must not land before it is.
 *
 * This is ONE command and always was since the final review (R14c): the
 * interim form sent the agent's `{type:"inventory"}` scan first and swallowed
 * `unsupported` from the detect pass, justified by "a deployed v2 agent
 * predates the detect handler". That agent cannot exist on this protocol —
 * the exact-match gate (gate 2) refuses any version mismatch in either
 * direction, so a live socket means a detect-speaking agent — and the
 * post-inversion agent's `inventory` answer is an empty claim the handler
 * (correctly) never applies. The ladder was a signed round trip per Re-check
 * buying nothing, retired with its false justification.
 *
 * Error mapping from `NodeRpcError.code` (the actual enum): `offline` → 409
 * `NODE_OFFLINE`; `timeout` / `unsupported` / `failed` → 409
 * `NODE_UNREACHABLE` with the RPC's own message — the node either did not
 * answer or could not run the probe; neither is a caller-input error, so both
 * stay in the 409 conflict family (spec §9: "409 offline"). `unsupported` is
 * mapped, never swallowed: it is the agent's own contract answer to a command
 * it cannot run, which for a live v3 socket means something is genuinely
 * broken on that node.
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

      // NodeRpcError → 409, anything else propagates to the global handler.
      try {
        await detectOnNode(gate.row.id);
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
        description:
          "Ask an enrolled node to run the control plane's harness detection now (409 when offline or unresponsive)",
      },
    },
  );
