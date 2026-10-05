import { Elysia, t } from "elysia";
import { authGuard } from "@/api/auth-guard.js";
import { SshGrantViewSchema } from "@/api/ssh/ssh-schemas.js";
import { apiModels } from "@/schema/index.js";
import { assertCookieWriteOrigin, buildSshCaller } from "@/services/ssh/ssh-actor.js";
import { sshGrant } from "@/services/ssh/ssh-grants.service.js";

/**
 * `POST /api/ssh/connections/:id/grants` (spec §2, §4 row 3): grant the
 * connection's CURRENT revision to one running pane of the caller's own. The
 * bound credential is read from the pane's row - never from the body - so
 * the grant pins the CURRENT issued key (a restart rotates it and the pane
 * inherits nothing; a human re-grants the restarted pane). Re-granting an
 * already-granted live tuple answers the existing row (the partial unique is
 * the state, not an error case).
 */

const GrantBodySchema = t.Object({
  subshellId: t.String({
    description: "The pane to grant; must be running, and its current issued key is resolved server-side",
  }),
});

export const sshGrantConnectionRoute = new Elysia()
  .use(authGuard)
  .use(apiModels)
  .post(
    "/connections/:id/grants",
    async ({ params, body, user, actor, principal, apiKeyId, request }) => {
      assertCookieWriteOrigin(actor, request);
      return await sshGrant(await buildSshCaller({ actor, user, principal, apiKeyId }), params.id, body);
    },
    {
      params: t.Object({ id: t.String({ description: "Connection id" }) }),
      body: GrantBodySchema,
      response: {
        200: SshGrantViewSchema,
        400: "ApiErrorResponse",
        401: "ApiErrorResponse",
        403: "ApiErrorResponse",
        404: "ApiErrorResponse",
        409: "ApiErrorResponse",
      },
      detail: {
        operationId: "sshGrantConnection",
        tags: ["ssh"],
        description: "Grant the connection's CURRENT revision to one running pane, bound to its current credential",
      },
    },
  );
