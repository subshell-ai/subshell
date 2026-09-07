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

  /** All of a user's workspaces, ordered by name. */
  async listByUser(userId: string): Promise<WorkspaceTable[]> {
    return this.db.selectFrom("workspaces").selectAll().where("userId", "=", userId).orderBy("name", "asc").execute();
  }

  /** Applies a partial update and returns the fresh row. */
  async update(id: string, update: WorkspaceUpdate): Promise<WorkspaceTable | undefined> {
    await this.db
      .updateTable("workspaces")
      .set({ ...update, updatedAt: sql`(datetime('now'))` })
      .where("id", "=", id)
      .execute();
    return this.db.selectFrom("workspaces").selectAll().where("id", "=", id).executeTakeFirst();
  }

  /** Deletes a workspace; its panes cascade away. */
  async delete(id: string): Promise<void> {
    await this.db.deleteFrom("workspaces").where("id", "=", id).execute();
  }
}
