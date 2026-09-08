import { Elysia, t } from "elysia";
import { authGuard, requirePerm } from "@/api/auth-guard.js";
import { contextPlugin } from "@/plugins/context.plugin.js";
import { apiModels } from "@/schema/index.js";

/** `POST /api/channels/:name/members` — joins the caller to a channel (idempotent). */
export const joinChannelRoute = new Elysia()
  .use(contextPlugin)
  .use(authGuard)
  .use(apiModels)
  .post(
    "/:name/members",
    async ({ params, principal, actor, apiKeyPermissions, ctx }) => {
      requirePerm({ actor, apiKeyPermissions }, "channels", "write");
      return await ctx.services.channels.joinChannel({ principal, name: params.name });
    },
    {
      response: {
        200: t.Object({ joined: t.Boolean({ description: "Always true (idempotent)" }) }),
        401: "ApiErrorResponse",
        403: "ApiErrorResponse",
        404: "ApiErrorResponse",
        409: "ApiErrorResponse",
      },
      detail: {
        operationId: "joinChannel",
        tags: ["channels"],
        description: "Joins the caller to a channel (idempotent)",
      },
    },
  );
