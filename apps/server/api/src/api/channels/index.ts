import { Elysia } from "elysia";
import { createChannelRoute } from "@/api/channels/create-channel.route.js";
import { getChannelCursorRoute } from "@/api/channels/get-channel-cursor.route.js";
import { joinChannelRoute } from "@/api/channels/join-channel.route.js";
import { listChannelMembersRoute } from "@/api/channels/list-channel-members.route.js";
import { listChannelsRoute } from "@/api/channels/list-channels.route.js";
import { postToChannelRoute } from "@/api/channels/post-to-channel.route.js";
import { readChannelPostsRoute } from "@/api/channels/read-channel-posts.route.js";

/**
 * `/api/channels` — one Elysia instance per endpoint (mounted in the original
 * monolithic route's order); business logic lives in `ChannelsService`
 * (`src/services/channels.service.ts`), reached by handlers via `ctx`.
 */
export const channelRoutes = new Elysia({ prefix: "/api/channels" })
  .use(createChannelRoute)
  .use(listChannelsRoute)
  .use(listChannelMembersRoute)
  .use(joinChannelRoute)
  .use(postToChannelRoute)
  .use(readChannelPostsRoute)
  .use(getChannelCursorRoute);
