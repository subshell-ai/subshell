import { Elysia, t } from "elysia";
import { authGuard } from "@/api/auth-guard.js";
import { SshConnectionViewSchema } from "@/api/ssh/ssh-schemas.js";
import { apiModels } from "@/schema/index.js";
import { buildSshCaller, requireSshPerm } from "@/services/ssh/ssh-actor.js";
import { sshListConnections } from "@/services/ssh/ssh-connections.service.js";

/**
 * `GET /api/ssh/connections` (spec §2: "MCP lists only the connections
 * granted to the caller"): the owner's rows for a human cookie; a pane
 * token's projection carries ONLY connections with an active grant bound to
 * its CURRENT key and still-matching revision. Foreign rows never appear in
 * any list, and an ungranted same-owner pane sees an empty list (its sibling
 * status grants it nothing - §2 "Same-owner sibling panes need their own
 * grants").
 */
const ListViewSchema = t.Object({
  connections: t.Array(SshConnectionViewSchema, { description: "Connections visible to the caller, newest first" }),
});

export const sshListConnectionsRoute = new Elysia()
  .use(authGuard)
  .use(apiModels)
  .get(
    "/connections",
    async ({ user, actor, principal, apiKeyId, apiKeyPermissions }) => {
      requireSshPerm({ actor, apiKeyPermissions }, "read");
      return await sshListConnections(await buildSshCaller({ actor, user, principal, apiKeyId }));
    },
    {
      response: { 200: ListViewSchema, 401: "ApiErrorResponse", 403: "ApiErrorResponse" },
      detail: {
        operationId: "sshListConnections",
        tags: ["ssh"],
        description:
          "The connections visible to the caller: the owner's rows for a human, only granted rows for a pane token",
      },
    },
  );
