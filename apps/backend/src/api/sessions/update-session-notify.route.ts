import { Elysia, t } from "elysia";
import { authGuard, HttpError, requirePerm } from "@/api/auth-guard.js";
import { contextPlugin } from "@/plugins/context.plugin.js";
import { apiModels } from "@/schema/index.js";

const NotifyBodySchema = t.Object({
  notify: t.Boolean({ description: "true = ring this session; false = silent" }),
});

const OkResponseSchema = t.Object({ ok: t.Boolean({ description: "Always true" }) });

/** `PATCH /api/sessions/:id/notify` — the ⋯-menu bell toggle (owner cookie or the session's own key). */
export const updateSessionNotifyRoute = new Elysia()
  .use(contextPlugin)
  .use(authGuard)
  .use(apiModels)
  .patch(
    "/:id/notify",
    async ({ params, body, user, actor, principal, apiKeyPermissions, ctx }) => {
      requirePerm({ actor, apiKeyPermissions }, "sessions", "write");
      // requirePerm is scope-wide, not per-row: a session key holds
      // sessions:write for ITS session, so the cross-row check lives here
      // (same self-only rule as extend-token).
      if (actor === "session-key" && principal !== `sess:${params.id}`) {
        throw new HttpError(403, "A session token may only toggle its own session's bell");
      }
      // Owner-only, enforced inside the service: a foreign/invisible session
      // is a 404 (no existence leak), a view/edit grantee a 403 (visible, but
      // the bell is the owner's to change).
      await ctx.services.sessions.setSessionNotify(user.id, params.id, body.notify, actor);
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
        operationId: "setSessionNotify",
        tags: ["sessions"],
        description: "Enable or disable push notifications for a session",
      },
    },
  );
