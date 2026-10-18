import { sql } from "kysely";
import { BaseRepository } from "@/db/repositories/base.repository.js";
import type { NewWorkspace, WorkspaceTable, WorkspaceUpdate } from "@/db/types/workspaces.db-types.js";

/**
 * Repository for per-user workspaces. Every read is scoped by user id — a
 * workspace is private to its owner.
 */
export class WorkspacesRepository extends BaseRepository {
  /** Inserts a workspace, stamping both timestamps. */
  async create(workspace: NewWorkspace): Promise<WorkspaceTable> {
    const now = new Date().toISOString();
    return this.db
      .insertInto("workspaces")
      .values({
        ...workspace,
        createdAt: now,
        updatedAt: now,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  /**
   * Looks a workspace up *and* checks ownership in one query. Ownership is part
   * of the signature so a caller cannot forget it.
   */
  async findByIdForUser(id: string, userId: string): Promise<WorkspaceTable | undefined> {
    return this.db
      .selectFrom("workspaces")
      .selectAll()
      .where("id", "=", id)
      .where("userId", "=", userId)
      .executeTakeFirst();
  }

  /** A user's workspaces, ordered by name. */
  async listByUser(userId: string): Promise<WorkspaceTable[]> {
    return this.db.selectFrom("workspaces").selectAll().where("userId", "=", userId).orderBy("name", "asc").execute();
  }

  /**
   * The caller's workspaces that hold a pane for one subshell, most recently
   * updated first. This answers "is this subshell already part of a workspace"
   * for the pane-header link.
   *
   * `EXISTS` rather than a join: the unique `(workspace_id, subshell_id)` index
   * (0058) makes double membership impossible now, but EXISTS also keeps the
   * row single even if the schema changes back.
   *
   * @param userId - Owner whose workspaces to search (never another user's)
   * @param subshellId - The subshell a pane must reference
   */
  async listBySubshellForUser(userId: string, subshellId: string): Promise<WorkspaceTable[]> {
    return this.db
      .selectFrom("workspaces")
      .selectAll()
      .where("userId", "=", userId)
      .where(({ exists, selectFrom }) =>
        exists(
          selectFrom("workspacePanes")
            .select("workspacePanes.id")
            .whereRef("workspacePanes.workspaceId", "=", "workspaces.id")
            .where("workspacePanes.subshellId", "=", subshellId),
        ),
      )
      .orderBy("updatedAt", "desc")
      .execute();
  }

  /**
   * Applies a partial update and returns the fresh row.
   *
   * The stamp is written in the SAME format as the column's default and as
   * `create` — `datetime('now')` yields `2026-09-14 10:00:00`, which sorts
   * BELOW every `2026-…T…Z` row under SQLite's string comparison (a space is
   * less than a `T`). `listBySubshellForUser` orders on this column, so a
   * renamed workspace would otherwise sort as the oldest thing the user owns.
   */
  async update(id: string, update: WorkspaceUpdate): Promise<WorkspaceTable | undefined> {
    await this.db
      .updateTable("workspaces")
      .set({ ...update, updatedAt: sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))` })
      .where("id", "=", id)
      .execute();
    return this.db.selectFrom("workspaces").selectAll().where("id", "=", id).executeTakeFirst();
  }

  /** Deletes a workspace; its panes cascade away. */
  async delete(id: string): Promise<void> {
    await this.db.deleteFrom("workspaces").where("id", "=", id).execute();
  }

  /**
   * The owner's workspaces holding a pane for one subshell, as ids. The
   * caller reads this BEFORE deleting the subshell, because the delete's own
   * cascade is what erases the evidence: after it, nothing can tell "this
   * delete emptied that workspace" from "it was already empty."
   *
   * `listBySubshellForUser` is the same question in row form; the delete path
   * wants only the ids, and wants them in one cheap statement.
   */
  async idsHoldingForUser(userId: string, subshellId: string): Promise<string[]> {
    const rows = await this.db
      .selectFrom("workspacePanes")
      .innerJoin("workspaces", "workspaces.id", "workspacePanes.workspaceId")
      .where("workspaces.userId", "=", userId)
      .where("workspacePanes.subshellId", "=", subshellId)
      .select("workspacePanes.workspaceId")
      .execute();
    return rows.map((r) => r.workspaceId);
  }

  /**
   * Deletes the named workspaces that now hold no panes, and returns how many
   * went. This is the runtime half of the empty-retire rule: the pane-removal
   * path retires the workspace it was asked about directly, while this sweep
   * catches the ones a subshell delete's cascade emptied (spec 2026-10-17:
   * "additionally deletes any workspace ITS cascade emptied"). The candidate
   * set IS the point: a workspace the delete never touched is not in it, so an
   * intentionally-empty workspace — the new-workspace dialog's "name it now,
   * fill it inside" answer — survives someone else's tab closing (review
   * 2026-10-17 caught the old owner-wide sweep eating those).
   *
   * Scoping by `userId` stays load-bearing on top of the candidate set: the
   * caller hands ids read from its own cascade, and a bug elsewhere must not
   * turn this into a foreign delete. Foreign owners' workspaces that held the
   * shared pane simply aren't in the set.
   */
  async retireEmptyAmong(userId: string, workspaceIds: string[]): Promise<number> {
    if (workspaceIds.length === 0) return 0;
    const result = await this.db
      .deleteFrom("workspaces")
      .where("userId", "=", userId)
      .where("id", "in", workspaceIds)
      .where(sql<boolean>`NOT EXISTS (SELECT 1 FROM workspace_panes wp WHERE wp.workspace_id = workspaces.id)`)
      .executeTakeFirst();
    return Number(result?.numDeletedRows ?? 0);
  }
}
