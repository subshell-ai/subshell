import { Elysia, t } from "elysia";
import { authGuard, requirePerm } from "@/api/auth-guard.js";
import { contextPlugin } from "@/plugins/context.plugin.js";
import { apiModels } from "@/schema/index.js";

const MembersViewSchema = t.Object({
  members: t.Array(
    t.Object({
      principalId: t.String({ description: "Member principal label" }),
      publicKey: t.Nullable(t.String({ description: "JWK JSON, or null when unregistered" })),
      addedAt: t.String({ description: "ISO 8601 join timestamp" }),
    }),
    { description: "Channel roster" },
  ),
});

/** `GET /api/channels/:name/members` — channel roster with public keys. */
export const listChannelMembersRoute = new Elysia()
  .use(contextPlugin)
  .use(authGuard)
  .use(apiModels)
  .get(
    "/:name/members",
    async ({ params, actor, apiKeyPermissions, ctx }) => {
      requirePerm({ actor, apiKeyPermissions }, "channels", "read");
      return await ctx.services.channels.listChannelMembers(params.name);
    },
    {
      response: {
        200: MembersViewSchema,
        401: "ApiErrorResponse",
        403: "ApiErrorResponse",
        404: "ApiErrorResponse",
      },
      detail: {
        operationId: "listChannelMembers",
        tags: ["channels"],
        description: "Channel roster with public keys",
      },
    },
  );
