import { Elysia, t } from "elysia";
import { authGuard } from "@/api/auth-guard.js";
import { SshConnectionViewSchema, SshSnapshotSchema } from "@/api/ssh/ssh-schemas.js";
import { apiModels } from "@/schema/index.js";
import { assertCookieWriteOrigin, buildSshCaller } from "@/services/ssh/ssh-actor.js";
import { sshCreateConnection } from "@/services/ssh/ssh-connections.service.js";

/**
 * `POST /api/ssh/connections` (spec §4 row 2): save a resolved snapshot as a
 * private connection at revision 1. Human cookie only (writes are the §4
 * caller rule), origin-validated (§2's explicit write check), and the
 * snapshot re-validated by the server's copy of the frozen grammar BEFORE it
 * is stored - the human's approval is a review step, not the load-bearing
 * defense.
 */

const CreateBodySchema = t.Object({
  nodeId: t.String({ description: "Connecting node id; the caller's own node (or local for admins, per §2)" }),
  displayName: t.String({ description: "Display label (normalized and capped server-side)" }),
  snapshot: SshSnapshotSchema,
  remoteDir: t.Optional(t.Nullable(t.String({ description: "Optional absolute remote start directory" }))),
});

export const sshCreateConnectionRoute = new Elysia()
  .use(authGuard)
  .use(apiModels)
  .post(
    "/connections",
    async ({ body, user, actor, principal, apiKeyId, request }) => {
      assertCookieWriteOrigin(actor, request);
      return await sshCreateConnection(await buildSshCaller({ actor, user, principal, apiKeyId }), body);
    },
    {
      body: CreateBodySchema,
      response: {
        200: SshConnectionViewSchema,
        400: "ApiErrorResponse",
        401: "ApiErrorResponse",
        403: "ApiErrorResponse",
        404: "ApiErrorResponse",
      },
      detail: {
        operationId: "sshCreateConnection",
        tags: ["ssh"],
        description:
          "Save a human-approved snapshot as a private connection at revision 1 (the server re-runs the grammar before storing)",
      },
    },
  );
