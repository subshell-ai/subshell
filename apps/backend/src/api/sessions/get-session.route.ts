import { Elysia } from "elysia";
import { authGuard, requireCookieActor, requirePerm } from "@/api/auth-guard.js";
import { SessionSchema, SessionSharesResponseSchema, SetSessionSharesBodySchema } from "@/api/models.js";
import { contextPlugin } from "@/plugins/context.plugin.js";
import { apiModels } from "@/schema/index.js";

/**
 * Session read routes: the single-session view plus its sharing grants.
 *
 * The sharing GET/PUT live here (not in their own module) purely to keep the
 * composed `App` type under Elysia's inference-depth limit — the aggregate
 * router sits right at that edge, and a fresh plugin-merging sub-module tips it
 * over. Co-locating the owner's read surfaces on one already-mounted instance
 * adds two handlers without a new module's type surface.
 */
export const getSessionRoute = new Elysia()
  .use(contextPlugin)
  .use(authGuard)
  .use(apiModels)
  .get(
    "/:id",
    async ({ params, user, actor, apiKeyPermissions, ctx }) => {
      requirePerm({ actor, apiKeyPermissions }, "sessions", "read");
      return await ctx.services.sessions.getSession(user.id, params.id, actor);
    },
    {
      response: {
        200: SessionSchema,
        401: "ApiErrorResponse",
        403: "ApiErrorResponse",
        404: "ApiErrorResponse",
      },
      detail: {
        operationId: "getSession",
        tags: ["sessions"],
        description: "Gets a single session by id",
      },
    },
  )
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
