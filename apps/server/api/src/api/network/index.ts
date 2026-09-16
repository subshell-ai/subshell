import { Elysia } from "elysia";
import { installNetworkRoute } from "@/api/network/install-network.route.js";
import { joinNetworkRoute } from "@/api/network/join-network.route.js";
import { leaveNetworkRoute } from "@/api/network/leave-network.route.js";
import { listNetworksRoute } from "@/api/network/list-networks.route.js";
import { publishNetworkRoute } from "@/api/network/publish-network.route.js";
import { unpublishNetworkRoute } from "@/api/network/unpublish-network.route.js";
import { updateNetworkSettingsRoute } from "@/api/network/update-network-settings.route.js";

/**
 * `/api/network` — this machine's network state (spec 2026-09-15 § 5.1).
 *
 * Composition only, never a second source of truth: each route module owns its
 * own schemas, handler and OpenAPI metadata, and the gate every one of them
 * applies lives in `network-gate.ts` rather than being restated here.
 *
 * Deliberately NOT under `/api/plugins`. Those two answer different questions:
 * `/api/plugins` is "which plugins exist and are enabled" — the store,
 * memoised, readable by any signed-in actor — while these are "what is this
 * MACHINE's network state", which means live vendor-CLI probes, cookie-admin
 * only, never public, with streaming bodies.
 */
export const networkRoutes = new Elysia({ prefix: "/api/network" })
  .use(listNetworksRoute)
  .use(updateNetworkSettingsRoute)
  .use(installNetworkRoute)
  .use(joinNetworkRoute)
  .use(publishNetworkRoute)
  .use(unpublishNetworkRoute)
  .use(leaveNetworkRoute);
