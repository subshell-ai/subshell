import type { Kysely } from "kysely";
import { type PresetKind, PresetSharesRepository } from "@/db/repositories/preset-shares.repository.js";
import { UsersRepository } from "@/db/repositories/users.repository.js";
import type { Database } from "@/db/types/index.js";
import { resolveSubshellAccess } from "@/modules/subshells/access.js";

/** No admin override; machine actors retain owner-only preset access. */
export async function presetAccess(
  db: Kysely<Database>,
  kind: PresetKind,
  row: { id: string; userId: string },
  viewerId: string,
  allowShares = true,
) {
  if (row.userId === viewerId) return "owner" as const;
  return resolveSubshellAccess(
    viewerId,
    row.userId,
    allowShares ? await new PresetSharesRepository(db).list(kind, [row.id]) : [],
  );
}

/** Batch grants once for a list, preserving the same effective-access resolver. */
export async function withPresetAccess<T extends { id: string; userId: string }>(
  db: Kysely<Database>,
  kind: PresetKind,
  rows: T[],
  viewerId: string,
  allowShares = true,
) {
  const shares = allowShares
    ? await new PresetSharesRepository(db).list(
        kind,
        rows.map((row) => row.id),
      )
    : [];
  const names = await new UsersRepository(db).displayNamesByIds([...new Set(rows.map((row) => row.userId))]);
  return rows.flatMap((row) => {
    const access = resolveSubshellAccess(
      viewerId,
      row.userId,
      shares.filter((share) => share.presetId === row.id),
    );
    return access === "none" ? [] : [{ ...row, access, ownerName: names.get(row.userId) ?? row.userId }];
  });
}

/** Mutations return the same owner label as lists, so optimistic cache updates keep attribution. */
export async function presetOwnerName(db: Kysely<Database>, userId: string): Promise<string> {
  return (await new UsersRepository(db).displayNamesByIds([userId])).get(userId) ?? userId;
}
