import { Elysia } from "elysia";
import { adminStatusRoutes } from "@/api/admin-status.route.js";
import { auditRoutes } from "@/api/audit.route.js";
import { channelRoutes } from "@/api/channels/index.js";
import { devicesRoutes } from "@/api/devices.route.js";
import { downloadsRoutes } from "@/api/downloads.route.js";
import { filesRoutes } from "@/api/files.route.js";
import { identityRoutes } from "@/api/identities.route.js";
import { liveRoutes } from "@/api/live.route.js";
import { metaRoutes } from "@/api/meta.route.js";
import { nodesRoutes } from "@/api/nodes/index.js";
import { notificationsRoutes } from "@/api/notifications.route.js";
import { pluginsRoutes } from "@/api/plugins.route.js";
import { profileRoutes } from "@/api/profiles.route.js";
import { settingsRoutes } from "@/api/settings.route.js";
import { instancePublicRoutes } from "@/api/settings-public.route.js";
import { setupRoutes } from "@/api/setup.route.js";
import { subshellRoutes } from "@/api/subshells/index.js";
import { systemKeysRoutes } from "@/api/system-keys.route.js";
import { uploadsRoutes } from "@/api/uploads.route.js";
import { usersRoutes } from "@/api/users.route.js";
import { workspaceRoutes } from "@/api/workspaces/index.js";
import { wsTokenRoutes } from "@/api/ws-token.route.js";

/**
 * Root API router. Feature routes are grouped into a few sub-aggregates and
 * then merged, rather than chained `.use()` end to end.
 *
 * Elysia builds its composed type as a LEFT-NESTED merge of every `.use()`, so a
 * long flat chain makes `App = ReturnType<typeof createApp>` recursively deep and
 * eventually trips TypeScript's instantiation-depth ceiling (TS2589) — at which
 * point ADDING ANY new route module fails to compile, no matter how small. The
 * old flat chain had consumed essentially all of that depth budget. Grouping
 * routes into balanced sub-aggregates keeps the identical set of endpoints but
 * flattens the nesting back to a shallow tree, restoring headroom so new
 * feature modules (and their endpoints) can be added normally.
 *
 * Grouping is by rough domain only — it is not a behaviour boundary. Elysia
 * matches by path rank (static segments over `/:id`), not registration order,
 * so splitting one flat chain into three changes nothing about routing.
 */
const coreRoutes = new Elysia()
  .use(settingsRoutes)
  .use(setupRoutes)
  .use(pluginsRoutes)
  .use(metaRoutes)
  .use(usersRoutes)
  .use(auditRoutes)
  .use(wsTokenRoutes)
  .use(identityRoutes)
  .use(systemKeysRoutes)
  .use(downloadsRoutes);

const computeRoutes = new Elysia()
  .use(subshellRoutes)
  .use(uploadsRoutes)
  .use(profileRoutes)
  .use(filesRoutes)
  .use(workspaceRoutes)
  .use(nodesRoutes);

const commsRoutes = new Elysia().use(notificationsRoutes).use(devicesRoutes).use(liveRoutes).use(channelRoutes);

/**
 * Admin-only surfaces. Its own group rather than an eleventh module bolted
 * onto `coreRoutes`, which already carries the most: the depth budget above is
 * the whole reason these groups exist, and spending it in the fullest one is
 * how the next feature route ends up paying for a regrouping.
 */
const adminRoutes = new Elysia().use(adminStatusRoutes);

/**
 * The anonymous surface — routes that deliberately do NOT `.use(authGuard)`.
 * Its own group rather than an addition to `coreRoutes`, which already carries
 * the most: the depth budget above is the whole reason these groups exist.
 * Keeping it separate also means "what can be read without a credential?" is a
 * question this file answers by itself.
 */
const publicRoutes = new Elysia().use(instancePublicRoutes);

export const routes = new Elysia()
  .use(coreRoutes)
  .use(computeRoutes)
  .use(commsRoutes)
  .use(adminRoutes)
  .use(publicRoutes)
  .onError(({ error }) => {
    // Keep API errors JSON-shaped and small; the global error handler also runs.
    throw error;
  });
