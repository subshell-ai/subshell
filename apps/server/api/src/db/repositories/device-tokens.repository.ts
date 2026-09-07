import type { Kysely } from "kysely";
import type { DevicePlatform, DeviceTokenTable } from "@/db/types/device-tokens.db-types.js";
import type { Database } from "@/db/types/index.js";

/**
 * One row per enrolled native device. `token` is globally unique — a
 * re-enrolling device (even under another user) replaces the row, because the
 * token IS the device's mailbox: only its current holder can be written to
 * it. Mirrors `NotificationsRepository`; see there for the full rationale.
 */
export class DeviceTokensRepository {
  constructor(private readonly db: Kysely<Database>) {}

  /**
   * Transactional delete-then-insert (same reasoning as
   * `NotificationsRepository.upsertForUser`): ownership may legitimately
   * change (OS restore, reinstall → new sign-in), and the transaction closes
   * the window so a concurrent send sees either the old row or the new one,
   * never nothing — and one concurrent upsert of the same token wins cleanly
   * instead of tripping the unique index.
   * @param userId - The enrolling user
   * @param token - Expo push token (unique across devices)
   * @param platform - OS the token was minted on
   */
  async upsertForUser(userId: string, token: string, platform: DevicePlatform): Promise<void> {
    const now = new Date().toISOString();
    await this.db.transaction().execute(async (tx) => {
      await tx.deleteFrom("deviceTokens").where("token", "=", token).execute();
      await tx
        .insertInto("deviceTokens")
        .values({ id: crypto.randomUUID(), userId, token, platform, createdAt: now, updatedAt: now })
        .execute();
    });
  }

  /** @param userId - Owner @returns Every device enrolled to this user */
  async listByUser(userId: string): Promise<DeviceTokenTable[]> {
    return this.db.selectFrom("deviceTokens").selectAll().where("userId", "=", userId).execute();
  }

  /** Scoped removal (user-initiated deregistration) — silently no-ops for another owner's token. */
  async deleteForUser(userId: string, token: string): Promise<void> {
    await this.db.deleteFrom("deviceTokens").where("userId", "=", userId).where("token", "=", token).execute();
  }

  /** Unscoped removal (send-time pruning: the relay said this token is dead). */
  async deleteByToken(token: string): Promise<void> {
    await this.db.deleteFrom("deviceTokens").where("token", "=", token).execute();
  }
}
