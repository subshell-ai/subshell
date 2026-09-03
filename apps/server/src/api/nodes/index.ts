import { Elysia } from "elysia";
import { createSetupKeyRoute } from "@/api/nodes/create-setup-key.route.js";
import { deleteNodeRoute } from "@/api/nodes/delete-node.route.js";
import { deleteSetupKeyRoute } from "@/api/nodes/delete-setup-key.route.js";
import { enrollRoute } from "@/api/nodes/enroll.route.js";
import { getNodeRoute } from "@/api/nodes/get-node.route.js";
import { getNodeSharesRoute } from "@/api/nodes/get-node-shares.route.js";
import { listNodesRoute } from "@/api/nodes/list-nodes.route.js";
import { listSetupKeyRoute } from "@/api/nodes/list-setup-keys.route.js";
import { patchNodeHarnessRoute } from "@/api/nodes/patch-node-harness.route.js";
import { recheckNodeRoute } from "@/api/nodes/recheck-node.route.js";
import { renameNodeRoute } from "@/api/nodes/rename-node.route.js";
import { rotateNodeKeyRoute } from "@/api/nodes/rotate-node-key.route.js";
import { setNodeSharesRoute } from "@/api/nodes/set-node-shares.route.js";

/**
 * `/api/nodes` — one Elysia instance per endpoint (the subshells-directory
 * convention): the public enroll endpoint (spec 2026-08-31 §5.2), the
 * setup-key trio (§5.1/§9), and the registry CRUD + shares + rotate-key set
 * (§9) plus the per-node harness toggle and re-check (Task 10, §6.2).
 * `nodesRoutes` is mounted inside `computeRoutes` (routes.ts) — the
 * grouping there is the TS2589 defense, so keep new endpoints as `.use()`
 * modules on this instance rather than growing a flat chain upstream.
 */
export const nodesRoutes = new Elysia({ prefix: "/api/nodes" })
  .use(enrollRoute)
  .use(createSetupKeyRoute)
  .use(listSetupKeyRoute)
  .use(deleteSetupKeyRoute)
  .use(listNodesRoute)
  .use(getNodeRoute)
  .use(renameNodeRoute)
  .use(deleteNodeRoute)
  .use(getNodeSharesRoute)
  .use(setNodeSharesRoute)
  .use(rotateNodeKeyRoute)
  .use(patchNodeHarnessRoute)
  .use(recheckNodeRoute);
