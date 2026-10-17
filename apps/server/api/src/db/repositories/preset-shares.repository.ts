import { BaseRepository } from "@/db/repositories/base.repository.js";
import type { ShareEntry } from "@/db/repositories/subshell-shares.repository.js";

export type PresetKind = "agent" | "ssh";

/** The two preset kinds use the same grant contract with independent foreign keys. */
export class PresetSharesRepository extends BaseRepository {
  async list(kind: PresetKind, ids: string[]) {
    if (!ids.length) return [];
    return this.db
      .selectFrom(kind === "agent" ? "presetShares" : "sshPresetShares")
      .selectAll()
      .where("presetId", "in", ids)
      .orderBy("createdAt")
      .execute();
  }

  async replace(kind: PresetKind, presetId: string, entries: ShareEntry[], createdBy: string) {
    const table = kind === "agent" ? "presetShares" : "sshPresetShares";
    const unique = new Map(entries.map((entry) => [entry.granteeUserId, entry]));
    await this.db.transaction().execute(async (tx) => {
      await tx.deleteFrom(table).where("presetId", "=", presetId).execute();
      if (unique.size)
        await tx
          .insertInto(table)
          .values(
            [...unique.values()].map((entry) => ({
              ...entry,
              id: crypto.randomUUID(),
              presetId,
              createdBy,
              createdAt: new Date().toISOString(),
            })),
          )
          .execute();
    });
    return this.list(kind, [presetId]);
  }
}
