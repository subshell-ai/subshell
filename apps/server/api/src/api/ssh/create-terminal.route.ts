import { Elysia, t } from "elysia";
import { authGuard } from "@/api/auth-guard.js";
import { SshTerminalViewSchema } from "@/api/ssh/ssh-schemas.js";
import { apiModels } from "@/schema/index.js";
import { assertCookieWriteOrigin, buildSshCaller, requireSshPerm } from "@/services/ssh/ssh-actor.js";
import { sshTerminalCreate } from "@/services/ssh/ssh-terminals.service.js";

/**
 * `POST /api/ssh/terminals` (spec §4 row 5): open a managed SSH pane on a
 * granted (or owned, for the human) connection. The connecting node must be
 * eligible NOW (refused while offline, and its maintenance flag is the same
 * arm); the pane's foreground process is ssh with no local-shell fallback,
 * and its exit ends the pane. Human-opened panes START in human control,
 * agent-opened ones in agent control (§3); from here on the pane is a private
 * surface whose every generic route consults the SSH policy.
 */

const CreateBodySchema = t.Object({
  connectionId: t.String({ description: "Connection to connect; only IDs, never destination strings" }),
  cols: t.Optional(t.Numeric({ description: "Initial grid columns, when the opener knows one" })),
  rows: t.Optional(t.Numeric({ description: "Initial grid rows" })),
});

export const sshCreateTerminalRoute = new Elysia()
  .use(authGuard)
  .use(apiModels)
  .post(
    "/terminals",
    async ({ body, user, actor, principal, apiKeyId, apiKeyPermissions, request }) => {
      requireSshPerm({ actor, apiKeyPermissions }, "write");
      assertCookieWriteOrigin(actor, request);
      return await sshTerminalCreate(await buildSshCaller({ actor, user, principal, apiKeyId }), body);
    },
    {
      body: CreateBodySchema,
      response: {
        200: SshTerminalViewSchema,
        401: "ApiErrorResponse",
        403: "ApiErrorResponse",
        404: "ApiErrorResponse",
        409: "ApiErrorResponse",
      },
      detail: {
        operationId: "sshOpenTerminal",
        tags: ["ssh"],
        description:
          "Open a managed SSH terminal pane (the node's foreground process is ssh; no local shell fallback, and its exit ends the pane)",
      },
    },
  );
