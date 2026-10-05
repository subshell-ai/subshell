import { Elysia, t } from "elysia";
import { authGuard } from "@/api/auth-guard.js";
import { apiModels } from "@/schema/index.js";
import { assertCookieWriteOrigin, buildSshCaller } from "@/services/ssh/ssh-actor.js";
import { sshRevoke } from "@/services/ssh/ssh-grants.service.js";

/**
 * `DELETE /api/ssh/connections/:id/grants/:subshellId`: the revocation
 * orchestration (spec §2's full sentence): stamp history, stop new dispatch
 * (the granted gate re-asks the ACTIVE row), cancel the runs and terminal
 * fences initiated under THAT grant - human-initiated work and other grants'
 * work are never touched - keep offline cancellation pending for the
 * reconnect pass, and raise the managed panes' control generation so stale
 * queued input refuses AT THE NODE. Live-stream closure rides workstream C's
 * subscription seam (the report's integration request).
 */
const RevokeViewSchema = t.Object({
  revoked: t.Boolean({ description: "True when a live grant was revoked (false when none was active)" }),
});

export const sshRevokeGrantRoute = new Elysia()
  .use(authGuard)
  .use(apiModels)
  .delete(
    "/connections/:id/grants/:subshellId",
    async ({ params, user, actor, principal, apiKeyId, request }) => {
      assertCookieWriteOrigin(actor, request);
      return await sshRevoke(await buildSshCaller({ actor, user, principal, apiKeyId }), params.id, params.subshellId);
    },
    {
      params: t.Object({
        id: t.String({ description: "Connection id" }),
        subshellId: t.String({ description: "The pane whose live grant is revoked" }),
      }),
      response: { 200: RevokeViewSchema, 401: "ApiErrorResponse", 403: "ApiErrorResponse", 404: "ApiErrorResponse" },
      detail: {
        operationId: "sshRevokeGrant",
        tags: ["ssh"],
        description:
          "Revoke the pane's live grant: history stays, new dispatch stops, under-grant runs are cancelled, and queued input is fenced by a raised generation",
      },
    },
  );
