import { Elysia } from "elysia";
import { authGuard, requireCookieActor, requirePerm } from "@/api/auth-guard.js";
import { SessionSharesResponseSchema, SetSessionSharesBodySchema } from "@/api/models.js";
import { contextPlugin } from "@/plugins/context.plugin.js";
import { apiModels } from "@/schema/index.js";

/**
 * `GET/PUT /api/sessions/:id/shares` — the owner's sharing control (spec
 * 2026-08-31 §4). Owner-only and cookie-only: managing who can see a session is
 * a human act, so a machine token is refused here even for its own session. The
 * service enforces ownership, resolves grantee names, and validates grantees.
 */
export const sessionSharesRoutes = new Elysia()
  .use(contextPlugin)
  .use(authGuard)
  .use(apiModels)
  .get(
    "/:id/shares",
    async ({ params, user, actor, apiKeyPermissions, ctx }) => {
      requirePerm({ actor, apiKeyPermissions }, "sessions", "read");
      requireCookieActor(actor, "Session sharing is restricted to browser sessions");
      return await ctx.services.sessions.getShares(user.id, params.id, actor);
    },
    {
      response: {
        200: SessionSharesResponseSchema,
        401: "ApiErrorResponse",
        403: "ApiErrorResponse",
        404: "ApiErrorResponse",
      },
      detail: {
        operationId: "getSessionShares",
        tags: ["sessions"],
        description: "List a session's sharing grants (owner only)",
      },
    },
  )
  .put(
    "/:id/shares",
    async ({ params, body, user, actor, apiKeyPermissions, ctx }) => {
      requirePerm({ actor, apiKeyPermissions }, "sessions", "write");
      requireCookieActor(actor, "Session sharing is restricted to browser sessions");
      const shares = body.shares.map((s) => ({ granteeUserId: s.granteeUserId ?? null, permission: s.permission }));
      return await ctx.services.sessions.setShares(user.id, params.id, shares, actor);
    },
    {
      body: SetSessionSharesBodySchema,
      response: {
        200: SessionSharesResponseSchema,
        400: "ApiErrorResponse",
        401: "ApiErrorResponse",
        403: "ApiErrorResponse",
        404: "ApiErrorResponse",
      },
      detail: {
        operationId: "setSessionShares",
        tags: ["sessions"],
        description: "Replace a session's sharing grants (owner only)",
      },
    },
  );
