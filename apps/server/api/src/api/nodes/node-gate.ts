import type { NodeViewableAccess } from "@/api/nodes/node-view.js";
import { db } from "@/db/index.js";
import { NodeSharesRepository } from "@/db/repositories/node-shares.repository.js";
import { NodesRepository } from "@/db/repositories/nodes.repository.js";
import { UserMetaRepository } from "@/db/repositories/user-meta.repository.js";
import type { NodeShareTable } from "@/db/types/node-shares.db-types.js";
import type { NodeTable } from "@/db/types/nodes.db-types.js";
import { type NodeAccess, nodeCanManageFor, resolveNodeAccess } from "@/lib/node-access.js";

/**
 * Per-request authorization snapshot for one node — the shared front door of
 * every `/:id` registry route (spec 2026-08-31 §2/§9). The local-node admin
 * exception deliberately lives HERE (routes side), not in the pure resolver
 * (T3 ruling): `resolveNodeAccess` ranks admins at `edit`, never `owner`, so
 * "admins manage the seeded local node" is layered on as `canManage`.
 */
export interface NodeGate {
  /** The node row (present whenever the gate resolved). */
  row: NodeTable;
  /** Viewer-relative access (never "none" — that resolves to `undefined`). */
  access: NodeViewableAccess;
  /**
   * The same resolution WITHOUT the admin boost.
   *
   * `nodeCanLaunchOn` reads it for `local`, where an admin's instance-wide
   * `edit` must not stand in for the launch grant they just removed. Resolved
   * from the SAME share set as `access`, so the two readings cannot come from
   * two different queries.
   */
  granted: NodeAccess;
  /** Whether the viewer holds the admin role. */
  isAdmin: boolean;
  /** The node's grant rows, loaded once for the whole request. */
  shares: NodeShareTable[];
  /**
   * True for the real owner; additionally true for admins on `local` (whose
   * shares/rename-adjacent config admins manage). Delete layers its own
   * `local → 400` rule on top; rotate/shares use this as-is.
   */
  canManage: boolean;
}

/**
 * Load the row + grants, resolve access, and compute the manage gate in one
 * step. Absent node AND invisible node collapse to `undefined` — the caller
 * renders both as the same 404 so ids cannot be probed (never a 403 leak).
 * @param viewerId - The authenticated (cookie) user
 * @param nodeId - Node id from the route params
 */
export async function loadNodeGate(viewerId: string, nodeId: string): Promise<NodeGate | undefined> {
  const row = await new NodesRepository(db).findById(nodeId);
  if (!row) return undefined;
  const isAdmin = (await new UserMetaRepository(db).getRole(viewerId)) === "admin";
  const shares = await new NodeSharesRepository(db).listForNode(nodeId);
  const access = resolveNodeAccess(viewerId, isAdmin, row, shares);
  if (access === "none") return undefined;
  return {
    row,
    access,
    granted: resolveNodeAccess(viewerId, false, row, shares),
    isAdmin,
    shares,
    canManage: nodeCanManageFor(row.kind, access, isAdmin),
  };
}
