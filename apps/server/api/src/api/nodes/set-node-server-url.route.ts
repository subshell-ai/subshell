import { BackendErrorCodes } from "@internal/backend-errors";
import { Elysia, t } from "elysia";
import { authGuard, ForbiddenError, requireCookieActor } from "@/api/auth-guard.js";
import { loadNodeGate } from "@/api/nodes/node-gate.js";
import { isLoopbackUrl } from "@/commands/config-values.js";
import { apiErrorBody } from "@/lib/api-error.js";
import { apiModels } from "@/schema/index.js";
import { audit } from "@/services/audit.js";
import { NodeRpcError, sendCommand } from "@/services/nodes/node-rpc.js";

const ConfigBodySchema = t.Object({
  serverUrl: t.String({
    description: "The control-plane base URL this node should dial (http(s), never a loopback address)",
  }),
});

const ConfigResponseSchema = t.Object({
  serverUrl: t.String({ description: "The address as the node stored it" }),
  restartRequired: t.Literal(true, {
    description: "The new address takes effect when the node restarts; this call does not restart it",
  }),
});

/**
 * Validate and canonicalize the address before anything is sent.
 *
 * By COMPONENT rather than by `url.origin === value`, the same rule
 * `config-values.ts` documents for trusted origins: a trailing slash, a
 * mixed-case host and an expanded IPv6 form are all spellings of an address a
 * node can perfectly well dial, and refusing them would be refusing a typo
 * that is not one.
 *
 * @returns the address to store, or a sentence saying why it cannot be used
 */
export function validateNodeServerUrl(value: string): { url: string } | { error: string } {
  let parsed: URL;
  try {
    parsed = new URL(value.trim());
  } catch {
    return { error: "That is not a URL; give the control plane's address, like https://subshell.example.com" };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { error: `A node dials http or https, not ${parsed.protocol.replace(":", "")}` };
  }
  if (parsed.username !== "" || parsed.password !== "") {
    return { error: "Credentials in the address are refused; a node authenticates with its node key" };
  }
  // The enroll-time loopback trap, and worse here: nobody is sitting at a
  // headless machine to notice that it started dialing itself. The Nodes page
  // already warns about this at enroll; from a browser it has to be a refusal.
  if (isLoopbackUrl(parsed.href)) {
    return {
      error:
        "That is a loopback address, so the node would dial itself rather than this server; give the address other machines use",
    };
  }
  // Origin plus path, because a plane can live behind a proxy subpath — but
  // never a query or a fragment, which no base URL carries.
  const path = parsed.pathname.replace(/\/+$/, "");
  return { url: `${parsed.origin}${path}` };
}

/**
 * `PATCH /api/nodes/:id/config` — repoint an enrolled node at another control
 * plane (spec 2026-09-12, node half § 5).
 *
 * **OWNER ONLY, and that is the one gate in this group that is not
 * `nodeCanConfigure`.** `docs/security.md` calls `subshell configure --server`
 * deliberately unprivileged, and locally it is: it edits a 0600 file the local
 * user already owns. Doing it REMOTELY is a different act. The node then dials
 * whatever host was typed with `Authorization: Bearer <nodeKey>`, disclosing a
 * credential valid on THIS plane to that host, and the machine leaves this
 * instance. An `edit` grantee is trusted to interrupt a machine they were
 * shared; making it someone else's machine is not that.
 *
 * The address is validated and canonicalized here AND re-normalized by the
 * node (`runConfigure` shares `normalizeServer` with enroll), so the two
 * cannot disagree about a spelling.
 *
 * **It does not restart the node.** The new address takes effect on the next
 * start, and choosing when is the operator's — a machine that vanished
 * mid-request because it silently re-dialed elsewhere is the surprise this
 * whole surface exists to remove.
 */
export const setNodeServerUrlRoute = new Elysia()
  .use(authGuard)
  .use(apiModels)
  .patch(
    "/:id/config",
    async ({ params, body, user, actor, status }) => {
      requireCookieActor(actor, "Node configuration is restricted to browser sessions");
      const gate = await loadNodeGate(user.id, params.id);
      if (!gate) {
        return status(404, apiErrorBody({ code: BackendErrorCodes.NOT_FOUND_ERROR, message: "Node not found" }));
      }
      // BEFORE the permission check: `local` is a statement about the ROUTE,
      // not about the caller. A 403 here would send someone looking for an
      // owner to ask, when the truth is that this surface never applies to the
      // control-plane host.
      if (gate.row.kind === "local") {
        return status(
          400,
          apiErrorBody({
            code: BackendErrorCodes.BAD_REQUEST,
            message: "The control-plane host is configured from Server Settings, not as a node",
          }),
        );
      }
      if (gate.access !== "owner") throw new ForbiddenError();

      const checked = validateNodeServerUrl(body.serverUrl);
      if ("error" in checked) {
        return status(400, apiErrorBody({ code: BackendErrorCodes.INPUT_VALIDATION_ERROR, message: checked.error }));
      }

      try {
        await sendCommand(gate.row.id, { type: "set_server_url", url: checked.url });
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
              ? "This node's binary predates remote configuration; run `subshell configure --server` on that machine"
              : err.message;
          return status(409, apiErrorBody({ code, message }));
        }
        throw err;
      }

      // The new value only. The server's own config writes audit `{key, from,
      // to}`, but this plane does not know the `from`: which address a node
      // dials lives in that machine's `config.json` and is reported by nothing
      // on the wire. Recording a `from` would mean inventing one. No secret
      // either way — the node key is never part of this exchange.
      await audit({
        actorUserId: user.id,
        action: "node.config.update",
        targetType: "node",
        targetId: gate.row.id,
        metadataJson: JSON.stringify({ key: "serverUrl", to: checked.url }),
      });
      return { serverUrl: checked.url, restartRequired: true } as const;
    },
    {
      params: t.Object({ id: t.String({ description: "Node id" }) }),
      body: ConfigBodySchema,
      response: {
        200: ConfigResponseSchema,
        400: "ApiErrorResponse",
        401: "ApiErrorResponse",
        403: "ApiErrorResponse",
        404: "ApiErrorResponse",
        409: "ApiErrorResponse",
      },
      detail: {
        operationId: "setNodeServerUrl",
        tags: ["nodes"],
        description:
          "Repoint an enrolled node at another control plane (owner only; never the local node; takes effect on the node's next restart)",
      },
    },
  );
