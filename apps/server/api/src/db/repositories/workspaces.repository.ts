import { sql } from "kysely";
import { BaseRepository } from "@/db/repositories/base.repository.js";
import type { NewWorkspace, WorkspaceTable, WorkspaceUpdate } from "@/db/types/workspaces.db-types.js";

/**
 * Repository for per-user workspaces. Every read is scoped by user id — a
 * workspace is private to its owner.
 */
export class WorkspacesRepository extends BaseRepository {
  /** Inserts a workspace, stamping both timestamps. An omitted `draft` means saved. */
  async create(workspace: NewWorkspace): Promise<WorkspaceTable> {
    const now = new Date().toISOString();
    return this.db
      .insertInto("workspaces")
      .values({
        ...workspace,
        draft: workspace.draft ?? 0,
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

  /**
   * A user's workspaces, ordered by name. **Drafts are excluded by default** —
   * an unsaved workspace is not something the Workspaces page or the sidebar
   * should list, so the caller has to ask for them.
   *
   * @param userId - Owner whose workspaces to list
   * @param opts.includeDrafts - true also returns unsaved drafts
   */
  async listByUser(userId: string, opts?: { includeDrafts?: boolean }): Promise<WorkspaceTable[]> {
    let query = this.db.selectFrom("workspaces").selectAll().where("userId", "=", userId);
    if (!opts?.includeDrafts) query = query.where("draft", "=", 0);
    return query.orderBy("name", "asc").execute();
  }

  /**
   * The caller's workspaces that hold a pane for one subshell, most recently
   * updated first. **Drafts are included** — this is what answers "is this
   * subshell already part of a workspace", and a freshly split draft is
   * precisely the case worth surfacing.
   *
   * `EXISTS` rather than a join: a subshell could in principle occupy two panes
   * of one workspace, and a join would then return that workspace twice.
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
}
