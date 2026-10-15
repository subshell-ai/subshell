import { sql } from "kysely";
import { BaseRepository } from "@/db/repositories/base.repository.js";
import type { SshRecentDestinationTable } from "@/db/types/ssh-recent-destinations.db-types.js";

/** Per-owner connection history, keyed by the canonical resolved destination. */
export type NewSshRecentDestination = SshRecentDestinationTable;

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

export class SshRecentDestinationsRepository extends BaseRepository {
  /** Record a successful launch, keeping an existing display alias when none is supplied. */
  async touch(write: LedgerWrite): Promise<void> {
    await this.db
      .insertInto("sshRecentDestinations")
      .values({
        id: crypto.randomUUID(),
        ownerUserId: write.ownerUserId,
        destination: write.destination,
        alias: write.alias ?? null,
        nodeId: write.nodeId,
        lastConnectAt: write.at,
      })
      .onConflict((oc) =>
        oc.columns(["ownerUserId", "destination"]).doUpdateSet({
          nodeId: write.nodeId,
          lastConnectAt: write.at,
          // COALESCE, not a plain set: an omitted alias must leave the display
          // token the human saw standing (the key is the destination; the
          // alias is what the list labels it with).
          alias: sql`COALESCE(excluded.alias, ssh_recent_destinations.alias)`,
        }),
      )
      .execute();
  }

  /** The owner's recent destinations, newest first and capped. */
  async listRecent(ownerUserId: string, limit = RECENT_LIMIT): Promise<SshRecentDestinationTable[]> {
    return await this.db
      .selectFrom("sshRecentDestinations")
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
      .deleteFrom("sshRecentDestinations")
      .where("id", "=", id)
      .where("ownerUserId", "=", ownerUserId)
      .executeTakeFirst();
    return Number(res.numDeletedRows ?? 0n) > 0;
  }
}
