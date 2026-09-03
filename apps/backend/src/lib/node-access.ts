import type { NodeSharesRepository } from "@/db/repositories/node-shares.repository.js";
import type { NodesRepository } from "@/db/repositories/nodes.repository.js";
import type { UserMetaRepository } from "@/db/repositories/user-meta.repository.js";
import type { NodeSharePermission } from "@/db/types/node-shares.db-types.js";
import type { NodeKind, NodeTable } from "@/db/types/nodes.db-types.js";

/**
 * A viewer's effective access to one node (spec 2026-08-31 §2). Viewer-relative:
 * the same node is `owner` to its creator, `edit`/`view` to a grantee, and
 * `none` to everyone else. Admins resolve to `edit` (spec §1: instance-wide
 * effective operator access, not ownership) — delete and re-share stay with the
 * real owner and are enforced by the routes via `nodeCanManage`.
 */
export type NodeAccess = "owner" | "edit" | "view" | "none";

const RANK: Record<NodeAccess, number> = { none: 0, view: 1, edit: 2, owner: 3 };

/**
 * Pure resolver — no DB. Given the caller's identity, the node row's ownership,
 * and its grant rows, returns the highest access that applies.
 *
 * Order (spec §2): owner wins outright (an admin viewing their OWN node is
 * `owner`, not `edit`); else an admin gets `edit`; else the highest of the
 * Everyone grant and any grant naming this viewer; else `none`.
 *
 * @param viewerId - The signed-in user asking
 * @param isAdmin - Whether that user holds the admin role
 * @param node - The node being accessed (only `id`/`ownerUserId` read)
 * @param shares - The node's grant rows (only `granteeUserId`/`permission` read)
 */
export function resolveNodeAccess(
  viewerId: string,
  isAdmin: boolean,
  node: { id: string; ownerUserId: string },
  shares: { granteeUserId: string | null; permission: NodeSharePermission }[],
): NodeAccess {
  if (viewerId === node.ownerUserId) return "owner";
  if (isAdmin) return "edit";
  let best: NodeAccess = "none";
  for (const s of shares) {
    if (s.granteeUserId !== null && s.granteeUserId !== viewerId) continue;
    if (RANK[s.permission] > RANK[best]) best = s.permission;
  }
  return best;
}

/**
 * TRUE when ANY share level grants launch — deliberately NOT the subshell rule,
 * where launch sits at edit. Product decision (spec 2026-08-31 §2): a `view`
 * grantee may start subshells on a node (launching is not configuring); the
 * capability rule for nodes is — any share grants launch; edit/owner grants
 * config; delete + managing shares require owner, EXCEPT the seeded `local`
 * node, whose shares/config admins manage (routes add that exception, since the
 * resolver ranks admins at `edit`, never `owner`).
 */
export function nodeCanLaunch(access: NodeAccess): boolean {
  return access !== "none";
}

/** True when the viewer may change node config (shares, harness state, rename). */
export function nodeCanConfigure(access: NodeAccess): boolean {
  return access === "owner" || access === "edit";
}

/** True only for the real owner — delete and re-share (routes layer on the local-node admin exception). */
export function nodeCanManage(access: NodeAccess): boolean {
  return access === "owner";
}

/**
 * THE manage rule, in one place: the real owner, or an admin on the seeded
 * `local` node (T3 ruling — the resolver ranks admins at `edit`, never
 * `owner`, so the local-node admin exception is layered on here). Both the
 * route gate (`loadNodeGate`) and the rendered views (`node-view.ts`) derive
 * `canManage` from this call so the rule can never drift between them.
 *
 * @param rowKind - The node's kind (only `local` opens the admin exception)
 * @param access - The viewer's resolved access on the row
 * @param isAdmin - Whether the viewer holds the admin role
 */
export function nodeCanManageFor(rowKind: NodeKind, access: NodeAccess, isAdmin: boolean): boolean {
  return nodeCanManage(access) || (rowKind === "local" && isAdmin);
}

/** The repositories `loadNodeAccess` needs — injected so tests use a scratch DB. */
export interface NodeAccessDeps {
  nodes: NodesRepository;
  shares: NodeSharesRepository;
  userMeta: UserMetaRepository;
}

/**
 * Loads a node and resolves one viewer's access to it in a single step, so
 * every gate (HTTP, RPC, launch) asks the same question the same way — the node
 * mirror of `loadSubshellAccess` (spec 2026-08-31 §2).
 *
 * A missing node is NOT an error here — it returns `{ row: undefined,
 * access: "none" }` so the caller can map it to the same 404 as an invisible
 * node (never leaking that the id exists).
 *
 * @param opts.allowAdminAndShares - `true` (default) for a human in a browser:
 * admins get effective edit and shared grants count. Pass `false` for a machine
 * bearer token — it may act ONLY on its own owner's nodes, never on foreign or
 * shared ones and never via the admin boost (no grant or role lookup happens at
 * all, keeping the machine path as strict as a plain owner check).
 */
export async function loadNodeAccess(
  deps: NodeAccessDeps,
  viewerId: string,
  nodeId: string,
  opts: { allowAdminAndShares?: boolean } = {},
): Promise<{ row: NodeTable | undefined; access: NodeAccess }> {
  const row = await deps.nodes.findById(nodeId);
  if (!row) return { row: undefined, access: "none" };
  const allow = opts.allowAdminAndShares ?? true;
  const isAdmin = allow && (await deps.userMeta.getRole(viewerId)) === "admin";
  const shares = allow ? await deps.shares.listForNode(nodeId) : [];
  return { row, access: resolveNodeAccess(viewerId, isAdmin, row, shares) };
}
