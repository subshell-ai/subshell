import { Elysia, t } from "elysia";
import { authGuard } from "@/api/auth-guard.js";
import { contextPlugin } from "@/plugins/context.plugin.js";
import { apiModels } from "@/schema/index.js";

/** `POST /api/sessions/:id/extend-token` — resets this session's MCP token expiry (self-only for session tokens). */
export const extendSessionTokenRoute = new Elysia()
  .use(contextPlugin)
  .use(authGuard)
  .use(apiModels)
  .post(
    "/:id/extend-token",
    async ({ params, user, principal, actor, ctx }) => {
      // Permission-wise this endpoint has no requirePerm call by design —
      // only the session's own token (or its owner's cookie) may self-extend;
      // the self-only check lives in the service.
      return await ctx.services.sessions.extendSessionToken({
        userId: user.id,
        sessionId: params.id,
        actor,
        principal,
      });
    },
    {
      response: {
        200: t.Object({
          extended: t.Boolean({ description: "False when the session has no token" }),
          ttlSeconds: t.Number({ description: "New lifetime from now" }),
        }),
        401: "ApiErrorResponse",
        403: "ApiErrorResponse",
        404: "ApiErrorResponse",
      },
      detail: {
        operationId: "extendSessionToken",
        tags: ["sessions"],
        description: "Resets this session's MCP token expiry (self-only for session tokens)",
      },
    },
  );
