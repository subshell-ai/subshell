import { BackendErrorCodes } from "@internal/backend-errors";
import { parseNodeAgentLogSlice } from "@internal/subshell-protocol";
import { Elysia, t } from "elysia";
import { authGuard, ForbiddenError, requireCookieActor } from "@/api/auth-guard.js";
import { loadNodeGate } from "@/api/nodes/node-gate.js";
import { apiErrorBody } from "@/lib/api-error.js";
import { nodeCanConfigure } from "@/lib/node-access.js";
import { apiModels } from "@/schema/index.js";
import { NodeRpcError, sendCommand } from "@/services/nodes/node-rpc.js";

/**
 * How much of a node's log one request may pull.
 *
 * Smaller than the node's own 200 KB file cap, because this is a poll: the
 * view holds an offset and asks for what arrived since, and a first read of a
 * full file is the only one that ever reaches this ceiling.
 */
const MAX_READ_BYTES = 65_536;

const LogsQuerySchema = t.Object({
  fromByte: t.Optional(t.Numeric({ default: 0, description: "Byte offset to read from; 0 is the start of the file" })),
  maxBytes: t.Optional(
    t.Numeric({ default: MAX_READ_BYTES, description: `Cap on bytes returned (clamped to ${MAX_READ_BYTES})` }),
  ),
});

const LogsViewSchema = t.Object({
  text: t.String({ description: "The bytes read, decoded as UTF-8 (JSON lines, one log call each)" }),
  nextByte: t.Number({ description: "Offset to pass as fromByte on the next read" }),
  size: t.Number({ description: "The file's total size when it was read" }),
  truncated: t.Boolean({
    description: "True when fromByte pointed past the end: the file was replaced at its cap; start over from 0",
  }),
});

/**
 * `GET /api/nodes/:id/logs` — read a slice of an enrolled node's own log
 * (spec 2026-09-12, node half § 4).
 *
 * **This is the only way to read a headless node's log.** The node's console
 * output goes wherever the platform's service manager puts it — a file under
 * launchd, the journal under systemd, nowhere in particular in a container —
 * so the node also writes one bounded file of its own, and this serves that.
 *
 * Gate: cookie only, owner or `edit` — the same gate the runtime report itself
 * carries, and for the same reason. A `view` grantee may launch subshells here;
 * what this machine logged about itself is not their business.
 *
 * A READ, so it is not audited. It is also not a pane log: those hold what an
 * operator typed, live on a different path, and are reached through a different
 * command whose name deliberately does not resemble this one.
 */
export const nodeLogsRoute = new Elysia()
  .use(authGuard)
  .use(apiModels)
  .get(
    "/:id/logs",
    async ({ params, query, user, actor, status }) => {
      requireCookieActor(actor, "Node logs are restricted to browser sessions");
      const gate = await loadNodeGate(user.id, params.id);
      if (!gate) {
        return status(404, apiErrorBody({ code: BackendErrorCodes.NOT_FOUND_ERROR, message: "Node not found" }));
      }
      // BEFORE the permission check — `local` is about the route, not the caller.
      if (gate.row.kind === "local") {
        return status(
          400,
          apiErrorBody({
            code: BackendErrorCodes.BAD_REQUEST,
            message: "The control-plane host's own log is at Server Settings → Service, not here",
          }),
        );
      }
      if (!nodeCanConfigure(gate.access)) throw new ForbiddenError();

      const fromByte = Math.max(0, Math.trunc(query.fromByte ?? 0));
      const maxBytes = Math.min(MAX_READ_BYTES, Math.max(1, Math.trunc(query.maxBytes ?? MAX_READ_BYTES)));
      try {
        const answer = await sendCommand(gate.row.id, { type: "agent_log_read", fromByte, maxBytes });
        const slice = parseNodeAgentLogSlice(answer);
        if (!slice) {
          // A malformed answer is the node's problem, not the reader's — and
          // it must not reach the page as a half-parsed object.
          return status(
            502,
            apiErrorBody({
              code: BackendErrorCodes.NODE_UNREACHABLE,
              message: "That node answered with a log slice this server could not read",
            }),
          );
        }
        return slice;
      } catch (err) {
        if (err instanceof NodeRpcError) {
          const code =
            err.code === "offline"
              ? BackendErrorCodes.NODE_OFFLINE
              : err.code === "unsupported"
                ? BackendErrorCodes.NODE_AGENT_TOO_OLD
                : BackendErrorCodes.NODE_UNREACHABLE;
          const message =
            err.code === "unsupported"
              ? "This node's binary predates the log command; update the node on that machine to read its log here"
              : err.message;
          return status(409, apiErrorBody({ code, message }));
        }
        throw err;
      }
    },
    {
      params: t.Object({ id: t.String({ description: "Node id" }) }),
      query: LogsQuerySchema,
      response: {
        200: LogsViewSchema,
        400: "ApiErrorResponse",
        401: "ApiErrorResponse",
        403: "ApiErrorResponse",
        404: "ApiErrorResponse",
        409: "ApiErrorResponse",
        502: "ApiErrorResponse",
      },
      detail: {
        operationId: "nodeLogs",
        tags: ["nodes"],
        description: "Read a byte range of an enrolled node's own log (owner or edit; never the local node)",
      },
    },
  );
