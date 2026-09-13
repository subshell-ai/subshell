import { Elysia } from "elysia";
import { DeploymentViewSchema } from "@/api/admin-server/schemas.js";
import { requireAdmin } from "@/api/auth-guard.js";
import { collectDeploymentCached } from "@/services/server-deployment.js";

/**
 * `GET /api/admin/server` — how this server is DEPLOYED, as against
 * `GET /api/admin/status`, which is what is happening on it.
 *
 * WHY `requireAdmin`: the payload names filesystem paths, the service
 * definition and the resolved MCP command. `requireAdmin` also refuses BEARER
 * actors, so a system or subshell key cannot read the instance's shape even
 * when its owner is an admin.
 *
 * It carries no secret in any form — the auth secret appears only as
 * `set`/`missing` — and its test asserts the whole key set, so a field added
 * later is a decision rather than an accident.
 */
/**
 * The CACHED collector, and this is the one route that uses it: the page polls
 * this every 5 s per open tab, and collecting spawns `netstat` and the service
 * manager SYNCHRONOUSLY — a whole-process stall on a single-threaded runtime,
 * paid by every other request. Writers call the uncached one.
 */
export const getServerRoute = new Elysia().use(requireAdmin).get("/", () => collectDeploymentCached(), {
  response: DeploymentViewSchema,
  detail: {
    operationId: "getServerDeployment",
    tags: ["admin"],
    description:
      "The server's own view of its deployment: config.env values saved versus running, the service manager's state, data locations, and whether a self-restart is possible. Cookie-admin only; bearer keys are refused. No secret in any form.",
  },
});
