import { BaseRepository } from "@/db/repositories/base.repository.js";
import type { SshHostPinTable } from "@/db/types/ssh-host-pins.db-types.js";

/**
 * Repository for the M2 host-key TOFU store (spec 2026-10-08 §9; the table
 * ships in migration 0050, this file is T12's logic on it). The row key is
 * the UNIQUE `(owner_user_id, destination)`: one pin per owner per resolved
 * `user@host:port`, independent of grants (one grant selector over many hosts
 * yields many pins, and a grant's revoke never touches a pin - the pin is the
 * owner's TOFU record, not the grant's property).
 *
 * The capture path has ONE write: {@link insertPin}. There is deliberately NO
 * update-by-key write here: a differing key for a pinned destination is §9's
 * hard block, not a row to overwrite - recovery is {@link deletePin} plus a
 * fresh capture at the next grant creation. `host_key` is a PUBLIC known_hosts
 * line, and the row is the durable record the audit names only a fingerprint
 * of; nothing in this file logs or echoes the bytes.
 *
 * Every read and write is OWNER-SCOPED at the WHERE clause, the saved-hosts
 * posture verbatim: a foreign row is absent, never "forbidden".
 */
export class SshHostPinsRepository extends BaseRepository {
  /** Record a capture. The caller validated the row (line grammar, key choice). */
  async insertPin(pin: SshHostPinTable): Promise<void> {
    await this.db.insertInto("sshHostPins").values(pin).execute();
  }

  /** The owner's pin for one canonical destination; null when unpinned. */
  async getPin(ownerUserId: string, destination: string): Promise<SshHostPinTable | null> {
    const row = await this.db
      .selectFrom("sshHostPins")
      .selectAll()
      .where("ownerUserId", "=", ownerUserId)
      .where("destination", "=", destination)
      .executeTakeFirst();
    return row ?? null;
  }

  /**
   * Re-stamp `updated_at` after an ACCEPTED match (a capture at the same key
   * agreeing with the standing pin). The row's key, id, and bytes never move
   * - only the "last accepted match" stamp does, and only on a match: a
   * differing key is §9's block, not an update.
   */
  async touchPin(ownerUserId: string, destination: string, at: string): Promise<void> {
    await this.db
      .updateTable("sshHostPins")
      .set({ updatedAt: at })
      .where("ownerUserId", "=", ownerUserId)
      .where("destination", "=", destination)
      .execute();
  }

  /** The owner's pins for the trust screen, newest first. */
  async listPins(ownerUserId: string): Promise<SshHostPinTable[]> {
    return await this.db
      .selectFrom("sshHostPins")
      .selectAll()
      .where("ownerUserId", "=", ownerUserId)
      .orderBy("createdAt", "desc")
      .execute();
  }

  /**
   * Delete one of the owner's pins; false for foreign AND absent (one 404
   * at the route). The §9 recovery half: TOFU re-decides after a delete, so
   * the next capture at a differing key SUCCEEDS as a new first-capture
   * rather than overwriting the old one.
   */
  async deletePin(ownerUserId: string, destination: string): Promise<boolean> {
    const res = await this.db
      .deleteFrom("sshHostPins")
      .where("ownerUserId", "=", ownerUserId)
      .where("destination", "=", destination)
      .executeTakeFirst();
    return Number(res.numDeletedRows ?? 0n) > 0;
  }
}
