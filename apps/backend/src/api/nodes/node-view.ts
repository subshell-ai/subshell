import { ALL_HARNESSES, type HarnessInventoryEntry } from "@internal/harnesses";
import { type Static, t } from "elysia";
import { harnessEnabledStates } from "@/api/harness-utils.js";
import { db } from "@/db/index.js";
import { NodeHarnessesRepository } from "@/db/repositories/node-harnesses.repository.js";
import { UsersRepository } from "@/db/repositories/users.repository.js";
import type { NodeShareTable } from "@/db/types/node-shares.db-types.js";
import type { NodeTable } from "@/db/types/nodes.db-types.js";
import type { NodeAccess } from "@/lib/node-access.js";

/**
 * Node registry view schemas + mappers (spec 2026-08-31 §9) — the shared
 * rendering layer behind list/detail so the two never drift.
 *
 * `harnesses` is the PHASE-1 RAW merge (Task 10 refines it in its own
 * commit): enabled state from the per-node/per-instance lazy rows (absent
 * row → plugin default), installed/version from the local probe (`local`)
 * or the cached agent inventory (`agent`, false until the first inventory
 * lands).
 */

/**
 * Access levels a view can carry — "none" never has a view (invisible nodes
 * are 404/absent), so the wire schema and the mappers speak the narrowed type.
 */
export type NodeViewableAccess = Exclude<NodeAccess, "none">;

/** The viewer's effective access on this node; "none" is never rendered (invisible → 404/absent). */
export const NodeAccessSchema = t.Union([t.Literal("owner"), t.Literal("edit"), t.Literal("view")], {
  description: "Caller's effective access on this node (none is never rendered — invisible nodes 404)",
});

/** One harness row of a node view — plugin identity × per-node state. */
export const NodeHarnessViewSchema = t.Object({
  harnessId: t.String({ description: "Harness plugin id" }),
  enabled: t.Boolean({ description: "Explicit node state when set, else the plugin's default" }),
  installed: t.Boolean({
    description: "local: live binary probe; agent: cached inventory (false until the first inventory lands)",
  }),
  version: t.Optional(t.String({ description: "Installed version from the agent's inventory (agent nodes)" })),
});

/** One node as the registry routes render it — no secrets, no machine keys. */
export const NodeViewSchema = t.Object({
  id: t.String({ description: "Node id (the control-plane host is literally 'local')" }),
  name: t.String({ description: "Display name (unique per owner)" }),
  kind: t.Union([t.Literal("local"), t.Literal("agent")], { description: "Control-plane host vs enrolled agent" }),
  os: t.Nullable(t.String({ description: "Reported OS" }), { description: "Reported OS, null until first ready" }),
  arch: t.Nullable(t.String({ description: "Reported CPU architecture" }), {
    description: "Reported CPU architecture, null until first ready",
  }),
  hostname: t.Nullable(t.String({ description: "Reported hostname" }), {
    description: "Reported hostname, null until first ready",
  }),
  status: t.Union([t.Literal("online"), t.Literal("offline")], {
    description: "Status projection; the live agent socket is authoritative",
  }),
  lastSeenAt: t.Nullable(t.String({ description: "ISO 8601 of the last heartbeat/ready" }), {
    description: "ISO 8601 of the last heartbeat/ready, null when never seen",
  }),
  agentVersion: t.Nullable(t.String({ description: "mote-agent version from `ready`" }), {
    description: "mote-agent version, null until first ready",
  }),
  access: NodeAccessSchema,
  capabilities: t.Array(t.String({ description: "Capability string" }), {
    description: "Capability strings from `ready` (empty when none reported)",
  }),
  harnesses: t.Array(NodeHarnessViewSchema, { description: "Every registered harness × this node's state" }),
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

/** The `NodeTable.inventoryJson` snapshot → harnessId → entry; junk reads as empty. */
function parseInventory(json: string | null): Map<string, HarnessInventoryEntry> {
  if (!json) return new Map();
  try {
    const parsed: unknown = JSON.parse(json);
    if (!Array.isArray(parsed)) return new Map();
    const out = new Map<string, HarnessInventoryEntry>();
    for (const e of parsed) {
      const entry = e as Partial<HarnessInventoryEntry>;
      if (typeof entry?.harnessId === "string") out.set(entry.harnessId, entry as HarnessInventoryEntry);
    }
    return out;
  } catch {
    return new Map();
  }
}

/** local node: instance-wide enable state × live install probe (no version — Task 10). */
async function localHarnessViews(): Promise<NodeHarnessView[]> {
  const states = await harnessEnabledStates();
  return await Promise.all(
    ALL_HARNESSES.map(async (h) => ({
      harnessId: h.id,
      enabled: states.get(h.id) ?? h.enabledByDefault,
      installed: await h.isInstalled(),
    })),
  );
}

/** agent node: per-node enable state × the cached inventory snapshot (false until one lands). */
async function agentHarnessViews(row: NodeTable): Promise<NodeHarnessView[]> {
  const states = await new NodeHarnessesRepository(db).enabledStates(row.id);
  const inv = parseInventory(row.inventoryJson);
  return ALL_HARNESSES.map((h) => {
    const e = inv.get(h.id);
    const view: NodeHarnessView = {
      harnessId: h.id,
      enabled: states.get(h.id) ?? h.enabledByDefault,
      installed: e?.installed === true,
    };
    if (e?.version) view.version = e.version;
    return view;
  });
}

/** Render one node row for a viewer at a known access level. */
export async function toNodeView(row: NodeTable, access: NodeViewableAccess): Promise<NodeView> {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    os: row.os,
    arch: row.arch,
    hostname: row.hostname,
    status: row.status,
    lastSeenAt: row.lastSeenAt,
    agentVersion: row.agentVersion,
    access,
    capabilities: parseCapabilities(row.capabilities),
    harnesses: row.kind === "local" ? await localHarnessViews() : await agentHarnessViews(row),
  };
}

/**
 * Render rows already paired with the viewer's access. The local node's
 * install-probe set is computed at most once per call (a list is local +
 * N agents — one probe batch, not one per row).
 */
export async function toNodeViews(entries: { row: NodeTable; access: NodeViewableAccess }[]): Promise<NodeView[]> {
  let localViews: NodeHarnessView[] | undefined;
  const out: NodeView[] = [];
  for (const { row, access } of entries) {
    if (row.kind === "local") {
      localViews ??= await localHarnessViews();
      out.push({ ...(await toNodeView(row, access)), harnesses: localViews });
    } else {
      out.push(await toNodeView(row, access));
    }
  }
  return out;
}

/** Share rows → wire shape with grantee display names resolved (session-shares mirror). */
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
