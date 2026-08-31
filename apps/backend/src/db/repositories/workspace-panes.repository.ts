import { sql } from "kysely";
import { BaseRepository } from "@/db/repositories/base.repository.js";
import type { NewWorkspacePane, WorkspacePaneTable } from "@/db/types/workspace-panes.db-types.js";

/**
 * Repository for workspace panes. Panes are reached through their workspace,
 * so ownership is checked one level up before any of these run.
 */
export class WorkspacePanesRepository extends BaseRepository {
  /** All panes of a workspace, oldest first — the fallback tab order. */
  async listByWorkspace(workspaceId: string): Promise<WorkspacePaneTable[]> {
    return this.db
      .selectFrom("workspacePanes")
      .selectAll()
      .where("workspaceId", "=", workspaceId)
      .orderBy("createdAt", "asc")
      .execute();
  }

  /** Inserts a pane, stamping both timestamps. */
  async create(pane: NewWorkspacePane): Promise<WorkspacePaneTable> {
    const now = new Date().toISOString();
    return this.db
      .insertInto("workspacePanes")
      .values({
        ...pane,
        createdAt: now,
        updatedAt: now,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  /** Removes a single pane. */
  async delete(id: string): Promise<void> {
    await this.db.deleteFrom("workspacePanes").where("id", "=", id).execute();
  }

  /** Pane count for one workspace — the "how full is it" number on API responses. */
  async countForWorkspace(workspaceId: string): Promise<number> {
    const row = await this.db
      .selectFrom("workspacePanes")
      .select(({ fn }) => fn.countAll<number>().as("n"))
      .where("workspaceId", "=", workspaceId)
      .executeTakeFirst();
    return row?.n ?? 0;
  }

  /**
   * Pane counts for every workspace of one user, in a single grouped query —
   * the list endpoint merges these in so cards can show their session count
   * without an N+1. Workspaces with no panes have no entry; treat a missing
   * key as zero.
   */
  async countByUser(userId: string): Promise<Map<string, number>> {
    const rows = await this.db
      .selectFrom("workspacePanes")
      .innerJoin("workspaces", "workspaces.id", "workspacePanes.workspaceId")
      .where("workspaces.userId", "=", userId)
      .select(["workspacePanes.workspaceId", sql<number>`count(*)`.as("n")])
      .groupBy("workspacePanes.workspaceId")
      .execute();
    return new Map(rows.map((r) => [r.workspaceId, Number(r.n)]));
  }
}
