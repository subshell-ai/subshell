import { type Static, t } from "elysia";
import { db } from "@/db/index.js";
import { NodeAllowedDirsRepository } from "@/db/repositories/node-allowed-dirs.repository.js";
import { UsersRepository } from "@/db/repositories/users.repository.js";
import type { NodeShareTable } from "@/db/types/node-shares.db-types.js";
import type { NodeTable } from "@/db/types/nodes.db-types.js";
import { type NodeAccess, nodeCanManageFor } from "@/lib/node-access.js";
import { type EffectiveHarnessReport, effectiveHarnessStates } from "@/services/nodes/inventory.js";
import { enabledInstalledPlugins } from "@/services/nodes/local-plugins.js";
import { localPlatform } from "@/services/nodes/seed-local.js";

/**
 * Node registry view schemas + mappers (spec 2026-08-31 §9) — the shared
 * rendering layer behind list/detail so the two never drift.
 *
 * `harnesses` is the merge in `services/nodes/inventory.ts →
 * effectiveHarnessStates`: one row per plugin the INSTANCE has installed and
 * enabled, crossed with that node's binary detection — live for `local`, the
 * cached inventory for an agent (false until the first detection lands). The
 * node declares nothing any more (spec 2026-09-10); the instance store is the
 * single catalog behind every node's rows.
 * Staleness is a PER-NODE flag (`inventoryStale`) — a cached detection ages
 * as a unit, so tagging individual entries would only repeat the same boolean
 * across every row; a stale node still reports its last-known `installed`
 * values (the view is informational — the launch gate is the strict one).
 */

/**
 * Access levels a view can carry — "none" never has a view (invisible nodes
 * are 404/absent), so the wire schema and the mappers speak the narrowed type.
 */
export type NodeViewableAccess = Exclude<NodeAccess, "none">;

/** The viewer's effective access on this node; "none" is never rendered (invisible → 404/absent). */
export const NodeAccessSchema = t.Union([t.Literal("owner"), t.Literal("edit"), t.Literal("view")], {
  description: "Caller's effective access on this node (none is never rendered, invisible nodes 404)",
});

/** One harness row of a node view — plugin identity × per-node state. */
export const NodeHarnessViewSchema = t.Object({
  harnessId: t.String({ description: "Harness plugin id" }),
  name: t.String({ description: "Plugin display name from the instance store's manifest" }),
  installed: t.Boolean({
    description:
      "local: live binary probe; enrolled node: the cached detect answer (false until the first detect lands)",
  }),
  version: t.Optional(t.String({ description: "Installed version from the node's inventory (enrolled nodes)" })),
  reason: t.Optional(
    t.Union([t.Literal("not-on-path"), t.Literal("override-invalid"), t.Literal("no-binary")], {
      description:
        "Why there is no binary, when there is not (`no-binary` means the plugin declares none). Per entry rather than per node, because one harness can be missing while another has a bad env override",
    }),
  ),
  broken: t.Optional(
    t.String({
      description:
        "Why the plugin cannot be used at all (it failed to load in the control-plane process — an instance fact, true for every node). Present means the row is shown so a reader can see the reason, not that the plugin is absent",
    }),
  ),
  restartRequired: t.Optional(
    t.Boolean({
      description:
        "The instance holds a newer copy of this plugin than the code the control-plane process is running, so the plugin-derived fields here are the previous copy's. Note this is NOT about `version` on this row, which is the driven program's version and is unaffected. Cleared when the server restarts",
    }),
  ),
  checkedAt: t.Optional(
    t.String({
      description:
        "ISO 8601 stamp of when this entry was probed. Absent from a node running an agent older than the field",
    }),
  ),
});

/**
 * True when this node's harness entries were resolved from data that may not
 * match reality: an agent whose cached inventory is older than the 10-min
 * TTL OR has never landed. Per-node (not per-entry) by design — the
 * inventory ages as a unit. `local` is always false (live probe per read).
 */
export const InventoryStaleSchema = t.Boolean({
  description:
    "Agent: cached inventory older than the 10-min TTL (or never reported); installed values are last-known, not live. local: always false",
});

/** One node as the registry routes render it — no secrets, no machine keys. */
export const NodeViewSchema = t.Object({
  id: t.String({ description: "Node id (the control-plane host is literally 'local')" }),
  name: t.String({ description: "Display name (unique per owner)" }),
  kind: t.Union([t.Literal("local"), t.Literal("agent")], { description: "Control-plane host vs enrolled node" }),
  os: t.Nullable(t.String({ description: "Reported OS" }), {
    description: "Reported OS (local: the server's own platform in the view), null until first ready",
  }),
  arch: t.Nullable(t.String({ description: "Reported CPU architecture" }), {
    description: "Reported CPU architecture (local: the server's own platform in the view), null until first ready",
  }),
  hostname: t.Nullable(t.String({ description: "Reported hostname" }), {
    description: "Reported hostname, null until first ready",
  }),
  status: t.Union([t.Literal("online"), t.Literal("offline")], {
    description: "Status projection; the live node socket is authoritative",
  }),
  lastSeenAt: t.Nullable(t.String({ description: "ISO 8601 of the last heartbeat/ready" }), {
    description: "ISO 8601 of the last heartbeat/ready, null when never seen",
  }),
  agentVersion: t.Nullable(t.String({ description: "subshell version from `ready`" }), {
    description: "subshell version, null until first ready",
  }),
  protocolVersion: t.Nullable(t.Number({ description: "Node protocol version from `ready`" }), {
    description: "Node protocol version, null until first ready (the UI's node-too-old check, spec §9)",
  }),
  access: NodeAccessSchema,
  canManage: t.Boolean({
    description:
      "Whether the caller manages this node (delete/re-share/rotate): real owner, or an admin on `local`; same rule as the route gate",
  }),
  capabilities: t.Array(t.String({ description: "Capability string" }), {
    description: "Capability strings from `ready` (empty when none reported)",
  }),
  allowedDirs: t.Array(t.String({ description: "Absolute directory a subshell may be launched under" }), {
    description:
      "Directories subshells may be created in on this node. EMPTY MEANS UNRESTRICTED, never 'nothing permitted'. Readable by anyone who can see the node; a refused directory is unexplainable without it; only the owner may change it",
  }),
  harnesses: t.Array(NodeHarnessViewSchema, {
    description:
      "One row per plugin the INSTANCE has installed and enabled, crossed with this node's binary detection (spec 2026-09-10: the node declares nothing; the instance store is the catalog)",
  }),
  inventoryStale: InventoryStaleSchema,
});

/** A node as rendered to one viewer. */
export type NodeView = Static<typeof NodeViewSchema>;
/** One harness row of a node view. */
export type NodeHarnessView = Static<typeof NodeHarnessViewSchema>;

// Shared TypeBox refs for the sharing schemas (models.ts discipline: one
// object reused across body and response keeps the composed `App` shallow).
const SharePermissionSchema = t.Union([t.Literal("view"), t.Literal("edit")], {
  description: "Access level a grant confers",
});
const GranteeIdSchema = t.Nullable(t.String({ description: "Grantee user id" }), {
  description: "Grantee user id, or null for the Everyone grant",
});

/** One sharing grant on a node, with the grantee's display name resolved. */
export const NodeShareSchema = t.Object({
  id: t.String({ description: "Share row id" }),
  granteeUserId: GranteeIdSchema,
  granteeName: t.Nullable(t.String({ description: "Grantee display name" }), {
    description: "Grantee display name ('Everyone' for the null grant; the id when the user is gone)",
  }),
  permission: SharePermissionSchema,
});

/** Response of both GET and PUT node-shares routes: the full current grant set. */
export const NodeSharesResponseSchema = t.Object({
  shares: t.Array(NodeShareSchema, { description: "Every grant currently on the node" }),
});

/** Body of PUT /api/nodes/:id/shares — the complete replacement set. */
export const SetNodeSharesBodySchema = t.Object({
  shares: t.Array(
    t.Object({
      granteeUserId: t.Optional(GranteeIdSchema),
      permission: SharePermissionSchema,
    }),
    { description: "The grants to keep; any prior grant not listed here is removed" },
  ),
});

/** `GET /api/nodes/:id` — the view plus the grant set, ONLY when the viewer can configure. */
export const GetNodeResponseSchema = t.Object({
  ...NodeViewSchema.properties,
  shares: t.Optional(t.Array(NodeShareSchema, { description: "Full grant set (config-capable viewers only)" })),
});

/** The `NodeTable.capabilities` JSON → string[]; junk or null reads as empty. */
function parseCapabilities(json: string | null): string[] {
  if (!json) return [];
  try {
    const parsed: unknown = JSON.parse(json);
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/**
 * Everything but the harness merge — the one place row→view fields are mapped.
 * `local`'s os/arch fall back to this process (see the inline note) — the only
 * row where the view is permitted to know more than the table.
 */
function nodeViewBase(row: NodeTable, access: NodeViewableAccess, isAdmin: boolean, allowedDirs: string[]) {
  return {
    // Empty = unrestricted (see the schema note). Passed in rather than read
    // here so the list path can batch one query for every row.
    allowedDirs,
    id: row.id,
    name: row.name,
    kind: row.kind,
    // `local` never sends `ready`, so its row CAN hold null os/arch (the seed
    // fills them only at creation) — report the control-plane host's real
    // platform from the view (spec 2026-09-02 §4b) so launch-picker labels
    // never read "null/null". Same canonical mapping the seed writes.
    os: row.kind === "local" ? (row.os ?? localPlatform().os) : row.os,
    arch: row.kind === "local" ? (row.arch ?? localPlatform().arch) : row.arch,
    hostname: row.hostname,
    status: row.status,
    lastSeenAt: row.lastSeenAt,
    agentVersion: row.agentVersion,
    // Task 15's "agent too old" chip reads this against NODE_PROTOCOL_VERSION.
    protocolVersion: row.protocolVersion,
    access,
    // The SAME rule the route gate applies — shared helper, so view and gate
    // can never drift (T14 review carry: the frontend cannot derive admin identity).
    canManage: nodeCanManageFor(row.kind, access, isAdmin),
    capabilities: parseCapabilities(row.capabilities),
  };
}

/**
 * Render one node row for a viewer at a known access level.
 * @param isAdmin - Whether the viewer holds the admin role (drives the
 *  seeded-`local` exception inside `canManage`)
 */
export async function toNodeView(row: NodeTable, access: NodeViewableAccess, isAdmin: boolean): Promise<NodeView> {
  const { harnesses, stale } = await effectiveHarnessStates(row);
  const allowedDirs = await new NodeAllowedDirsRepository(db).listForNode(row.id);
  return { ...nodeViewBase(row, access, isAdmin, allowedDirs), harnesses, inventoryStale: stale };
}

/**
 * Render rows already paired with the viewer's access + admin flag. The
 * instance catalog is read once and the local node's live probe is computed
 * at most once per call (a list is local + N agents — one probe batch and one
 * disk pass, not one per row).
 */
export async function toNodeViews(
  entries: { row: NodeTable; access: NodeViewableAccess; isAdmin: boolean }[],
): Promise<NodeView[]> {
  let localReport: EffectiveHarnessReport | undefined;
  const out: NodeView[] = [];
  // ONE read of the instance store for every row — rows differ per node only
  // in their detection half, so a list must not pay the disk pass per row.
  const installed = await enabledInstalledPlugins();
  // ONE query for every row's rules, not one per row — the same batching the
  // catalog read above gets, for the same reason.
  const dirsBy = await new NodeAllowedDirsRepository(db).listForNodes(entries.map((e) => e.row.id));
  for (const { row, access, isAdmin } of entries) {
    const allowedDirs = dirsBy.get(row.id) ?? [];
    if (row.kind === "local") {
      localReport ??= await effectiveHarnessStates(row, installed);
      out.push({
        ...nodeViewBase(row, access, isAdmin, allowedDirs),
        harnesses: localReport.harnesses,
        inventoryStale: localReport.stale,
      });
    } else {
      const { harnesses, stale } = await effectiveHarnessStates(row, installed);
      out.push({ ...nodeViewBase(row, access, isAdmin, allowedDirs), harnesses, inventoryStale: stale });
    }
  }
  return out;
}

/** Share rows → wire shape with grantee display names resolved (subshell-shares mirror). */
export async function toNodeShareViews(rows: NodeShareTable[]): Promise<Static<typeof NodeShareSchema>[]> {
  const named = rows.map((r) => r.granteeUserId).filter((x): x is string => x !== null);
  const names = await new UsersRepository(db).displayNamesByIds(named);
  return rows.map((r) => ({
    id: r.id,
    granteeUserId: r.granteeUserId,
    granteeName: r.granteeUserId === null ? "Everyone" : (names.get(r.granteeUserId) ?? r.granteeUserId),
    permission: r.permission,
  }));
}
