import { statSync } from "node:fs";
import { hostname } from "node:os";
import { agentVersionSupported, MIN_AGENT_VERSION, NODE_PROTOCOL_VERSION } from "@internal/subshell-protocol";
import { Elysia, t } from "elysia";
import { requireAdmin } from "@/api/auth-guard.js";
import { listSystemKeys } from "@/auth/apikey-store.js";
import { findSystemUserId } from "@/auth/system-user.js";
import {
  APP_BASE_URL,
  AUTH_SECRET,
  DATABASE_PATH,
  emergencyLoginArmed,
  HOST,
  IS_PROD,
  PLACEHOLDER_AUTH_SECRET,
  SERVER_PORT,
} from "@/constants.js";
import { db } from "@/db/index.js";
import { InstanceStatsRepository } from "@/db/repositories/instance-stats.repository.js";
import { SettingsRepository } from "@/db/repositories/settings.repository.js";
import { staticSource } from "@/plugins/static.plugin.js";
import { probeMcpLaunch } from "@/services/mcp-resolve.js";
import { listOnline } from "@/services/nodes/node-registry.js";
import { localPlatform } from "@/services/nodes/seed-local.js";
import { SERVER_VERSION } from "@/version.js";

/**
 * `GET /api/admin/status` — the whole instance in one read, for the admin
 * status page.
 *
 * WHY ONE ENDPOINT: the page answers "is this instance healthy, and what is it
 * running". Fanning that out across six list endpoints and counting arrays in
 * the browser would make the answer depend on what the viewer may see, which
 * is exactly wrong for an instance-wide question — and it would ship whole
 * rows to produce six integers.
 *
 * WHY `requireAdmin`: the payload names filesystem paths, the resolved MCP
 * command and the security posture. `requireAdmin` also refuses BEARER actors
 * (auth-guard's `actor !== "cookie"` clause), so a system or subshell key
 * cannot read the instance's shape even when its owner is an admin.
 *
 * WHAT IS DELIBERATELY ABSENT: no secret, ever. The auth secret appears only
 * as the boolean `usingPlaceholderSecret`, the break-glass password only as
 * `emergencyLoginActive`, and neither string is read into the response at any
 * point. Adding a field here means asking whether an admin's screen — which
 * may be shared, screenshotted or pasted into an issue — should carry it.
 */

const VersionsSchema = t.Object({
  server: t.String({ description: "Server app version (apps/server/api package.json)" }),
  nodeProtocol: t.Number({ description: "Node protocol version this control plane speaks; nodes must match EXACTLY" }),
  minAgent: t.String({ description: "Oldest subshell node version this control plane will accept on /ws/node" }),
  bun: t.String({ description: "Bun runtime version this process is running on" }),
});

/** One enrolled agent that this control plane would refuse (or has refused). */
const OutdatedAgentSchema = t.Object({
  id: t.String({ description: "Node id" }),
  name: t.String({ description: "Node display name" }),
  agentVersion: t.Nullable(t.String({ description: "Last-known node version" }), {
    description: "Last-known node version, or null when the node has never reported one",
  }),
});

const RuntimeSchema = t.Object({
  uptimeSeconds: t.Number({ description: "Whole seconds since this process started" }),
  bootedAt: t.String({ description: "Process start time (ISO), derived from uptime, not a recorded stamp" }),
  pid: t.Number({ description: "Process id on the control-plane host" }),
  os: t.String({ description: "Host OS in the node vocabulary (linux|darwin)" }),
  arch: t.String({ description: "Host CPU architecture" }),
  hostname: t.String({ description: "Control-plane host name" }),
  production: t.Boolean({ description: "True when NODE_ENV=production (strict origin checks, secure cookies)" }),
  memoryRssBytes: t.Number({ description: "Resident set size of this process, in bytes" }),
  memoryHeapUsedBytes: t.Number({ description: "JS heap in use, in bytes" }),
  listenHost: t.String({ description: "Configured bind address (HOST)" }),
  listenPort: t.Number({ description: "Configured port (SERVER_PORT)" }),
  appBaseUrl: t.String({ description: "APP_BASE_URL: what this server bakes into install commands and passkey rpID" }),
  staticSource: t.String({
    description:
      "Which SPA this process serves: disk (a built frontend dist) | embedded (baked into the binary) | unselected",
  }),
  databasePath: t.String({ description: "Resolved SQLite path this instance opened" }),
  databaseBytes: t.Nullable(t.Number({ description: "Size of the SQLite file" }), {
    description: "Size of the SQLite file in bytes, or null when it cannot be stat'd",
  }),
  tmuxPath: t.Nullable(t.String({ description: "Absolute path to tmux" }), {
    description:
      "Resolved tmux binary, or null; every local pane launches through it, so null means local launches fail",
  }),
  mcpEntrypoint: t.Nullable(t.String({ description: "Resolved `subshell mcp` command line" }), {
    description: "The command every subshell create registers, or null when UNRESOLVED (create will 500)",
  }),
  mcpSource: t.Nullable(t.String({ description: "Which rung answered: env | self | agent-on-path" }), {
    description: "Resolution rung, or null when unresolved",
  }),
});

const InventorySchema = t.Object({
  users: t.Object({
    total: t.Number({
      description:
        "Registered PEOPLE (user_meta rows). The `system` service account that owns system API keys has no user_meta row and is deliberately not counted here; note that /api/users does list it",
    }),
    admins: t.Number({ description: "How many of them are admins" }),
  }),
  subshells: t.Object({
    total: t.Number({ description: "Subshells ever created on this instance" }),
    running: t.Number({ description: "Subshells whose status is running" }),
  }),
  nodes: t.Object({
    total: t.Number({ description: "Enrolled nodes, including the seeded `local` row" }),
    online: t.Number({
      description: "Nodes holding a live socket right now: the in-memory registry, not the DB projection",
    }),
    needingUpdate: t.Array(OutdatedAgentSchema, {
      description:
        "Enrolled agents below the minimum version; they are refused at connect, so they appear offline with no other explanation",
    }),
  }),
  workspaces: t.Number({ description: "Workspaces across all users" }),
  channels: t.Number({ description: "Cross-subshell channels" }),
  profiles: t.Number({ description: "Harness profiles across all users" }),
});

const SecuritySchema = t.Object({
  registrationsOpen: t.Boolean({ description: "Whether new users can register (the allow_registrations setting)" }),
  emergencyLoginActive: t.Boolean({
    description: "True while SUBSHELL_EMERGENCY_PASSWORD is set; break-glass admin login is armed and destructive",
  }),
  usingPlaceholderSecret: t.Boolean({
    description: "True when BETTER_AUTH_SECRET is still the built-in placeholder; production refuses to boot this way",
  }),
  systemKeys: t.Object({
    total: t.Number({ description: "System API keys that exist" }),
    active: t.Number({
      description: "How many are enabled AND unexpired; each of these is a usable full-access bearer credential",
    }),
  }),
});

const AdminStatusSchema = t.Object({
  versions: VersionsSchema,
  runtime: RuntimeSchema,
  inventory: InventorySchema,
  security: SecuritySchema,
  generatedAt: t.String({ description: "When the server assembled this snapshot (ISO)" }),
});

/**
 * Deploy facts, resolved once.
 *
 * Neither can change under a running process in any way that matters — the MCP
 * ladder reads execPath/argv/PATH and the env the prelude already applied, and
 * tmux is installed or it is not — but both walk $PATH synchronously, and this
 * endpoint POLLS. Every open admin tab would otherwise re-run a full PATH scan
 * every 15 s on the loop that also serves terminal frames. `staticSource()` is
 * memoised at boot for exactly this reason; these follow it.
 */
let deployFacts: { tmuxPath: string | null; mcpEntrypoint: string | null; mcpSource: string | null } | null = null;

function resolveDeployFacts(): NonNullable<typeof deployFacts> {
  if (deployFacts) return deployFacts;
  const mcp = probeMcpLaunch();
  deployFacts = {
    tmuxPath: Bun.which("tmux"),
    mcpEntrypoint: mcp.spec ? [mcp.spec.command, ...mcp.spec.args].join(" ") : null,
    mcpSource: mcp.spec ? mcp.source : null,
  };
  return deployFacts;
}

/** Size of the SQLite file, or null when it cannot be stat'd (missing, permissions). */
function databaseBytes(path: string): number | null {
  try {
    return statSync(path).size;
  } catch {
    return null;
  }
}

export const adminStatusRoutes = new Elysia({ prefix: "/api/admin" }).use(requireAdmin).get(
  "/status",
  async () => {
    const stats = new InstanceStatsRepository(db);
    const settings = new SettingsRepository(db);
    const deploy = resolveDeployFacts();
    const platform = localPlatform();
    const memory = process.memoryUsage();
    const uptimeSeconds = Math.floor(process.uptime());
    const [inventory, agents, registrationsOpen] = await Promise.all([
      stats.snapshot(),
      stats.agentVersions(),
      settings.get("allow_registrations", true),
    ]);
    // The NON-creating lookup: `ensureSystemUser` INSERTs and logs a creation
    // line, and a GET that advertises itself as read-only must not do that.
    // No system user means no system keys, so the answer is the same.
    const systemUserId = findSystemUserId();
    // The SAME predicate the WS handler refuses with (node-ws-handler.ts), not
    // a second comparison that could drift from it. A node that has never
    // reported a version has never completed a `ready`, so it is not yet a
    // compatibility problem — only a version BELOW the floor is.
    const needingUpdate = agents.filter((a) => a.agentVersion !== null && !agentVersionSupported(a.agentVersion));
    const systemKeys = systemUserId ? listSystemKeys(systemUserId) : [];
    // "Active" must mean USABLE. An enabled key past its expiry cannot
    // authenticate, and the card calls each active key a full-access bearer
    // credential — counting a dead one there overstates the exposure an admin
    // is being asked to review.
    const now = Date.now();
    const activeKeys = systemKeys.filter(
      (k) => k.enabled === 1 && (k.expiresAt === null || Date.parse(k.expiresAt) > now),
    );

    return {
      versions: {
        server: SERVER_VERSION,
        nodeProtocol: NODE_PROTOCOL_VERSION,
        minAgent: MIN_AGENT_VERSION,
        bun: Bun.version,
      },
      runtime: {
        uptimeSeconds,
        // Derived, not recorded: process start is exactly now minus uptime,
        // and a stamp written during boot would only ever disagree with it.
        bootedAt: new Date(Date.now() - uptimeSeconds * 1000).toISOString(),
        pid: process.pid,
        os: platform.os,
        arch: platform.arch,
        hostname: hostname(),
        production: IS_PROD,
        memoryRssBytes: memory.rss,
        memoryHeapUsedBytes: memory.heapUsed,
        listenHost: HOST,
        listenPort: SERVER_PORT,
        appBaseUrl: APP_BASE_URL,
        staticSource: staticSource(),
        databasePath: DATABASE_PATH,
        databaseBytes: databaseBytes(DATABASE_PATH),
        tmuxPath: deploy.tmuxPath,
        mcpEntrypoint: deploy.mcpEntrypoint,
        mcpSource: deploy.mcpSource,
      },
      inventory: {
        ...inventory,
        // The socket registry is authoritative for reachability; `nodes.status`
        // is a projection that lags a crashed agent by up to the 60 s sweep.
        nodes: { total: inventory.nodes, online: listOnline().length, needingUpdate },
      },
      security: {
        registrationsOpen,
        emergencyLoginActive: emergencyLoginArmed(),
        usingPlaceholderSecret: AUTH_SECRET === PLACEHOLDER_AUTH_SECRET,
        systemKeys: { total: systemKeys.length, active: activeKeys.length },
      },
      generatedAt: new Date().toISOString(),
    };
  },
  {
    response: AdminStatusSchema,
    detail: {
      operationId: "getAdminStatus",
      tags: ["admin"],
      description:
        "Instance-wide status for admins: versions, runtime health, inventory counts and security posture. Cookie-admin only; bearer keys are refused. Carries no secret in any form.",
    },
  },
);
