import { sql } from "kysely";
import { BaseRepository } from "@/db/repositories/base.repository.js";
import type { NewSshGrant, SshGrantTable } from "@/db/types/ssh-grants.db-types.js";

/**
 * Persistence for `ssh_grants` (Gate A §4). Grant rows are HISTORY: revoking
 * stamps `revoked_at` and the row stays reachable until its pane is deleted
 * (then it cascades - callers must never resolve "who authorized this" off a
 * grant id resolving forever; `ssh_runs.api_key_id` is that durable fact).
 *
 * The reads are the ones migration 0047's indexes exist to answer cheaply:
 * the active-tuple probe (the partial unique), the pane's live grants
 * (terminate sweep), and the connection+revision reconciliation read.
 */
export class SshGrantsRepository extends BaseRepository {
  async create(grant: NewSshGrant): Promise<SshGrantTable> {
    return this.db
      .insertInto("sshGrants")
      .values({ ...grant, revokedAt: grant.revokedAt ?? null, grantedAt: sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))` })
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  async findById(id: string): Promise<SshGrantTable | undefined> {
    return this.db.selectFrom("sshGrants").selectAll().where("id", "=", id).executeTakeFirst();
  }

  /**
   * The ACTIVE grant for the exact tuple (connection, pane, current key).
   * This is the row the granted-use gate re-asks on every operation.
   */
  async findActive(connectionId: string, subshellId: string, apiKeyId: string): Promise<SshGrantTable | undefined> {
    return this.db
      .selectFrom("sshGrants")
      .selectAll()
      .where("connectionId", "=", connectionId)
      .where("subshellId", "=", subshellId)
      .where("apiKeyId", "=", apiKeyId)
      .where("revokedAt", "is", null)
      .executeTakeFirst();
  }

  /**
   * A REVOKED row for the tuple, if one exists: the policy asks it only to
   * answer `grant_revoked` (the row is there, the state says stop) rather
   * than `not_granted` (never issued) - the distinction the SPA shows.
   */
  async findRevoked(connectionId: string, subshellId: string, apiKeyId: string): Promise<SshGrantTable | undefined> {
    return this.db
      .selectFrom("sshGrants")
      .selectAll()
      .where("connectionId", "=", connectionId)
      .where("subshellId", "=", subshellId)
      .where("apiKeyId", "=", apiKeyId)
      .where("revokedAt", "is not", null)
      .orderBy("grantedAt", "desc")
      .executeTakeFirst();
  }

  /** Every grant row (active and revoked history) for one connection, newest first. */
  async listByConnection(connectionId: string): Promise<SshGrantTable[]> {
    return this.db
      .selectFrom("sshGrants")
      .selectAll()
      .where("connectionId", "=", connectionId)
      .orderBy("grantedAt", "desc")
      .orderBy("id", "asc")
      .execute();
  }

  /** The pane's LIVE grants (terminate/cascade reads; revision matching is the caller's check). */
  async listActiveForPane(subshellId: string): Promise<SshGrantTable[]> {
    return this.db
      .selectFrom("sshGrants")
      .selectAll()
      .where("subshellId", "=", subshellId)
      .where("revokedAt", "is", null)
      .execute();
  }

  /**
   * Stamp the active grant for a (connection, pane) pair - ANY key generation
   * the pane has ever been granted with, since revocation is the human's
   * "stop this pane" act, not a per-credential detail. Returns the ids it
   * stamped (empty when none was active).
   */
  async revokeActiveForPair(connectionId: string, subshellId: string): Promise<string[]> {
    const rows = await this.db
      .selectFrom("sshGrants")
      .select("id")
      .where("connectionId", "=", connectionId)
      .where("subshellId", "=", subshellId)
      .where("revokedAt", "is", null)
      .execute();
    if (rows.length === 0) return [];
    await this.db
      .updateTable("sshGrants")
      .set({ revokedAt: sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))` })
      .where(
        "id",
        "in",
        rows.map((r) => r.id),
      )
      .execute();
    return rows.map((r) => r.id);
  }

  /** Revoke one grant by id (the id the list answers; owner gate is the caller's). */
  async revokeById(id: string): Promise<void> {
    await this.db
      .updateTable("sshGrants")
      .set({ revokedAt: sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))` })
      .where("id", "=", id)
      .where("revokedAt", "is", null)
      .execute();
  }
}
