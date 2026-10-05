import { Elysia, t } from "elysia";
import { authGuard } from "@/api/auth-guard.js";
import { SshErrorCodeSchema, SshSnapshotSchema } from "@/api/ssh/ssh-schemas.js";
import { apiModels } from "@/schema/index.js";
import { assertCookieWriteOrigin, buildSshCaller } from "@/services/ssh/ssh-actor.js";
import { sshTestConnection } from "@/services/ssh/ssh-connections.service.js";

/**
 * `POST /api/ssh/connections/test` (spec §4 row 2): the node's FIXED benign
 * probe against an approved snapshot. There is no caller-supplied probe text
 * anywhere in this contract (§3: "Connection testing uses a fixed benign
 * probe, not caller-supplied command text"), the probe carries the 30-second
 * overall deadline and no automatic retry, and a failed test is a 200 with a
 * named code - "it failed" is an answer, not a transport error.
 */

const TestBodySchema = t.Object({
  nodeId: t.String({ description: "The connecting node to run the probe on" }),
  snapshot: SshSnapshotSchema,
});

const TestViewSchema = t.Union([
  t.Object({ passed: t.Literal(true) }),
  t.Object({ passed: t.Literal(false), code: SshErrorCodeSchema }),
]);

export const sshTestConnectionRoute = new Elysia()
  .use(authGuard)
  .use(apiModels)
  .post(
    "/connections/test",
    async ({ body, user, actor, principal, apiKeyId, request }) => {
      assertCookieWriteOrigin(actor, request);
      return await sshTestConnection(await buildSshCaller({ actor, user, principal, apiKeyId }), body);
    },
    {
      body: TestBodySchema,
      response: {
        200: TestViewSchema,
        400: "ApiErrorResponse",
        401: "ApiErrorResponse",
        403: "ApiErrorResponse",
        404: "ApiErrorResponse",
      },
      detail: {
        operationId: "sshTestConnection",
        tags: ["ssh"],
        description:
          "Probe a snapshot with the node's fixed connect-and-exit check (30 s overall deadline, no caller command text, no retry)",
      },
    },
  );
