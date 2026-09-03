import { Elysia } from "elysia";
import { authGuard, requireCookieActor, requirePerm } from "@/api/auth-guard.js";
import { SetSubshellSharesBodySchema, SubshellSharesResponseSchema } from "@/api/models.js";
import { contextPlugin } from "@/plugins/context.plugin.js";
import { apiModels } from "@/schema/index.js";

/**
 * `GET/PUT /api/subshells/:id/shares` — the owner's sharing control (spec
 * 2026-08-31 §4). Owner-only and cookie-only: managing who can see a subshell is
 * a human act, so a machine token is refused here even for its own subshell. The
 * service enforces ownership, resolves grantee names, and validates grantees.
 */
export const subshellSharesRoutes = new Elysia()
  .use(contextPlugin)
  .use(authGuard)
  .use(apiModels)
  .get(
    "/:id/shares",
    async ({ params, user, actor, apiKeyPermissions, ctx }) => {
      requirePerm({ actor, apiKeyPermissions }, "subshells", "read");
      requireCookieActor(actor, "Subshell sharing is restricted to browser subshells");
      return await ctx.services.subshells.getShares(user.id, params.id, actor);
    },
    {
      response: {
        200: SubshellSharesResponseSchema,
        401: "ApiErrorResponse",
        403: "ApiErrorResponse",
        404: "ApiErrorResponse",
      },
      detail: {
        operationId: "getSubshellShares",
        tags: ["subshells"],
        description: "List a subshell's sharing grants (owner only)",
      },
    },
  )
  .put(
    "/:id/shares",
    async ({ params, body, user, actor, apiKeyPermissions, ctx }) => {
      requirePerm({ actor, apiKeyPermissions }, "subshells", "write");
      requireCookieActor(actor, "Subshell sharing is restricted to browser subshells");
      const shares = body.shares.map((s) => ({ granteeUserId: s.granteeUserId ?? null, permission: s.permission }));
      return await ctx.services.subshells.setShares(user.id, params.id, shares, actor);
    },
    {
      body: SetSubshellSharesBodySchema,
      response: {
        200: SubshellSharesResponseSchema,
        400: "ApiErrorResponse",
        401: "ApiErrorResponse",
        403: "ApiErrorResponse",
        404: "ApiErrorResponse",
      },
      detail: {
        operationId: "setSubshellShares",
        tags: ["subshells"],
        description: "Replace a subshell's sharing grants (owner only)",
      },
    },
  );
