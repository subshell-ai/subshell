import { Elysia, t } from "elysia";
import { authGuard, requirePerm } from "@/api/auth-guard.js";
import { contextPlugin } from "@/plugins/context.plugin.js";
import { apiModels } from "@/schema/index.js";

const PostBodySchema = t.Object({
  envelope: t.String({
    minLength: 32,
    maxLength: 131072,
    description: "General JWE JSON (opaque ciphertext envelope)",
  }),
  recipientIds: t.Array(t.String({ minLength: 1, maxLength: 120 }), {
    minItems: 1,
    maxItems: 256,
    description: "Every recipient must already be a channel member",
  }),
  nudge: t.Optional(t.Boolean({ default: false, description: "Type a heads-up line into recipient subshell panes" })),
});

const PostResultSchema = t.Object({
  id: t.String({ description: "Post id (uuid)" }),
  seq: t.Number({ description: "Assigned per-channel sequence number" }),
});

/** `POST /api/channels/:name/posts` — appends an encrypted post to a channel. */
export const postToChannelRoute = new Elysia()
  .use(contextPlugin)
  .use(authGuard)
  .use(apiModels)
  .post(
    "/:name/posts",
    async ({ params, body, principal, actor, apiKeyPermissions, ctx }) => {
      requirePerm({ actor, apiKeyPermissions }, "channels", "write");
      return await ctx.services.channels.postToChannel({
        principal,
        name: params.name,
        envelope: body.envelope,
        recipientIds: body.recipientIds,
        nudge: body.nudge,
      });
    },
    {
      body: PostBodySchema,
      response: {
        200: PostResultSchema,
        400: "ApiErrorResponse",
        401: "ApiErrorResponse",
        403: "ApiErrorResponse",
        404: "ApiErrorResponse",
      },
      detail: {
        operationId: "postToChannel",
        tags: ["channels"],
        description: "Appends an encrypted post to a channel",
      },
    },
  );
