import { Elysia, t } from "elysia";
import { authGuard, requirePerm } from "@/api/auth-guard.js";
import { contextPlugin } from "@/api/middleware/context.plugin.js";
import { apiModels } from "@/api/schemas/index.js";
import { VirtualDisplayRequestSchema } from "@/api/schemas/virtual-display.js";

/**
 * `PUT /api/subshells/:id/screen` — turn a live subshell's virtual display on
 * (spec 2026-11-06): the request becomes the row's desired screen state and
 * the subshell restarts in place to pick it up (same id, log retained, the
 * conversation resumes when the harness supports resume). A refusal at any
 * gate (visibility, edit access, ssh pane, the node being offline, a display
 * already live for the pane, the node's own display policy) writes nothing.
 */
export const setSubshellScreenRoute = new Elysia()
  .use(contextPlugin)
  .use(authGuard)
  .use(apiModels)
  .put(
    "/:id/screen",
    async ({ params, body, user, actor, apiKeyPermissions, systemKeyPermissions, ctx }) => {
      requirePerm({ actor, apiKeyPermissions }, "subshells", "write");
      return await ctx.services.subshells.setSubshellScreen(
        user.id,
        params.id,
        { width: body.width, height: body.height, ...(body.provider ? { provider: body.provider } : {}) },
        actor,
        systemKeyPermissions,
      );
    },
    {
      body: VirtualDisplayRequestSchema,
      response: {
        200: t.Object({
          ok: t.Literal(true, { description: "The display was set as desired state and the restart started" }),
          screen: t.Object({
            width: t.Number({ description: "The persisted display width" }),
            height: t.Number({ description: "The persisted display height" }),
            provider: t.String({ description: "The provider the plane pinned for this subshell" }),
          }),
        }),
        // Body validation: width/height outside 320..4096 or a malformed
        // provider id (INPUT_VALIDATION_ERROR). Nothing was read or written.
        400: "ApiErrorResponse",
        401: "ApiErrorResponse",
        403: "ApiErrorResponse",
        404: "ApiErrorResponse",
        409: "ApiErrorResponse",
      },
      systemPermission: "subshells:execute",
      detail: {
        operationId: "setSubshellScreen",
        tags: ["subshells"],
        description:
          "Give this subshell a virtual display now: stores the screen request as desired state and restarts the subshell in place so its process starts with the display. Refused while the node is offline or when a display is already live; a gate refusal writes nothing (a restart that fails after its kill leaves the pane stopped, with the request rolled back)",
      },
    },
  );
