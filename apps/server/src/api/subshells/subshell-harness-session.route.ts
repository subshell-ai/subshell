import { Elysia, t } from "elysia";
import { authGuard, HttpError, requirePerm } from "@/api/auth-guard.js";
import { contextPlugin } from "@/plugins/context.plugin.js";
import { apiModels } from "@/schema/index.js";

/** Claude Code session ids are v4 UUIDs; anything else never resumes. */
const UUID_PATTERN = "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$";

const HarnessSessionBodySchema = t.Object({
  sessionId: t.String({
    pattern: UUID_PATTERN,
    description: "The harness conversation id the pane is now running",
  }),
});

const OkResponseSchema = t.Object({ ok: t.Boolean({ description: "Always true" }) });

/**
 * `POST /api/subshells/:id/harness-session` — the harness re-pins its OWN
 * conversation id when the session changes in-pane (/clear, /resume, /fork),
 * so the next restart-resume continues the CURRENT transcript instead of a
 * stale launch-time one. Subshell-key-only and self-scoped, exactly like
 * /attention: a harness speaks for its own row, never another's, and
 * browsers have no reason to be here.
 */
export const subshellHarnessSessionRoute = new Elysia()
  .use(contextPlugin)
  .use(authGuard)
  .use(apiModels)
  .post(
    "/:id/harness-session",
    async ({ params, body, actor, principal, apiKeyPermissions, ctx }) => {
      requirePerm({ actor, apiKeyPermissions }, "subshells", "write");
      // requirePerm is scope-wide, not per-row: a subshell key holds
      // subshells:write for ITS subshell, so the cross-row check lives here —
      // and the cookie actor is turned away entirely: this is the harness
      // talking, not a browser (same rule as /attention).
      if (actor !== "subshell-key" || principal !== `sess:${params.id}`) {
        throw new HttpError(403, "Only a subshell's own key may report its harness session");
      }
      await ctx.services.subshells.recordHarnessSession(params.id, body.sessionId);
      return { ok: true } as const;
    },
    {
      body: HarnessSessionBodySchema,
      response: {
        200: OkResponseSchema,
        400: "ApiErrorResponse",
        401: "ApiErrorResponse",
        403: "ApiErrorResponse",
        404: "ApiErrorResponse",
      },
      detail: {
        operationId: "reportSubshellHarnessSession",
        tags: ["subshells"],
        description: "Harness self-report: the conversation id this pane is now running",
      },
    },
  );
