import { randomBytes } from "node:crypto";
import { BaseRepository } from "@/db/repositories/base.repository.js";
import type { NodeSetupKeyTable } from "@/db/types/node-setup-keys.db-types.js";

/** 24 h default lifetime for a fresh setup key (spec §5.1). */
export const SETUP_KEY_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Single-use node enrollment keys (spec §5.1/§5.2): one-time `nsk_…` codes a
 * new agent redeems exactly once to create its node row.
 *
 * Every lookup is BY THE KEY ITSELF (`peekValid`, `peekByKey`, `consume` all
 * match `key` = the presented text). Until 2026-09-17 each of those hashed
 * first and matched `key_hash`; the digest went when the Setup keys page began
 * listing its keys, because a page cannot render what it cannot un-hash. The
 * guess-one-full-key property is unchanged — 192 random bits either way — and
 * what widens is only what a database read reveals about a key that is
 * deliberately being shared. Accounting: `docs/security.md`.
 */
export class NodeSetupKeysRepository extends BaseRepository {
  /**
   * Mints a fresh key for a user.
   *
   * The row IS the reveal: `key` holds the minted plaintext and there is no
   * second, never-persisted copy to keep straight.
   *
   * @param ownerUserId - Creator (also the future node owner)
   * @param ttlMs - Lifetime from now (default {@link SETUP_KEY_TTL_MS})
   */
  async create(ownerUserId: string, ttlMs: number = SETUP_KEY_TTL_MS): Promise<NodeSetupKeyTable> {
    const now = new Date();
    return await this.db
      .insertInto("nodeSetupKeys")
      .values({
        id: crypto.randomUUID(),
        ownerUserId,
        key: `nsk_${randomBytes(24).toString("base64url")}`,
        createdAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
        usedAt: null,
        consumedNodeId: null,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  /** One key row by id. */
  async findById(id: string): Promise<NodeSetupKeyTable | undefined> {
    return await this.db.selectFrom("nodeSetupKeys").selectAll().where("id", "=", id).executeTakeFirst();
  }

  /** A user's keys, newest first (the Setup keys card). */
  async listByUser(ownerUserId: string): Promise<NodeSetupKeyTable[]> {
    return await this.db
      .selectFrom("nodeSetupKeys")
      .selectAll()
      .where("ownerUserId", "=", ownerUserId)
      .orderBy("createdAt", "desc")
      .execute();
  }

  /**
   * Revokes a key. Only the owner's row is touched.
   * @returns rows deleted (0 = wrong id or wrong owner)
   */
  async deleteById(id: string, ownerUserId: string): Promise<number> {
    const res = await this.db
      .deleteFrom("nodeSetupKeys")
      .where("id", "=", id)
      .where("ownerUserId", "=", ownerUserId)
      .executeTakeFirst();
    // Same dialect quirk as updates: kysely-bun-sqlite-dialect hands back
    // `numDeletedRows` (a bigint); read both spellings defensively, like
    // subshells.repository's update-count guard.
    const counts = res as unknown as { numDeleted?: number | bigint; numDeletedRows?: number | bigint };
    return Number(counts?.numDeletedRows ?? counts?.numDeleted ?? 0);
  }

  /**
   * Consumption-free validity probe — download/install gate, spec §5.1/§8.
   * Answers "would this key redeem right now?" without flipping `usedAt`, so
   * the agent's download step can gate on it before enrolling.
   * @param key - The `nsk_…` code as presented
   * @returns true when such a key exists, is unused, and unexpired
   */
  async peekValid(key: string): Promise<boolean> {
    const row = await this.db
      .selectFrom("nodeSetupKeys")
      .select("id")
      .where("key", "=", key)
      .where("usedAt", "is", null)
      .where("expiresAt", ">", new Date().toISOString())
      .executeTakeFirst();
    return row !== undefined;
  }

  /**
   * Read-only STATE probe by key text (ledger 17a): lets the enroll route
   * distinguish INVALID / CONSUMED / EXPIRED BEFORE the key is spent.
   * Deliberately narrow — one SELECT, no transaction, flips nothing; `consume`
   * stays the single-winner redemption step.
   * @param key - The `nsk_…` code as presented
   * @returns the key's state, or undefined when no such key exists
   */
  async peekByKey(key: string): Promise<{ usedAt: string | null; expiresAt: string } | undefined> {
    return await this.db
      .selectFrom("nodeSetupKeys")
      .select(["usedAt", "expiresAt"])
      .where("key", "=", key)
      .executeTakeFirst();
  }

  /**
   * Transactionally redeems a presented key for a new node (spec §5.2).
   * Returns the key row on success (unused and unexpired), null otherwise —
   * no such key, already used, or expired all read as null. The flip
   * (`usedAt`) re-checks `usedAt is null` inside the same transaction and the
   * rows-affected count decides the winner, so two concurrent consumers of
   * one key can never both redeem.
   * @param key - The `nsk_…` code as presented
   * @param nodeId - Node being created by this redemption
   */
  async consume(key: string, nodeId: string): Promise<NodeSetupKeyTable | null> {
    const nowIso = new Date().toISOString();
    return this.db.transaction().execute(async (tx) => {
      const row = await tx
        .selectFrom("nodeSetupKeys")
        .selectAll()
        .where("key", "=", key)
        .where("usedAt", "is", null)
        .where("expiresAt", ">", nowIso)
        .executeTakeFirst();
      if (!row) return null;
      const res = await tx
        .updateTable("nodeSetupKeys")
        .set({ usedAt: nowIso, consumedNodeId: nodeId })
        .where("id", "=", row.id)
        .where("usedAt", "is", null)
        .executeTakeFirst();
      // Kysely types this as `numUpdated`, but kysely-bun-sqlite-dialect hands
      // back `numUpdatedRows` (a bigint) at runtime — read both (the quirk
      // subshells.repository documents). Zero rows = another consumer won the
      // race; this one gets nothing.
      const counts = res as unknown as { numUpdated?: number | bigint; numUpdatedRows?: number | bigint };
      if (Number(counts?.numUpdatedRows ?? counts?.numUpdated ?? 0) === 0) return null;
      // Return the POST-flip state (usedAt + consumedNodeId set), re-read in
      // the same transaction — callers redeem a key and then look at what
      // they just spent; handing back the pre-UPDATE row made the winner's
      // copy read as still-unused.
      return await tx.selectFrom("nodeSetupKeys").selectAll().where("id", "=", row.id).executeTakeFirstOrThrow();
    });
  }
}
