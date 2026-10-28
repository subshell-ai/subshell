import { type Kysely, sql } from "kysely";

interface AccountKey {
  id: string;
  providerId: string;
  accountId: string;
  issuer: string | null;
}

/** Better Auth 1.7.3+ no longer writes the required issuer added by 1.7.1. */
export async function up(db: Kysely<any>): Promise<void> {
  const columns = await sql<{ name: string }>`PRAGMA table_info(account)`.execute(db);
  if (columns.rows.length === 0) return;
  const hasIssuer = columns.rows.some((column) => column.name === "issuer");
  const { rows } = hasIssuer
    ? await sql<AccountKey>`SELECT id, "providerId", "accountId", issuer FROM account`.execute(db)
    : await sql<AccountKey>`SELECT id, "providerId", "accountId", NULL AS issuer FROM account`.execute(db);
  const keys = new Set<string>();
  const updates: { id: string; accountId: string }[] = [];
  for (const row of rows) {
    // Freeze this encoding here: provider-rows.ts must keep producing the
    // same key. Credential IDs are user IDs and must remain unchanged.
    const accountId =
      hasIssuer && row.providerId !== "credential" ? JSON.stringify([row.issuer, row.accountId]) : row.accountId;
    const key = JSON.stringify([row.providerId, accountId]);
    if (keys.has(key)) {
      throw new Error(
        "Duplicate authentication account keys prevent this upgrade. Resolve duplicate providerId/accountId pairs before restarting.",
      );
    }
    keys.add(key);
    if (accountId !== row.accountId) updates.push({ id: row.id, accountId });
  }
  if (!hasIssuer) return;

  // Validate every key before writing. Drop the old unique index before
  // encoding: a raw subject could equal another row's encoded subject.
  await sql`DROP INDEX IF EXISTS account_issuer_accountId_uidx`.execute(db);
  for (const row of updates) {
    await sql`UPDATE account SET "accountId" = ${row.accountId} WHERE id = ${row.id}`.execute(db);
  }
  await sql`ALTER TABLE account DROP COLUMN issuer`.execute(db);
}

/** New accounts have no issuer to restore; a downgrade needs the old snapshot. */
export async function down(): Promise<void> {
  throw new Error("The authentication account migration cannot be reversed; restore a backup to downgrade.");
}
