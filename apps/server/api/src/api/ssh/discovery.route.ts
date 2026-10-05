import { Elysia, t } from "elysia";
import { authGuard } from "@/api/auth-guard.js";
import { apiModels } from "@/schema/index.js";
import { buildSshCaller, requireSshPerm } from "@/services/ssh/ssh-actor.js";
import { sshDiscovery } from "@/services/ssh/ssh-connections.service.js";

/**
 * `GET /api/ssh/discovery?nodeId=` (spec §4 row 1): alias NAMES on a selected
 * eligible node, human cookie only ("Machine credentials cannot call them" -
 * the policy arm says so and the machine arm never dispatches a config read).
 * Names only, never config file contents (§2); `includeCycle` and `truncated`
 * are reviewable facts the human setting up a connection should see.
 */
const QuerySchema = t.Object({
  nodeId: t.String({ description: "The connecting node to parse the account's SSH config on" }),
});

const DiscoveryViewSchema = t.Object({
  aliases: t.Array(t.String({ description: "One alias name" }), {
    description: "Alias names, sorted, wildcard-only excluded",
  }),
  includeCycle: t.Boolean({ description: "An include cycle was detected during the bounded parse" }),
  truncated: t.Boolean({ description: "The alias cap was hit; more exist" }),
});

export const sshDiscoveryRoute = new Elysia()
  .use(authGuard)
  .use(apiModels)
  .get(
    "/discovery",
    async ({ query, user, actor, principal, apiKeyId, apiKeyPermissions }) => {
      requireSshPerm({ actor, apiKeyPermissions }, "read");
      return await sshDiscovery(await buildSshCaller({ actor, user, principal, apiKeyId }), query.nodeId);
    },
    {
      query: QuerySchema,
      response: {
        200: DiscoveryViewSchema,
        401: "ApiErrorResponse",
        403: "ApiErrorResponse",
        404: "ApiErrorResponse",
      },
      detail: {
        operationId: "sshDiscovery",
        tags: ["ssh"],
        description:
          "List SSH config alias names on an eligible connecting node (human cookie only; names, never config contents)",
      },
    },
  );
