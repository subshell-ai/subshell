import { BaseRepository } from "@/db/repositories/base.repository.js";
import type { NodeSharePermission, NodeShareTable } from "@/db/types/node-shares.db-types.js";

/**
 * One entry of a replace: who gets what. A null grantee is the Everyone
 * grant. Deliberately its own type — node shares and session shares are
 * separate contracts (spec §2), not aliases of each other.
 */
export type NodeShareEntry = { granteeUserId: string | null; permission: NodeSharePermission };

/**
 * Per-node access grants — the node mirror of `session-shares.repository`
 * (spec 2026-08-31 §2). A node is private to its owner by default; these rows
 * widen it to "Everyone" and/or named users at a `view` or `edit` level.
 * Authorization is decided from these rows elsewhere — this repository only
 * reads and rewrites them.
 */
export class NodeSharesRepository extends BaseRepository {
  /** Every grant on one node, oldest first (stable order for the UI). */
  async listForNode(nodeId: string): Promise<NodeShareTable[]> {
    return this.db
      .selectFrom("nodeShares")
      .selectAll()
      .where("nodeId", "=", nodeId)
      .orderBy("createdAt", "asc")
      .execute();
  }

  /**
   * Grants for many nodes in one query, bucketed by node id. Every requested
   * id appears in the map — with an empty array when it has no shares — so
   * callers can index without an undefined check.
   */
  async listForNodes(nodeIds: string[]): Promise<Map<string, NodeShareTable[]>> {
    const map = new Map<string, NodeShareTable[]>(nodeIds.map((id) => [id, []]));
    if (nodeIds.length === 0) return map;
    const rows = await this.db
      .selectFrom("nodeShares")
      .selectAll()
      .where("nodeId", "in", nodeIds)
      .orderBy("createdAt", "asc")
      .execute();
    for (const row of rows) map.get(row.nodeId)?.push(row);
    return map;
  }

  /**
   * Overwrites a node's whole share list with `entries` (transactional
   * delete-then-insert, so a smaller new set leaves nothing stale). Returns
   * the rows as now stored.
   *
   * De-dupes by grantee BEFORE inserting: SQLite unique indexes can't
   * constrain the Everyone (NULL) grant — NULLs are always distinct — so a
   * repeated grantee, Everyone included, collapses to its last entry here
   * rather than producing duplicate rows.
   */
  async replaceForNode(nodeId: string, entries: NodeShareEntry[], createdBy: string): Promise<NodeShareTable[]> {
    const collapsed = new Map<string, NodeShareEntry>();
    for (const e of entries) collapsed.set(e.granteeUserId ?? " everyone", e);
    const now = new Date().toISOString();
    await this.db.transaction().execute(async (tx) => {
      await tx.deleteFrom("nodeShares").where("nodeId", "=", nodeId).execute();
      if (collapsed.size > 0) {
        await tx
          .insertInto("nodeShares")
          .values(
            [...collapsed.values()].map((e) => ({
              id: crypto.randomUUID(),
              nodeId,
              granteeUserId: e.granteeUserId,
              permission: e.permission,
              createdBy,
              createdAt: now,
            })),
          )
          .execute();
      }
    });
    return this.listForNode(nodeId);
  }
}
