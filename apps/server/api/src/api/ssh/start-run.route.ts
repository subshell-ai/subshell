import { Elysia, t } from "elysia";
import { authGuard } from "@/api/auth-guard.js";
import { SshRunViewSchema } from "@/api/ssh/ssh-schemas.js";
import { apiModels } from "@/schema/index.js";
import { assertCookieWriteOrigin, buildSshCaller, requireSshPerm } from "@/services/ssh/ssh-actor.js";
import { sshRunStart } from "@/services/ssh/ssh-runs.service.js";

/**
 * `POST /api/ssh/runs` (spec §4 row 4): start one structured command against
 * a granted (human-owned, human-run) connection. Only connection IDs are
 * accepted here (spec §2: agent requests never carry hosts, usernames, ports,
 * options, environment overrides, config paths, or proxy commands); the
 * command text is the ONE intentional shell code, capped at the wire limit.
 *
 * Durable dispatch (spec §3): the ID is server-allocated and the complete
 * request digest-bound before the frame moves; the node records acceptance
 * before spawning; a duplicate delivery returns the existing state and a
 * different payload under the same ID is refused (`run_conflict`, equality-
 * matched, never a second spawn). The answer is prompt - the run outlives
 * this call.
 */

const StartBodySchema = t.Object({
  connectionId: t.String({ description: "Connection to run on; only IDs, never raw destinations" }),
  command: t.String({ description: "The remote command: the one intentional shell code in this contract" }),
  remoteDir: t.Optional(
    t.Nullable(t.String({ description: "Per-run absolute remote directory; null = destination login default" })),
  ),
  deadlineMs: t.Optional(t.Number({ description: "Execution deadline ms; server-clamped (default 5 min, max 1 h)" })),
});

export const sshStartRunRoute = new Elysia()
  .use(authGuard)
  .use(apiModels)
  .post(
    "/runs",
    async ({ body, user, actor, principal, apiKeyId, apiKeyPermissions, request }) => {
      requireSshPerm({ actor, apiKeyPermissions }, "write");
      assertCookieWriteOrigin(actor, request);
      return await sshRunStart(await buildSshCaller({ actor, user, principal, apiKeyId }), body);
    },
    {
      body: StartBodySchema,
      response: {
        200: SshRunViewSchema,
        400: "ApiErrorResponse",
        401: "ApiErrorResponse",
        403: "ApiErrorResponse",
        404: "ApiErrorResponse",
        409: "ApiErrorResponse",
      },
      detail: {
        operationId: "sshStartRun",
        tags: ["ssh"],
        description:
          "Start a structured SSH command against a granted connection; the run id returns promptly and the node supervises the rest (a duplicate id is refused, never re-run)",
      },
    },
  );
