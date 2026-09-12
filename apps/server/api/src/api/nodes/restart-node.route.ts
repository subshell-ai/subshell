import { BackendErrorCodes } from "@internal/backend-errors";
import { NODE_RESULT_KILLS_PANES, NODE_RESULT_NOT_SUPERVISED } from "@internal/subshell-protocol";
import { Elysia, t } from "elysia";
import { authGuard, ForbiddenError, requireCookieActor } from "@/api/auth-guard.js";
import { loadNodeGate } from "@/api/nodes/node-gate.js";
import { apiErrorBody } from "@/lib/api-error.js";
import { nodeCanConfigure } from "@/lib/node-access.js";
import { apiModels } from "@/schema/index.js";
import { audit } from "@/services/audit.js";
import { getLive } from "@/services/nodes/node-registry.js";
import { NodeRpcError, sendCommand } from "@/services/nodes/node-rpc.js";

const RestartBodySchema = t.Object({
  force: t.Optional(
    t.Boolean({
      description: "Restart even though the node's service definition would take live panes down",
    }),
  ),
});

const RestartResponseSchema = t.Object({
  ok: t.Literal(true, { description: "The agent accepted and is exiting for its manager to respawn it" }),
});

/** One refusal, as an API code and a sentence a person can act on. */
interface Refusal {
  code: BackendErrorCodes;
  message: string;
}

/**
 * The agent's refusal → an API code and message.
 *
 * Matched on `NodeRpcError.detail`, the agent's `result.error` VERBATIM,
 * by equality against the protocol's own constants. Not on `err.message`,
 * which wraps that string in a sentence this module does not own — a
 * substring match there would silently change meaning the day that sentence
 * is reworded, and would also read "not supervised enough, honestly" as the
 * exact refusal. Anything unrecognized falls through to the generic
 * unreachable code rather than being guessed at.
 *
 * `paneSafety` decides the WORDING of the kills-panes refusal but never the
 * code: the agent sends one string for both `kills` and `unknown`, because
 * its destructive verbs fail closed on a definition they could not read. Only
 * the plane knows which of the two it was, and telling someone their panes
 * WILL die when the truth is that nobody could tell is the kind of certainty
 * that makes a warning worth ignoring.
 */
function refusalFor(err: NodeRpcError, paneSafety: "keeps" | "kills" | "unknown" | undefined): Refusal {
  if (err.code === "offline") {
    return { code: BackendErrorCodes.NODE_OFFLINE, message: err.message };
  }
  if (err.code === "unsupported") {
    return {
      code: BackendErrorCodes.NODE_AGENT_TOO_OLD,
      message: "This node's agent predates the restart command; update the agent on that machine to restart it here",
    };
  }
  if (err.detail === NODE_RESULT_NOT_SUPERVISED) {
    return {
      code: BackendErrorCodes.NODE_NOT_SUPERVISED,
      message:
        "That agent is not running under a service manager, so exiting it would stop it rather than restart it; restart it where it was started",
    };
  }
  if (err.detail === NODE_RESULT_KILLS_PANES) {
    return {
      code: BackendErrorCodes.NODE_RESTART_KILLS_PANES,
      message:
        paneSafety === "unknown"
          ? "That node's service definition could not be read, so whether a restart keeps its running subshells is unknown; restart anyway with force, or repair the definition on that machine"
          : "That node's service definition would close every subshell running on it; reinstall the definition on that machine, or restart anyway with force",
    };
  }
  return { code: BackendErrorCodes.NODE_UNREACHABLE, message: err.message };
}

/**
 * `POST /api/nodes/:id/restart` — ask an enrolled node's agent to exit so its
 * own service manager respawns it (spec 2026-09-12 § 6.3).
 *
 * Gate: cookie only, owner or `edit` (`nodeCanConfigure`, the same gate
 * re-check carries). A `view` grantee may launch subshells here; restarting
 * the machine's daemon is a configure act, and it interrupts everyone else's
 * panes on that node rather than only their own.
 *
 * No new trust: the plane already runs arbitrary launches on an enrolled node,
 * and the command travels the same signed channel as every other one. The
 * AGENT decides — it refuses when its manager did not start it, and (like the
 * server's own restart, and like `subshell service restart`) when its
 * definition would take live panes down without `force`.
 *
 * `local` → 400: the control-plane host restarts itself through
 * `POST /api/admin/server/restart`, which is a different act with a different
 * gate. Routing it through here would give a node's `edit` grantee a way to
 * bounce the control plane.
 */
export const restartNodeRoute = new Elysia()
  .use(authGuard)
  .use(apiModels)
  .post(
    "/:id/restart",
    async ({ params, body, user, actor, status }) => {
      requireCookieActor(actor, "Node restarts are restricted to browser sessions");
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
            message: "The control-plane host restarts from Server Settings, not as a node",
          }),
        );
      }

      // Read before sending: the connection is what carries the agent's own
      // pane-safety report, and the command is about to take that socket down.
      const paneSafety = getLive(gate.row.id)?.agent?.runtime?.service.paneSafety;
      try {
        await sendCommand(gate.row.id, body.force ? { type: "restart", force: true } : { type: "restart" });
      } catch (err) {
        if (err instanceof NodeRpcError) {
          const refusal = refusalFor(err, paneSafety);
          return status(409, apiErrorBody({ code: refusal.code, message: refusal.message }));
        }
        throw err;
      }
      await audit({
        actorUserId: user.id,
        action: "node.restart",
        targetType: "node",
        targetId: gate.row.id,
        metadataJson: JSON.stringify({ forced: body.force === true }),
      });
      return { ok: true } as const;
    },
    {
      params: t.Object({ id: t.String({ description: "Node id" }) }),
      body: RestartBodySchema,
      response: {
        200: RestartResponseSchema,
        400: "ApiErrorResponse",
        401: "ApiErrorResponse",
        403: "ApiErrorResponse",
        404: "ApiErrorResponse",
        409: "ApiErrorResponse",
      },
      detail: {
        operationId: "restartNode",
        tags: ["nodes"],
        description:
          "Ask an enrolled node's agent to restart (409 when offline, not supervised, too old, or pane-unsafe without force)",
      },
    },
  );
