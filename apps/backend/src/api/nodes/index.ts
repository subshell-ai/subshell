import { Elysia } from "elysia";
import { createSetupKeyRoute } from "@/api/nodes/create-setup-key.route.js";
import { deleteSetupKeyRoute } from "@/api/nodes/delete-setup-key.route.js";
import { listSetupKeyRoute } from "@/api/nodes/list-setup-keys.route.js";

/**
 * `/api/nodes` — one Elysia instance per endpoint (the sessions-directory
 * convention). Today: the setup-key management trio (spec 2026-08-31 §9);
 * later Phase 1 tasks mount the node registry, shares, and rotate routes here.
 */
export const nodesRoutes = new Elysia({ prefix: "/api/nodes" })
  .use(createSetupKeyRoute)
  .use(listSetupKeyRoute)
  .use(deleteSetupKeyRoute);
