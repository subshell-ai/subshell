import { Elysia, t } from "elysia";
import { authGuard } from "@/api/auth-guard.js";
import { apiModels } from "@/schema/index.js";
import { assertCookieWriteOrigin, buildSshCaller } from "@/services/ssh/ssh-actor.js";
import { sshDeleteConnection } from "@/services/ssh/ssh-connections.service.js";

/**
 * `DELETE /api/ssh/connections/:id` (spec §4: "deletion refused while work is
 * active"). Runs outlive it via their SET NULL columns plus the immutable
 * snapshot copy each row keeps; grant rows cascade with the connection (they
 * are the live binding, not the durable fact - `ssh_runs.api_key_id` is);
 * managed panes can only cascade once dead, because the refusal keeps live
 * ones from ever being orphaned.
 */
const DeleteViewSchema = t.Object({ deleted: t.Literal(true) });

export const sshDeleteConnectionRoute = new Elysia()
  .use(authGuard)
  .use(apiModels)
  .delete(
    "/connections/:id",
    async ({ params, user, actor, principal, apiKeyId, request }) => {
      assertCookieWriteOrigin(actor, request);
      return await sshDeleteConnection(await buildSshCaller({ actor, user, principal, apiKeyId }), params.id);
    },
    {
      params: t.Object({ id: t.String({ description: "Connection id" }) }),
      response: {
        200: DeleteViewSchema,
        401: "ApiErrorResponse",
        403: "ApiErrorResponse",
        404: "ApiErrorResponse",
        409: "ApiErrorResponse",
      },
      detail: {
        operationId: "sshDeleteConnection",
        tags: ["ssh"],
        description:
          "Delete a connection; refused while its runs or managed terminals are active (retained run history keeps its immutable snapshot)",
      },
    },
  );
