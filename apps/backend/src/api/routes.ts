import { Elysia } from "elysia";
import { auditRoutes } from "@/api/audit.route.js";
import { channelRoutes } from "@/api/channels/index.js";
import { devicesRoutes } from "@/api/devices.route.js";
import { filesRoutes } from "@/api/files.route.js";
import { identityRoutes } from "@/api/identities.route.js";
import { liveRoutes } from "@/api/live.route.js";
import { metaRoutes } from "@/api/meta.route.js";
import { notificationsRoutes } from "@/api/notifications.route.js";
import { profileRoutes } from "@/api/profiles.route.js";
import { sessionRoutes } from "@/api/sessions/index.js";
import { settingsRoutes } from "@/api/settings.route.js";
import { setupRoutes } from "@/api/setup.route.js";
import { systemKeysRoutes } from "@/api/system-keys.route.js";
import { uploadsRoutes } from "@/api/uploads.route.js";
import { usersRoutes } from "@/api/users.route.js";
import { workspaceRoutes } from "@/api/workspaces/index.js";
import { wsTokenRoutes } from "@/api/ws-token.route.js";

/**
 * Root API router. Feature routes are composed in as they are built.
 */
export const routes = new Elysia()
  .use(settingsRoutes)
  .use(setupRoutes)
  .use(sessionRoutes)
  .use(uploadsRoutes)
  .use(profileRoutes)
  .use(filesRoutes)
  .use(notificationsRoutes)
  .use(devicesRoutes)
  .use(metaRoutes)
  .use(usersRoutes)
  .use(auditRoutes)
  .use(wsTokenRoutes)
  .use(liveRoutes)
  .use(workspaceRoutes)
  .use(identityRoutes)
  .use(channelRoutes)
  .use(systemKeysRoutes)
  .onError(({ error }) => {
    // Keep API errors JSON-shaped and small; the global error handler also runs.
    throw error;
  });
