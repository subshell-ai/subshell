import { Elysia, t } from "elysia";
import { authGuard } from "@/api/auth-guard.js";
import { SshRunViewSchema } from "@/api/ssh/ssh-schemas.js";
import { apiModels } from "@/schema/index.js";
import { buildSshCaller, requireSshPerm } from "@/services/ssh/ssh-actor.js";
import { sshRunGet } from "@/services/ssh/ssh-run-reads.service.js";

/**
 * `GET /api/ssh/runs/:id`: the plane's current mirror of one run's facts -
 * lifecycle plus SEPARATE cancellation and deadline facts (`completed` may
 * also carry `cancelRequested`; `unknown` is never dressed as failed or
 * successful). Run IDs are scoped by authorization, never bearer capabilities
 * (spec §4): the granted pane can read only runs its own current credential
 * initiated under a live grant.
 */
export const sshGetRunRoute = new Elysia()
  .use(authGuard)
  .use(apiModels)
  .get(
    "/runs/:id",
    async ({ params, user, actor, principal, apiKeyId, apiKeyPermissions }) => {
      requireSshPerm({ actor, apiKeyPermissions }, "read");
      return await sshRunGet(await buildSshCaller({ actor, user, principal, apiKeyId }), params.id);
    },
    {
      params: t.Object({ id: t.String({ description: "Run id (opaque, server-allocated)" }) }),
      response: { 200: SshRunViewSchema, 401: "ApiErrorResponse", 403: "ApiErrorResponse", 404: "ApiErrorResponse" },
      detail: {
        operationId: "sshGetRun",
        tags: ["ssh"],
        description: "One run's current facts from the plane's mirror (unknown is reported as unknown)",
      },
    },
  );
