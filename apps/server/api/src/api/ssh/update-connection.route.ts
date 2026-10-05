import { Elysia, t } from "elysia";
import { authGuard } from "@/api/auth-guard.js";
import { SshConnectionViewSchema, SshSnapshotSchema } from "@/api/ssh/ssh-schemas.js";
import { apiModels } from "@/schema/index.js";
import { assertCookieWriteOrigin, buildSshCaller } from "@/services/ssh/ssh-actor.js";
import { sshUpdateConnection } from "@/services/ssh/ssh-connections.service.js";

/**
 * `PATCH /api/ssh/connections/:id` (spec §2's revision rule): a snapshot-
 * bearing edit re-validates through the frozen grammar and moves the snapshot
 * AND the revision in ONE statement, so no grant ever observes new config
 * under an old number. Every edit - even a label change - is refused while
 * runs or managed terminals are active (the human must stop or finish first).
 * Prior-revision grants are invalidated BY REVISION MISMATCH, not by cascade:
 * the rows stay as history (`ssh_grants` rows are history by Gate A).
 */

const UpdateBodySchema = t.Object({
  displayName: t.Optional(t.String({ description: "New display label; omitted = unchanged" })),
  remoteDir: t.Optional(t.Nullable(t.String({ description: "New remote-directory default; null clears it" }))),
  snapshot: t.Optional(SshSnapshotSchema),
});

export const sshUpdateConnectionRoute = new Elysia()
  .use(authGuard)
  .use(apiModels)
  .patch(
    "/connections/:id",
    async ({ params, body, user, actor, principal, apiKeyId, request }) => {
      assertCookieWriteOrigin(actor, request);
      return await sshUpdateConnection(await buildSshCaller({ actor, user, principal, apiKeyId }), params.id, body);
    },
    {
      params: t.Object({ id: t.String({ description: "Connection id" }) }),
      body: UpdateBodySchema,
      response: {
        200: SshConnectionViewSchema,
        400: "ApiErrorResponse",
        401: "ApiErrorResponse",
        403: "ApiErrorResponse",
        404: "ApiErrorResponse",
        409: "ApiErrorResponse",
      },
      detail: {
        operationId: "sshUpdateConnection",
        tags: ["ssh"],
        description:
          "Edit a connection: refused while runs or managed terminals are active; a snapshot edit bumps the revision atomically and invalidates prior-revision grants",
      },
    },
  );
