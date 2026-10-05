import { Elysia, t } from "elysia";
import { authGuard } from "@/api/auth-guard.js";
import { SshRunViewSchema } from "@/api/ssh/ssh-schemas.js";
import { apiModels } from "@/schema/index.js";
import { assertCookieWriteOrigin, buildSshCaller, requireSshPerm } from "@/services/ssh/ssh-actor.js";
import { sshRunCancel } from "@/services/ssh/ssh-run-reads.service.js";

/**
 * `POST /api/ssh/runs/:id/cancel` (spec §3): the REQUEST is the local fact -
 * recorded before anything moves - and the DISPATCH is best-effort. Cancellation
 * stops the node's supervised ssh/helper processes with a bounded grace;
 * `cancelLocalConfirmed` is the honest half of that sentence, and remote
 * descendants are NEVER confirmed by any answer this route can give. An
 * offline node keeps the request pending; the reconnect pass dispatches it
 * before any new work on that machine.
 */
export const sshCancelRunRoute = new Elysia()
  .use(authGuard)
  .use(apiModels)
  .post(
    "/runs/:id/cancel",
    async ({ params, user, actor, principal, apiKeyId, apiKeyPermissions, request }) => {
      requireSshPerm({ actor, apiKeyPermissions }, "write");
      assertCookieWriteOrigin(actor, request);
      return await sshRunCancel(await buildSshCaller({ actor, user, principal, apiKeyId }), params.id);
    },
    {
      params: t.Object({ id: t.String({ description: "Run id (opaque, server-allocated)" }) }),
      response: {
        200: SshRunViewSchema,
        401: "ApiErrorResponse",
        403: "ApiErrorResponse",
        404: "ApiErrorResponse",
        409: "ApiErrorResponse",
      },
      detail: {
        operationId: "sshCancelRun",
        tags: ["ssh"],
        description:
          "Request cancellation: recorded locally first, relayed best-effort; offline it stays pending and dispatches before new work on reconnect (remote descendants are never confirmed)",
      },
    },
  );
