import { sql } from "kysely";
import { BaseRepository } from "@/db/repositories/base.repository.js";
import type { NodeSharePermission, NodeShareTable } from "@/db/types/node-shares.db-types.js";
import { NodeSharesConflictError } from "@/modules/nodes/errors.js";

/**
 * One entry of a replace: who gets what. A null grantee is the Everyone
 * grant. Deliberately its own type — node shares and subshell shares are
 * separate contracts (spec §2), not aliases of each other.
 */
export type NodeShareEntry = { granteeUserId: string | null; permission: NodeSharePermission };

/**
 * Per-node access grants — the node mirror of `subshell-shares.repository`
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
   *
   * When `expectRowIds` is given, the replace becomes an optimistic-
   * concurrency write: the stored rows must still be exactly that set, or
   * nothing changes and {@link NodeSharesConflictError} is thrown. The check
   * runs AFTER a lock-taking touch of the node row, because SQLite has one
   * writer at a time and a transaction's read snapshot must start once this
   * write is the winner — a revoked manager's in-flight PUT then reads the
   * revocation, mismatches, and lands a 409 instead of re-minting itself.
   */
  async replaceForNode(
    nodeId: string,
    entries: NodeShareEntry[],
    createdBy: string,
    expectRowIds?: string[],
  ): Promise<NodeShareTable[]> {
    const collapsed = new Map<string, NodeShareEntry>();
    for (const e of entries) collapsed.set(e.granteeUserId ?? "\0everyone", e);
    const now = new Date().toISOString();
    await this.db.transaction().execute(async (tx) => {
      if (expectRowIds) {
        // No-op self-assignment: takes the single-writer lock without
        // changing the row, so the comparison below sees every concurrently
        // committed write (this transaction blocks until the prior writer
        // lands, and later writers block behind us).
        await tx.updateTable("nodes").set({ updatedAt: sql<string>`updated_at` }).where("id", "=", nodeId).execute();
        const current = (await tx.selectFrom("nodeShares").select("id").where("nodeId", "=", nodeId).execute()) as {
          id: string;
        }[];
        const currentIds = current.map((r) => r.id).sort();
        const expected = [...expectRowIds].sort();
        if (currentIds.length !== expected.length || currentIds.some((id, i) => id !== (expected[i] ?? ""))) {
          throw new NodeSharesConflictError();
        }
      }
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
