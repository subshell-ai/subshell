import { Elysia, t } from "elysia";
import { authGuard } from "@/api/auth-guard.js";
import { SshRunViewSchema } from "@/api/ssh/ssh-schemas.js";
import { apiModels } from "@/schema/index.js";
import { buildSshCaller, requireSshPerm } from "@/services/ssh/ssh-actor.js";
import { sshRunList } from "@/services/ssh/ssh-run-reads.service.js";

/**
 * `GET /api/ssh/runs`: the caller's recent runs, newest first, bounded tail.
 * A human sees their own rows; a pane token sees the rows its CURRENT
 * credential initiated (the recovery list for `read_ssh_command` / MCP
 * recovery; runs under an old credential stay invisible to a restarted pane
 * - no grandfathering).
 */
const RunListViewSchema = t.Object({
  runs: t.Array(SshRunViewSchema, { description: "Runs visible to the caller, newest first (bounded recent tail)" }),
});

export const sshListRunsRoute = new Elysia()
  .use(authGuard)
  .use(apiModels)
  .get(
    "/runs",
    async ({ user, actor, principal, apiKeyId, apiKeyPermissions }) => {
      requireSshPerm({ actor, apiKeyPermissions }, "read");
      return await sshRunList(await buildSshCaller({ actor, user, principal, apiKeyId }));
    },
    {
      response: { 200: RunListViewSchema, 401: "ApiErrorResponse", 403: "ApiErrorResponse" },
      detail: {
        operationId: "sshListRuns",
        tags: ["ssh"],
        description: "The caller's recent runs, newest first (owner rows for a human, own-initiated rows for a pane)",
      },
    },
  );
