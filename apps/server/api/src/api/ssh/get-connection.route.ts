import { Elysia, t } from "elysia";
import { authGuard } from "@/api/auth-guard.js";
import { SshConnectionViewSchema } from "@/api/ssh/ssh-schemas.js";
import { apiModels } from "@/schema/index.js";
import { buildSshCaller, requireSshPerm } from "@/services/ssh/ssh-actor.js";
import { sshGetConnection } from "@/services/ssh/ssh-connections.service.js";

/**
 * `GET /api/ssh/connections/:id`: the owner's detail read for a human (plain
 * ownership - the row's own predicate), the granted pane's rechecked read
 * through `gateGrantedUse` (token, pane, grant, revision - §2's full
 * sentence). A foreign or ungranted row answers the non-enumerating 404.
 */
export const sshGetConnectionRoute = new Elysia()
  .use(authGuard)
  .use(apiModels)
  .get(
    "/connections/:id",
    async ({ params, user, actor, principal, apiKeyId, apiKeyPermissions }) => {
      requireSshPerm({ actor, apiKeyPermissions }, "read");
      return await sshGetConnection(await buildSshCaller({ actor, user, principal, apiKeyId }), params.id);
    },
    {
      params: t.Object({ id: t.String({ description: "Connection id" }) }),
      response: {
        200: SshConnectionViewSchema,
        401: "ApiErrorResponse",
        403: "ApiErrorResponse",
        404: "ApiErrorResponse",
      },
      detail: {
        operationId: "sshGetConnection",
        tags: ["ssh"],
        description: "Read one visible connection with its current approved snapshot",
      },
    },
  );
