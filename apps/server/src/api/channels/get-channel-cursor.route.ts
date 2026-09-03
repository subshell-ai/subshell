import { Elysia, t } from "elysia";
import { authGuard, requirePerm } from "@/api/auth-guard.js";
import { contextPlugin } from "@/plugins/context.plugin.js";
import { apiModels } from "@/schema/index.js";

const CursorViewSchema = t.Object({
  lastSeq: t.Number({ description: "Stored read position (0 = never read)" }),
  unread: t.Number({ description: "Posts after lastSeq addressed to the caller" }),
});

/** `GET /api/channels/:name/cursor` — caller's read position and unread count. */
export const getChannelCursorRoute = new Elysia()
  .use(contextPlugin)
  .use(authGuard)
  .use(apiModels)
  .get(
    "/:name/cursor",
    async ({ params, principal, actor, apiKeyPermissions, ctx }) => {
      requirePerm({ actor, apiKeyPermissions }, "channels", "read");
      return await ctx.services.channels.getChannelCursor({ principal, name: params.name });
    },
    {
      response: {
        200: CursorViewSchema,
        401: "ApiErrorResponse",
        403: "ApiErrorResponse",
        404: "ApiErrorResponse",
      },
      detail: {
        operationId: "getChannelCursor",
        tags: ["channels"],
        description: "Caller's read position and unread count",
      },
    },
  );
