import { sql } from "kysely";
import { BaseRepository } from "@/db/repositories/base.repository.js";
import type { NewSshConnection, SshConnectionTable } from "@/db/types/ssh-connections.db-types.js";

/**
 * Persistence for `ssh_connections` (Gate A §4): the owner-scoped reads the
 * routes and the policy ask, and the revision-bumping write path.
 *
 * Revision discipline (spec §2 "Configuration edits create a new revision and
 * invalidate grants", pinned by review fix I-1): a snapshot-BEARING update
 * runs as ONE statement that sets the new value(s) AND `revision = revision +
 * 1` AND `updated_at`, so a concurrent grant never observes new execution
 * semantics with the old revision. `remoteDir` IS execution semantics (every
 * run's default directory), so it rides that atomic +1 write even when the
 * snapshot itself is unchanged; `displayName` is the ONLY non-bumping edit (a
 * label names nothing that runs). Every EDIT is still gated for active work
 * upstream.
 */
export class SshConnectionsRepository extends BaseRepository {
  async create(connection: NewSshConnection): Promise<SshConnectionTable> {
    const now = new Date().toISOString();
    return this.db
      .insertInto("sshConnections")
      .values({ ...connection, revision: connection.revision ?? 1, createdAt: now, updatedAt: now })
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  async findById(id: string): Promise<SshConnectionTable | undefined> {
    return this.db.selectFrom("sshConnections").selectAll().where("id", "=", id).executeTakeFirst();
  }

  /** The owner's connections, newest first (settings list; the policy never reads lists). */
  async listByOwner(userId: string): Promise<SshConnectionTable[]> {
    return this.db
      .selectFrom("sshConnections")
      .selectAll()
      .where("userId", "=", userId)
      .orderBy("createdAt", "desc")
      .orderBy("id", "asc")
      .execute();
  }

  /**
   * Patch the display label WITHOUT a revision bump - the ONLY non-bumping
   * edit (`displayName` rewrites nothing that runs). A remoteDir or snapshot
   * change must NOT come through here; it belongs on {@link updateSnapshot}.
   */
  async updateLabel(id: string, patch: { displayName: string }): Promise<void> {
    await this.db
      .updateTable("sshConnections")
      .set({ ...patch, updatedAt: sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))` })
      .where("id", "=", id)
      .execute();
  }

  /**
   * The revision-bearing write, one statement (see class doc): a snapshot
   * edit, a `remoteDir` edit, or both move together with `revision + 1` - a
   * standalone remoteDir change bumps the revision on purpose (review fix
   * I-1: it is execution semantics, so prior grants must go stale).
   */
  async updateSnapshot(
    id: string,
    patch: { configSnapshot: string; displayName?: string; remoteDir?: string | null },
  ): Promise<void> {
    await this.db
      .updateTable("sshConnections")
      .set({
        ...patch,
        revision: sql`revision + 1`,
        updatedAt: sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`,
      })
      .where("id", "=", id)
      .execute();
  }

  async delete(id: string): Promise<void> {
    await this.db.deleteFrom("sshConnections").where("id", "=", id).execute();
  }
}
