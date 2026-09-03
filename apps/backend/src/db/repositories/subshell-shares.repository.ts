import { BaseRepository } from "@/db/repositories/base.repository.js";
import type { SubshellSharePermission, SubshellShareTable } from "@/db/types/subshell-shares.db-types.js";

/** One entry of a replace: who gets what. A null grantee is the Everyone grant. */
export type ShareEntry = { granteeUserId: string | null; permission: SubshellSharePermission };

/**
 * Per-subshell access grants (spec 2026-08-31). A subshell is private to its
 * owner by default; these rows widen it to "Everyone" and/or named users at a
 * `view` or `edit` level. Authorization is decided from these rows elsewhere —
 * this repository only reads and rewrites them.
 */
export class SubshellSharesRepository extends BaseRepository {
  /** Every grant on one subshell, oldest first (stable order for the UI). */
  async listForSubshell(subshellId: string): Promise<SubshellShareTable[]> {
    return this.db
      .selectFrom("subshellShares")
      .selectAll()
      .where("subshellId", "=", subshellId)
      .orderBy("createdAt", "asc")
      .execute();
  }

  /**
   * Grants for many subshells in one query, bucketed by subshell id. Every
   * requested id appears in the map — with an empty array when it has no
   * shares — so callers can index without an undefined check.
   */
  async listForSubshells(subshellIds: string[]): Promise<Map<string, SubshellShareTable[]>> {
    const map = new Map<string, SubshellShareTable[]>(subshellIds.map((id) => [id, []]));
    if (subshellIds.length === 0) return map;
    const rows = await this.db
      .selectFrom("subshellShares")
      .selectAll()
      .where("subshellId", "in", subshellIds)
      .orderBy("createdAt", "asc")
      .execute();
    for (const row of rows) map.get(row.subshellId)?.push(row);
    return map;
  }

  /**
   * Overwrites a subshell's whole share list with `entries` (transactional
   * delete-then-insert, so a smaller new set leaves nothing stale). Returns the
   * rows as now stored.
   *
   * De-dupes by grantee BEFORE inserting: SQLite unique indexes can't constrain
   * the Everyone (NULL) grant — NULLs are always distinct — so a repeated
   * grantee, Everyone included, collapses to its last entry here rather than
   * producing duplicate rows.
   */
  async replaceForSubshell(
    subshellId: string,
    entries: ShareEntry[],
    createdBy: string,
  ): Promise<SubshellShareTable[]> {
    const collapsed = new Map<string, ShareEntry>();
    for (const e of entries) collapsed.set(e.granteeUserId ?? "\0everyone", e);
    const now = new Date().toISOString();
    await this.db.transaction().execute(async (tx) => {
      await tx.deleteFrom("subshellShares").where("subshellId", "=", subshellId).execute();
      if (collapsed.size > 0) {
        await tx
          .insertInto("subshellShares")
          .values(
            [...collapsed.values()].map((e) => ({
              id: crypto.randomUUID(),
              subshellId,
              granteeUserId: e.granteeUserId,
              permission: e.permission,
              createdBy,
              createdAt: now,
            })),
          )
          .execute();
      }
    });
    return this.listForSubshell(subshellId);
  }
}
