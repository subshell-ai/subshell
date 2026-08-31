import { Elysia, t } from "elysia";
import { authGuard, requirePerm } from "@/api/auth-guard.js";
import { contextPlugin } from "@/plugins/context.plugin.js";
import { apiModels } from "@/schema/index.js";

const SummaryResponseSchema = t.Object({
  total: t.Number({ description: "Sessions the user has ever had" }),
  running: t.Number({ description: "Sessions currently alive" }),
  waiting: t.Number({ description: "Alive sessions with waitingSince set — the badge number" }),
});

/**
 * `GET /api/sessions/summary` — badge counts in one cheap read (spec §Backend
 * diff). Static segments beat `/:id` in Elysia's router regardless of mount
 * order (verified against 1.4.30), so "summary" cannot be shadowed by the id
 * route — the order in `sessions/index.ts` is convention, not a constraint.
 */
export const summarySessionRoute = new Elysia()
  .use(contextPlugin)
  .use(authGuard)
  .use(apiModels)
  .get(
    "/summary",
    async ({ user, actor, apiKeyPermissions, ctx }) => {
      requirePerm({ actor, apiKeyPermissions }, "sessions", "read");
      return await ctx.services.sessions.summarySessions(user.id);
    },
    {
      response: {
        200: SummaryResponseSchema,
        401: "ApiErrorResponse",
        403: "ApiErrorResponse",
      },
      detail: {
        operationId: "getSessionSummary",
        tags: ["sessions"],
        description: "Counts of the user's total/running/waiting sessions",
      },
    },
  );
