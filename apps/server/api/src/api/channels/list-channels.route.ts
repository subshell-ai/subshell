import { Elysia, t } from "elysia";
import { authGuard, requirePerm } from "@/api/auth-guard.js";
import { contextPlugin } from "@/plugins/context.plugin.js";
import { apiModels } from "@/schema/index.js";

const ChannelViewSchema = t.Object({
  id: t.String({ description: "Channel id (uuid)" }),
  name: t.String({ description: "Channel slug" }),
  createdBy: t.String({ description: "Creator principal label" }),
  createdAt: t.String({ description: "ISO 8601 creation timestamp" }),
  memberCount: t.Number({ description: "Current member count" }),
  lastSeq: t.Number({ description: "Highest posted seq (0 when empty)" }),
});

/** `GET /api/channels` — lists channels with counters. */
export const listChannelsRoute = new Elysia()
  .use(contextPlugin)
  .use(authGuard)
  .use(apiModels)
  .get(
    "/",
    async ({ actor, apiKeyPermissions, ctx }) => {
      requirePerm({ actor, apiKeyPermissions }, "channels", "read");
      return await ctx.services.channels.listChannels();
    },
    {
      response: {
        200: t.Object({ channels: t.Array(ChannelViewSchema, { description: "All channels" }) }),
        401: "ApiErrorResponse",
        403: "ApiErrorResponse",
      },
      detail: { operationId: "listChannels", tags: ["channels"], description: "Lists channels with counters" },
    },
  );
