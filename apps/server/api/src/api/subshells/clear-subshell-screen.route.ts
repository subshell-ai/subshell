import { Elysia, t } from "elysia";
import { authGuard, requirePerm } from "@/api/auth-guard.js";
import { contextPlugin } from "@/api/middleware/context.plugin.js";
import { apiModels } from "@/api/schemas/index.js";

/**
 * `DELETE /api/subshells/:id/screen` — turn a live subshell's virtual display
 * off (spec 2026-11-06): the desired state clears first, then the node closes
 * the display and frees its memory and CPU; the pane keeps running. Idempotent
 * by design — a pane with no display answers success, and the close command
 * rides every call so a repeated off converges after a dropped one. The
 * visibility, access, ssh, and offline refusals all land before anything is
 * written; a node that fails mid-call 409s after the clear, and the row stays
 * cleared so a repeat off finishes the job.
 */
export const clearSubshellScreenRoute = new Elysia()
  .use(contextPlugin)
  .use(authGuard)
  .use(apiModels)
  .delete(
    "/:id/screen",
    async ({ params, user, actor, apiKeyPermissions, ctx }) => {
      requirePerm({ actor, apiKeyPermissions }, "subshells", "write");
      return await ctx.services.subshells.clearSubshellScreen(user.id, params.id, actor);
    },
    {
      response: {
        200: t.Object({
          ok: t.Literal(true, { description: "The desired screen state is cleared" }),
          closed: t.Boolean({ description: "Whether a display was actually allocated and has been torn down" }),
        }),
        401: "ApiErrorResponse",
        403: "ApiErrorResponse",
        404: "ApiErrorResponse",
        409: "ApiErrorResponse",
      },
      systemPermission: "subshells:execute",
      detail: {
        operationId: "clearSubshellScreen",
        tags: ["subshells"],
        description:
          "End this subshell's virtual display while it keeps running: clears the saved screen and closes the allocated display, freeing its memory and CPU. Repeat-safe",
      },
    },
  );
