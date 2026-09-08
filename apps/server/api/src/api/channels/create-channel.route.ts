import { Elysia, t } from "elysia";
import { authGuard, requirePerm } from "@/api/auth-guard.js";
import { contextPlugin } from "@/plugins/context.plugin.js";
import { apiModels } from "@/schema/index.js";

/** Channel slug: lowercase, compact, and safe to echo into nudge lines. */
const ChannelNameSchema = t.String({
  pattern: "^[a-z0-9][a-z0-9-]{0,63}$",
  description: "Channel slug (lowercase letters/digits/hyphen, starts alphanumeric)",
});

const CreateChannelBodySchema = t.Object({
  name: ChannelNameSchema,
});

/** `POST /api/channels` — creates a channel and joins the creator. */
export const createChannelRoute = new Elysia()
  .use(contextPlugin)
  .use(authGuard)
  .use(apiModels)
  .post(
    "/",
    async ({ body, principal, actor, apiKeyPermissions, ctx }) => {
      requirePerm({ actor, apiKeyPermissions }, "channels", "write");
      return await ctx.services.channels.createChannel({ principal, name: body.name });
    },
    {
      body: CreateChannelBodySchema,
      response: {
        200: t.Object({
          id: t.String({ description: "Channel id (uuid)" }),
          name: t.String({ description: "Channel slug" }),
        }),
        400: "ApiErrorResponse",
        401: "ApiErrorResponse",
        403: "ApiErrorResponse",
        409: "ApiErrorResponse",
      },
      detail: {
        operationId: "createChannel",
        tags: ["channels"],
        description: "Creates a channel and joins the creator",
      },
    },
  );
