import type { Kysely } from "kysely";
import { HttpError } from "@/api/auth-guard.js";
import { PresetSharesRepository } from "@/db/repositories/preset-shares.repository.js";
import { PresetsRepository } from "@/db/repositories/presets.repository.js";
import { SshPresetsRepository } from "@/db/repositories/ssh-presets.repository.js";
import type { ShareEntry } from "@/db/repositories/subshell-shares.repository.js";
import { UsersRepository } from "@/db/repositories/users.repository.js";
import type { Database } from "@/db/types/index.js";
import { presetAccess } from "@/lib/preset-access.js";

/** The owner alone controls grants, even when another viewer can edit the preset. */
export async function presetShares(db: Kysely<Database>, viewerId: string, id: string, entries?: ShareEntry[]) {
  const agent = await new PresetsRepository(db).findById(id);
  const row = agent ?? (await new SshPresetsRepository(db).findById(id));
  const kind = agent ? "agent" : "ssh";
  if (!row) throw new HttpError(404, "Preset not found");
  const access = await presetAccess(db, kind, row, viewerId);
  if (access === "none") throw new HttpError(404, "Preset not found");
  if (access !== "owner") throw new HttpError(403, "Only the owner can manage preset sharing.");
  const users = new UsersRepository(db);
  const shares = new PresetSharesRepository(db);
  if (entries) {
    const named = entries.flatMap((entry) => (entry.granteeUserId === null ? [] : [entry.granteeUserId]));
    const names = await users.displayNamesByIds(named);
    if (named.some((id) => !names.has(id))) throw new HttpError(400, "Cannot share with an unknown user");
    await shares.replace(kind, id, entries, viewerId);
  }
  const rows = await shares.list(kind, [id]);
  const names = await users.displayNamesByIds(
    rows.flatMap((row) => (row.granteeUserId === null ? [] : [row.granteeUserId])),
  );
  return {
    shares: rows.map((row) => ({
      id: row.id,
      granteeUserId: row.granteeUserId,
      permission: row.permission,
      granteeName: row.granteeUserId === null ? "Everyone" : (names.get(row.granteeUserId) ?? row.granteeUserId),
    })),
  };
}
