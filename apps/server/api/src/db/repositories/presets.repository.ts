import { sql } from "kysely";
import { BaseRepository } from "@/db/repositories/base.repository.js";
import type { NewPreset, PresetTable, PresetUpdate } from "@/db/types/presets.db-types.js";

/**
 * Repository for harness presets — saved launch customisation for one harness
 * (spec 2026-09-13). Deleting one NULLS `subshells.preset_id` on the rows that
 * used it rather than failing or cascading: their restart falls back to the
 * empty preset instead of dying, because restart re-reads the row each time
 * and "availability is computed, never stored" (spec §6).
 */
export class PresetsRepository extends BaseRepository {
  async create(preset: NewPreset): Promise<PresetTable> {
    const now = new Date().toISOString();
    return this.db
      .insertInto("presets")
      .values({
        ...preset,
        // restartOnExit (0003) defaults in the DB; mirror it here so the row
        // is complete on read-back.
        restartOnExit: preset.restartOnExit ?? 0,
        createdAt: now,
        updatedAt: now,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  async findById(id: string): Promise<PresetTable | undefined> {
    return this.db.selectFrom("presets").selectAll().where("id", "=", id).executeTakeFirst();
  }

  async listByUser(userId: string, harnessId?: string): Promise<PresetTable[]> {
    let query = this.db.selectFrom("presets").selectAll().where("userId", "=", userId).orderBy("name", "asc");
    if (harnessId) query = query.where("harnessId", "=", harnessId);
    return query.execute();
  }

  async update(id: string, update: PresetUpdate): Promise<PresetTable | undefined> {
    await this.db
      .updateTable("presets")
      .set({ ...update, updatedAt: sql`(datetime('now'))` })
      .where("id", "=", id)
      .execute();
    return this.findById(id);
  }

  /**
   * Delete one preset, nulling the references first (one transaction): a
   * subshell that used it survives as a presetless one, and its next restart
   * composes from the empty preset instead of erroring (spec §6 ruling).
   */
  async delete(id: string): Promise<void> {
    await this.db.transaction().execute(async (tx) => {
      await tx.updateTable("subshells").set({ presetId: null }).where("presetId", "=", id).execute();
      await tx.deleteFrom("presets").where("id", "=", id).execute();
    });
  }

  /**
   * Every user's presets for one harness (the uninstall impact read). The
   * instance-level plugins door reaches across owners because an instance
   * uninstall reaches across owners — `listByUser` cannot answer that.
   */
  async listByHarness(harnessId: string): Promise<PresetTable[]> {
    return this.db
      .selectFrom("presets")
      .selectAll()
      .where("harnessId", "=", harnessId)
      .orderBy("userId")
      .orderBy("name")
      .execute();
  }

  /**
   * Deletes every preset for one harness, across EVERY user, and returns how
   * many rows went — the `uninstall?mode=delete` bulk sweep. References are
   * nullled the same way {@link delete} nulls them (one transaction), so
   * subshells that used a swept preset keep restarting presetless. There is no
   * undeletable row any more: with the Default seeding gone, every preset a
   * harness owns is real customisation someone made.
   */
  async deleteByHarness(harnessId: string): Promise<number> {
    return this.db.transaction().execute(async (tx) => {
      await tx
        .updateTable("subshells")
        .set({ presetId: null })
        .where("presetId", "in", (eb) => eb.selectFrom("presets").select("id").where("harnessId", "=", harnessId))
        .execute();
      const res = await tx.deleteFrom("presets").where("harnessId", "=", harnessId).executeTakeFirst();
      const counts = res as unknown as { numDeletedRows?: number | bigint };
      return Number(counts.numDeletedRows ?? 0);
    });
  }
}
