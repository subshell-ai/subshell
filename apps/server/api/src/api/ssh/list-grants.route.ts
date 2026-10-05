import { Elysia, t } from "elysia";
import { authGuard } from "@/api/auth-guard.js";
import { SshGrantViewSchema } from "@/api/ssh/ssh-schemas.js";
import { apiModels } from "@/schema/index.js";
import { buildSshCaller } from "@/services/ssh/ssh-actor.js";
import { sshListGrants } from "@/services/ssh/ssh-grants.service.js";

/**
 * `GET /api/ssh/connections/:id/grants`: the owner's view of who holds this
 * connection - active rows AND revoked history (grants are history rows by
 * Gate A; the revoked arm is what makes "revoked, never re-granted" readable
 * to the human who revoked it). Machine credentials never reach it (the human
 * gate's cookie arm refuses first).
 */
const GrantListViewSchema = t.Object({
  grants: t.Array(SshGrantViewSchema, {
    description: "Active and revoked grant history for this connection, newest first",
  }),
});

export const sshListGrantsRoute = new Elysia()
  .use(authGuard)
  .use(apiModels)
  .get(
    "/connections/:id/grants",
    async ({ params, user, actor, principal, apiKeyId }) =>
      await sshListGrants(await buildSshCaller({ actor, user, principal, apiKeyId }), params.id),
    {
      params: t.Object({ id: t.String({ description: "Connection id" }) }),
      response: { 200: GrantListViewSchema, 401: "ApiErrorResponse", 403: "ApiErrorResponse", 404: "ApiErrorResponse" },
      detail: {
        operationId: "sshListGrants",
        tags: ["ssh"],
        description: "The connection's grant rows - active and revoked history (owning human only)",
      },
    },
  );
