import { Elysia, t } from "elysia";
import { authGuard, HttpError, requirePerm } from "@/api/auth-guard.js";
import { contextPlugin } from "@/plugins/context.plugin.js";
import { apiModels } from "@/schema/index.js";

const AttentionBodySchema = t.Object({
  kind: t.Union([t.Literal("turn_complete"), t.Literal("needs_attention")], {
    description: "What the harness is reporting: the turn finished, or it needs the operator",
  }),
});

const OkResponseSchema = t.Object({ ok: t.Boolean({ description: "Always true" }) });

/**
 * `POST /api/sessions/:id/attention` — the harness self-report endpoint the
 * injected hooks call. Session-key-only and self-scoped (the same rule as
 * /name and /notes): a harness may ring its OWN session's bell, never
 * another's, and browsers have no reason to be here (they get the state via
 * the session feed).
 */
export const sessionAttentionRoute = new Elysia()
  .use(contextPlugin)
  .use(authGuard)
  .use(apiModels)
  .post(
    "/:id/attention",
    async ({ params, body, actor, principal, apiKeyPermissions, ctx }) => {
      requirePerm({ actor, apiKeyPermissions }, "sessions", "write");
      // requirePerm is scope-wide, not per-row: a session key holds
      // sessions:write for ITS session, so the cross-row check lives here —
      // and unlike /name, the cookie actor is turned away entirely: this is
      // the harness talking, not a browser.
      if (actor !== "session-key" || principal !== `sess:${params.id}`) {
        throw new HttpError(403, "Only a session's own key may report attention");
      }
      await ctx.services.sessions.recordAttention(params.id, body.kind);
      return { ok: true } as const;
    },
    {
      body: AttentionBodySchema,
      response: {
        200: OkResponseSchema,
        400: "ApiErrorResponse",
        401: "ApiErrorResponse",
        403: "ApiErrorResponse",
        404: "ApiErrorResponse",
      },
      detail: {
        operationId: "reportSessionAttention",
        tags: ["sessions"],
        description: "Harness self-report: waiting for the operator",
      },
    },
  );
