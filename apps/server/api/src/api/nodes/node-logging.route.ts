import { BackendErrorCodes } from "@internal/backend-errors";
import { Elysia, t } from "elysia";
import { authGuard, ForbiddenError, requireCookieActor } from "@/api/auth-guard.js";
import { loadNodeGate } from "@/api/nodes/node-gate.js";
import { apiErrorBody } from "@/lib/api-error.js";
import { nodeCanConfigure } from "@/lib/node-access.js";
import { apiModels } from "@/schema/index.js";
import { audit } from "@/services/audit.js";
import { NodeRpcError, sendCommand } from "@/services/nodes/node-rpc.js";

const LoggingBodySchema = t.Object({
  debug: t.Boolean({ description: "Whether debug-level lines reach the agent's own log file" }),
});

const LoggingResponseSchema = t.Object({
  debug: t.Boolean({ description: "The state the agent reported after applying it" }),
});

/**
 * `PUT /api/nodes/:id/logging` — the debug-logging switch for an enrolled
 * node's agent, the node half of `PUT /api/admin/server/logging`.
 *
 * Applied LIVE by the agent (it flips its file transport's level) and
 * persisted in that machine's `config.json`, so a `service restart` — two
 * clicks away on the same card — does not silently end a debug session.
 *
 * **What it reveals today is nothing, and that is deliberate.** The agent has
 * no `logger.debug` call sites. The server's switch has a real payload —
 * `@loglayer/elysia` writes one line per HTTP request at debug, which is why
 * that one needed security accounting about paths carrying setup keys — and an
 * agent serves no HTTP. This is the mechanism in place ahead of the lines
 * (operator's call), so the first debug line anyone writes is already
 * controllable from the browser that is the only way to read a headless node's
 * log at all.
 *
 * Gate: cookie only, owner or `edit` (`nodeCanConfigure`, like the rest of the
 * service surface). NOT owner-only: this changes what a machine writes to its
 * own disk — a bounded, self-replacing 200 KB file — and reverses with the
 * same call. Nothing here can strand a node, which is what makes `stop` and
 * `uninstall` the owner's.
 *
 * `local` → 400, for the reason every node route gives it: the control-plane
 * host has its own switch under Server Settings, with its own gate.
 */
export const nodeLoggingRoute = new Elysia()
  .use(authGuard)
  .use(apiModels)
  .put(
    "/:id/logging",
    async ({ params, body, user, actor, status }) => {
      requireCookieActor(actor, "Node logging control is restricted to browser sessions");
      const gate = await loadNodeGate(user.id, params.id);
      if (!gate) {
        return status(404, apiErrorBody({ code: BackendErrorCodes.NOT_FOUND_ERROR, message: "Node not found" }));
      }
      // BEFORE the permission check, like every route in this group: `local`
      // is a statement about the ROUTE, not about the caller.
      if (gate.row.kind === "local") {
        return status(
          400,
          apiErrorBody({
            code: BackendErrorCodes.BAD_REQUEST,
            message: "The control-plane host's logging is changed from Server Settings, not as a node",
          }),
        );
      }
      if (!nodeCanConfigure(gate.access)) throw new ForbiddenError();
      try {
        await sendCommand(gate.row.id, { type: "set_log_level", debug: body.debug });
      } catch (err) {
        if (err instanceof NodeRpcError) {
          // The agent's own refusal, verbatim — which is how a machine whose
          // environment forces `SUBSHELL_DEBUG_LOGGING` explains itself. A
          // sentence of ours here would be a second, worse description of it.
          return status(409, apiErrorBody({ code: BackendErrorCodes.NODE_UNREACHABLE, message: err.message }));
        }
        throw err;
      }
      await audit({
        actorUserId: user.id,
        action: "node.logging.update",
        targetType: "node",
        targetId: gate.row.id,
        metadataJson: JSON.stringify({ debug: body.debug }),
      });
      return { debug: body.debug };
    },
    {
      params: t.Object({ id: t.String({ description: "Node id" }) }),
      body: LoggingBodySchema,
      response: {
        200: LoggingResponseSchema,
        400: "ApiErrorResponse",
        401: "ApiErrorResponse",
        403: "ApiErrorResponse",
        404: "ApiErrorResponse",
        409: "ApiErrorResponse",
      },
      detail: {
        operationId: "setNodeLogging",
        tags: ["nodes"],
        description:
          "Turn debug-level logging on or off in an enrolled node's agent. Applied live and persisted on that machine; cookie-only, owner or edit; 409 when the node is offline or its environment forces the setting.",
      },
    },
  );
