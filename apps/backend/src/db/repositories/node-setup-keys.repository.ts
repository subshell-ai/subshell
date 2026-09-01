import { createHash, randomBytes } from "node:crypto";
import { BaseRepository } from "@/db/repositories/base.repository.js";
import type { NodeSetupKeyTable } from "@/db/types/node-setup-keys.db-types.js";

/** 24 h default lifetime for a fresh setup key (spec §5.1). */
export const SETUP_KEY_TTL_MS = 24 * 60 * 60 * 1000;

/** SHA-256 hex of a plaintext key — the only form ever stored or compared. */
function hashKey(plaintext: string): string {
  return createHash("sha256").update(plaintext).digest("hex");
}

/**
 * Single-use node enrollment keys (spec §5.1/§5.2): one-time `nsk_…` codes a
 * new agent redeems exactly once to create its node row. The plaintext exists
 * only in {@link NodeSetupKeysRepository.create}'s result — at rest only the
 * SHA-256 hex lives in the database.
 */
export class NodeSetupKeysRepository extends BaseRepository {
  /**
   * Mints a fresh key for a user.
   * @param label - Human label ("mac mini")
   * @param ownerUserId - Creator (also the future node owner)
   * @param ttlMs - Lifetime from now (default {@link SETUP_KEY_TTL_MS})
   * @returns the stored row and the never-persisted plaintext
   */
  async create(
    label: string,
    ownerUserId: string,
    ttlMs: number = SETUP_KEY_TTL_MS,
  ): Promise<{ row: NodeSetupKeyTable; plaintext: string }> {
    const plaintext = `nsk_${randomBytes(24).toString("base64url")}`;
    const now = new Date();
    const row = await this.db
      .insertInto("nodeSetupKeys")
      .values({
        id: crypto.randomUUID(),
        ownerUserId,
        label,
        keyHash: hashKey(plaintext),
        createdAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
        usedAt: null,
        consumedNodeId: null,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    return { row, plaintext };
  }

  /** One key row by id. */
  async findById(id: string): Promise<NodeSetupKeyTable | undefined> {
    return await this.db.selectFrom("nodeSetupKeys").selectAll().where("id", "=", id).executeTakeFirst();
  }

  /** A user's keys, newest first (the settings list). */
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
    // sessions.repository's update-count guard.
    const counts = res as unknown as { numDeleted?: number | bigint; numDeletedRows?: number | bigint };
    return Number(counts?.numDeletedRows ?? counts?.numDeleted ?? 0);
  }

  /**
   * Consumption-free validity probe — download/install gate, spec §5.1/§8.
   * Answers "would this plaintext redeem right now?" without flipping
   * `usedAt`, so the agent's download step can gate on it before enrolling.
   * @param plaintext - The `nsk_…` code as presented (hashed before the lookup)
   * @returns true when a key with this hash exists, is unused, and unexpired
   */
  async peekValid(plaintext: string): Promise<boolean> {
    const keyHash = hashKey(plaintext);
    const row = await this.db
      .selectFrom("nodeSetupKeys")
      .select("id")
      .where("keyHash", "=", keyHash)
      .where("usedAt", "is", null)
      .where("expiresAt", ">", new Date().toISOString())
      .executeTakeFirst();
    return row !== undefined;
  }

  /**
   * Transactionally redeems a presented plaintext for a new node (spec §5.2).
   * Returns the key row on success (unused and unexpired), null otherwise —
   * wrong hash, already used, or expired all read as null. The flip
   * (`usedAt`) re-checks `usedAt is null` inside the same transaction and the
   * rows-affected count decides the winner, so two concurrent consumers of
   * one plaintext can never both redeem.
   * @param plaintext - The `nsk_…` code as presented (hashed before the lookup)
   * @param nodeId - Node being created by this redemption
   */
  async consume(plaintext: string, nodeId: string): Promise<NodeSetupKeyTable | null> {
    const keyHash = hashKey(plaintext);
    const nowIso = new Date().toISOString();
    return this.db.transaction().execute(async (tx) => {
      const row = await tx
        .selectFrom("nodeSetupKeys")
        .selectAll()
        .where("keyHash", "=", keyHash)
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
      // sessions.repository documents). Zero rows = another consumer won the
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
