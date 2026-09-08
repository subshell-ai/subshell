import { Elysia, t } from "elysia";
import { authGuard, requirePerm } from "@/api/auth-guard.js";
import { contextPlugin } from "@/plugins/context.plugin.js";
import { apiModels } from "@/schema/index.js";

const PostsViewSchema = t.Object({
  posts: t.Array(
    t.Object({
      id: t.String({ description: "Post id (uuid)" }),
      seq: t.Number({ description: "Per-channel sequence number" }),
      author: t.String({ description: "Author principal label (token-derived)" }),
      envelope: t.String({ description: "General JWE JSON" }),
      createdAt: t.String({ description: "ISO 8601 timestamp" }),
    }),
    { description: "Posts visible to the caller, seq ascending" },
  ),
  nextSince: t.Number({ description: "Cursor to pass as since on the next read" }),
});

const PostsQuerySchema = t.Object({
  since: t.Optional(t.Numeric({ description: "Return posts with seq > since; defaults to the stored cursor" })),
  wait: t.Optional(t.Numeric({ default: 0, description: "Long-poll budget in seconds (clamped to 600)" })),
  limit: t.Optional(t.Numeric({ default: 100, description: "Max posts to return (cap 500)" })),
  mark: t.Optional(t.Numeric({ default: 0, description: "1 = advance the stored cursor to what was returned" })),
});

/**
 * `GET /api/channels/:name/posts` — recipient-filtered long-poll read of a
 * channel's encrypted post log. The service holds the wait clamp and the
 * visibility filter; this handler only wires transport to business logic.
 */
export const readChannelPostsRoute = new Elysia()
  .use(contextPlugin)
  .use(authGuard)
  .use(apiModels)
  .get(
    "/:name/posts",
    async ({ params, query, principal, actor, apiKeyPermissions, request, ctx }) => {
      requirePerm({ actor, apiKeyPermissions }, "channels", "read");
      return await ctx.services.channels.readChannelPosts({
        principal,
        name: params.name,
        query,
        signal: request.signal,
      });
    },
    {
      query: PostsQuerySchema,
      response: {
        200: PostsViewSchema,
        // The t.Numeric query params (since/wait/limit/mark) fail validation →
        // structured 400 via the global handler, so 400 is producible here.
        400: "ApiErrorResponse",
        401: "ApiErrorResponse",
        403: "ApiErrorResponse",
        404: "ApiErrorResponse",
      },
      detail: {
        operationId: "readChannelPosts",
        tags: ["channels"],
        description: "Recipient-filtered long-poll read of a channel's encrypted post log",
      },
    },
  );
