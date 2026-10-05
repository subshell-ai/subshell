import { sql } from "kysely";
import { BaseRepository } from "@/db/repositories/base.repository.js";
import type { NewSshConnection, SshConnectionTable } from "@/db/types/ssh-connections.db-types.js";

/**
 * Persistence for `ssh_connections` (Gate A §4): the owner-scoped reads the
 * routes and the policy ask, and the revision-bumping write path.
 *
 * Revision discipline (spec §2 "Configuration edits create a new revision and
 * invalidate grants"): a snapshot-bearing update runs as ONE statement that
 * sets the snapshot AND `revision = revision + 1` AND `updated_at`, so a
 * concurrent grant never observes the new snapshot with the old revision. A
 * label/directory-only update rewrites no connection semantics, so it does not
 * bump (the frozen `SshUpdateConnectionRequest` doc pins the bump to the
 * snapshot arm); every EDIT is still gated for active work upstream.
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

  /** Patch the display facts WITHOUT a revision bump (label/remoteDir-only edit). */
  async updateLabel(id: string, patch: { displayName?: string; remoteDir?: string | null }): Promise<void> {
    await this.db
      .updateTable("sshConnections")
      .set({ ...patch, updatedAt: sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))` })
      .where("id", "=", id)
      .execute();
  }

  /**
   * Replace the snapshot AT A NEW REVISION, one statement (see class doc).
   * `remoteDir` rides the same write when the edit carried one.
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
