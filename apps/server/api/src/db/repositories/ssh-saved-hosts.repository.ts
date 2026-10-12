import { sql } from "kysely";
import { BaseRepository } from "@/db/repositories/base.repository.js";
import type { SshSavedHostTable } from "@/db/types/ssh-saved-hosts.db-types.js";

/**
 * Repository for the per-owner SSH destination ledger (spec 2026-10-07 §7,
 * migration 0048). The whole design fits in two sentences: a row's key is
 * (owner, canonical destination) so an edited alias can never re-point a
 * saved entry, and every launch refreshes recency whether or not a human ever
 * saved the row.
 *
 * The `New*` insert shape lives HERE, beside the repository, rather than in
 * `ssh-saved-hosts.db-types.ts` (the shape task-6 recorded as missing): every
 * column is NOT NULL-with-no-default except `alias`/`saved_at`, so an insert
 * is the full row and nothing is defaulted — there is no partial-write
 * vocabulary to type. `touch` and `markSaved` are its only callers.
 */
export type NewSshSavedHost = SshSavedHostTable;

/** The caller-composed facts one write carries; `at` is the caller's stamp (the repository owns no clock). */
interface LedgerWrite {
  ownerUserId: string;
  /** canonical `host:port` / `user@host:port` from `sshCanonicalDestination` — handoff 1: ONLY fields off a validated snapshot */
  destination: string;
  /** the connecting machine of THIS write — the row's node always follows the most recent launch */
  nodeId: string;
  /** display token; absent on update KEEPS the standing one (a bare-host launch does not erase an alias) */
  alias?: string | null;
  /** ISO 8601 the caller stamps as the act's time */
  at: string;
}

const RECENT_LIMIT = 20;

export class SshSavedHostsRepository extends BaseRepository {
  /**
   * Record a launch: upsert on (owner, destination) and refresh recency.
   * Never touches `saved_at` — that column is what the human gave and only
   * {@link markSaved} sets it.
   */
  async touch(write: LedgerWrite): Promise<void> {
    await this.db
      .insertInto("sshSavedHosts")
      .values({
        id: crypto.randomUUID(),
        ownerUserId: write.ownerUserId,
        destination: write.destination,
        alias: write.alias ?? null,
        nodeId: write.nodeId,
        savedAt: null,
        lastConnectAt: write.at,
      })
      .onConflict((oc) =>
        oc.columns(["ownerUserId", "destination"]).doUpdateSet({
          nodeId: write.nodeId,
          lastConnectAt: write.at,
          // COALESCE, not a plain set: an omitted alias must leave the display
          // token the human saw standing (the key is the destination; the
          // alias is what the list labels it with).
          alias: sql`COALESCE(excluded.alias, ssh_saved_hosts.alias)`,
        }),
      )
      .execute();
  }

  /**
   * Save a destination (upsert-mark-saved): the same refresh as {@link touch}
   * plus `saved_at`, returning the row so the route can answer with it.
   */
  async markSaved(write: LedgerWrite): Promise<SshSavedHostTable> {
    await this.db
      .insertInto("sshSavedHosts")
      .values({
        id: crypto.randomUUID(),
        ownerUserId: write.ownerUserId,
        destination: write.destination,
        alias: write.alias ?? null,
        nodeId: write.nodeId,
        savedAt: write.at,
        lastConnectAt: write.at,
      })
      .onConflict((oc) =>
        oc.columns(["ownerUserId", "destination"]).doUpdateSet({
          nodeId: write.nodeId,
          // Re-saving re-stamps the human's own act (it is a fresh save);
          // recency rides with it, same as a launch.
          savedAt: write.at,
          lastConnectAt: write.at,
          alias: sql`COALESCE(excluded.alias, ssh_saved_hosts.alias)`,
        }),
      )
      .execute();
    const row = await this.db
      .selectFrom("sshSavedHosts")
      .selectAll()
      .where("ownerUserId", "=", write.ownerUserId)
      .where("destination", "=", write.destination)
      .executeTakeFirst();
    // The upsert just wrote the key; a row that is not there now is a dropped
    // connection, not a state.
    if (!row) throw new Error(`ssh saved-host row vanished mid-write (${write.ownerUserId}/${write.destination})`);
    return row;
  }

  /** The owner's SAVED rows (a human stamped `saved_at`), newest save first, capped. */
  async listSaved(ownerUserId: string, limit = RECENT_LIMIT): Promise<SshSavedHostTable[]> {
    return await this.db
      .selectFrom("sshSavedHosts")
      .selectAll()
      .where("ownerUserId", "=", ownerUserId)
      .where("savedAt", "is not", null)
      .orderBy("savedAt", "desc")
      .limit(limit)
      .execute();
  }

  /** The owner's most-recently-connected destinations (saved or not), newest first, capped. */
  async listRecent(ownerUserId: string, limit = RECENT_LIMIT): Promise<SshSavedHostTable[]> {
    return await this.db
      .selectFrom("sshSavedHosts")
      .selectAll()
      .where("ownerUserId", "=", ownerUserId)
      .orderBy("lastConnectAt", "desc")
      .limit(limit)
      .execute();
  }

  /**
   * Delete one of the owner's rows. A foreign id and an absent id answer the
   * same `false` — the caller renders both as the 404 the ownership axis
   * demands (ids are never existence oracles, docs/security.md §3).
   */
  async remove(ownerUserId: string, id: string): Promise<boolean> {
    const res = await this.db
      .deleteFrom("sshSavedHosts")
      .where("id", "=", id)
      .where("ownerUserId", "=", ownerUserId)
      .executeTakeFirst();
    return Number(res.numDeletedRows ?? 0n) > 0;
  }
}
