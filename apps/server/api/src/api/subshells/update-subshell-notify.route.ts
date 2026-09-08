import { Elysia, t } from "elysia";
import { authGuard, HttpError, requirePerm } from "@/api/auth-guard.js";
import { contextPlugin } from "@/plugins/context.plugin.js";
import { apiModels } from "@/schema/index.js";

const NotifyBodySchema = t.Object({
  notify: t.Boolean({ description: "true = ring this subshell; false = silent" }),
});

const OkResponseSchema = t.Object({ ok: t.Boolean({ description: "Always true" }) });

/** `PATCH /api/subshells/:id/notify` — the ⋯-menu bell toggle (owner cookie or the subshell's own key). */
export const updateSubshellNotifyRoute = new Elysia()
  .use(contextPlugin)
  .use(authGuard)
  .use(apiModels)
  .patch(
    "/:id/notify",
    async ({ params, body, user, actor, principal, apiKeyPermissions, ctx }) => {
      requirePerm({ actor, apiKeyPermissions }, "subshells", "write");
      // requirePerm is scope-wide, not per-row: a subshell key holds
      // subshells:write for ITS subshell, so the cross-row check lives here
      // (same self-only rule as extend-token).
      if (actor === "subshell-key" && principal !== `sess:${params.id}`) {
        throw new HttpError(403, "A subshell token may only toggle its own subshell's bell");
      }
      // Owner-only, enforced inside the service: a foreign/invisible subshell
      // is a 404 (no existence leak), a view/edit grantee a 403 (visible, but
      // the bell is the owner's to change).
      await ctx.services.subshells.setSubshellNotify(user.id, params.id, body.notify, actor);
      return { ok: true } as const;
    },
    {
      body: NotifyBodySchema,
      response: {
        200: OkResponseSchema,
        400: "ApiErrorResponse",
        401: "ApiErrorResponse",
        403: "ApiErrorResponse",
        404: "ApiErrorResponse",
      },
      detail: {
        operationId: "setSubshellNotify",
        tags: ["subshells"],
        description: "Enable or disable push notifications for a subshell",
      },
    },
  );
