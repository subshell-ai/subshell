import { Database as Sqlite } from "bun:sqlite";
import { hashPassword, verifyPassword } from "better-auth/crypto";
import { type Kysely, sql } from "kysely";
import type { Database } from "@/db/types/index.js";
import { inspectSqliteSchema } from "@/services/backups/metadata.js";

/** Offline only: this path must name the validated, staged database. */
export async function prepareBackupAdminRecovery(
  databasePath: string,
  userId: string,
  password: string,
): Promise<void> {
  if (password.length < 8 || password.length > 4096) throw new Error("Temporary password must be 8–4096 characters.");
  const hash = await hashPassword(password);
  const db = new Sqlite(databasePath);
  try {
    inspectSqliteSchema(db);
    const target = db
      .query<{ id: string }, [string]>(
        "SELECT u.id FROM user u JOIN user_meta m ON m.user_id=u.id WHERE u.id=? AND m.role='admin' AND u.email != 'system@subshell.local'",
      )
      .get(userId);
    if (!target) throw new Error("Select an existing human administrator from the backup.");
    db.transaction(() => {
      const now = new Date().toISOString();
      const account = db
        .query<{ id: string }, [string]>("SELECT id FROM account WHERE userId=? AND providerId='credential'")
        .get(userId);
      if (account) db.query("UPDATE account SET password=?, updatedAt=? WHERE id=?").run(hash, now, account.id);
      else {
        const columns = new Set(
          db
            .query<{ name: string }, []>("PRAGMA table_info(account)")
            .all()
            .map((column) => column.name),
        );
        if (columns.has("issuer"))
          db.query(
            "INSERT INTO account (id,issuer,accountId,providerId,userId,password,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?,?)",
          ).run(crypto.randomUUID(), "local:credential", userId, "credential", userId, hash, now, now);
        else
          db.query(
            "INSERT INTO account (id,accountId,providerId,userId,password,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?)",
          ).run(crypto.randomUUID(), userId, "credential", userId, hash, now, now);
      }
      db.query("DELETE FROM session WHERE userId=?").run(userId);
      const metaColumns = new Set(
        db
          .query<{ name: string }, []>("PRAGMA table_info(user_meta)")
          .all()
          .map((column) => column.name),
      );
      if (metaColumns.has("disabled")) db.query("UPDATE user_meta SET disabled=0 WHERE user_id=?").run(userId);
      if (metaColumns.has("approval_state"))
        db.query("UPDATE user_meta SET approval_state='approved' WHERE user_id=?").run(userId);
      db.exec(
        "CREATE TABLE IF NOT EXISTS backup_recovery (user_id TEXT PRIMARY KEY REFERENCES user(id) ON DELETE CASCADE)",
      );
      db.query("INSERT OR IGNORE INTO backup_recovery (user_id) VALUES (?)").run(userId);
      // Old snapshots acquire the email provider through their normal migration.
      if (db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='auth_providers'").get()) {
        db.exec("UPDATE auth_providers SET enabled=1, sign_in_enabled=1 WHERE id='email'");
      }
    })();
  } finally {
    db.close();
  }
}

export async function backupPasswordChangeRequired(db: Kysely<Database>, userId: string): Promise<boolean> {
  // The absent-table check supports focused tests and snapshots awaiting migration.
  const table = await sql<{
    name: string;
  }>`SELECT name FROM sqlite_master WHERE type='table' AND name='backup_recovery'`.execute(db);
  if (!table.rows.length) return false;
  const row = await sql`SELECT user_id FROM backup_recovery WHERE user_id=${userId}`.execute(db);
  return row.rows.length > 0;
}

/** Atomically changes the credential, releases the recovery gate, and revokes sessions. */
export async function completeBackupPasswordRecovery(
  db: Kysely<Database>,
  userId: string,
  currentPassword: string,
  newPassword: string,
): Promise<void> {
  if (newPassword.length < 8 || newPassword.length > 4096)
    throw new Error("New password must be at least 8 characters.");
  if (newPassword === currentPassword) throw new Error("Choose a password different from the temporary password.");
  const credential = await sql<{
    password: string;
  }>`SELECT password FROM account WHERE userId=${userId} AND providerId='credential'`.execute(db);
  const oldHash = credential.rows[0]?.password;
  if (!oldHash || !(await verifyPassword({ hash: oldHash, password: currentPassword })))
    throw new Error("The current password is incorrect.");
  const newHash = await hashPassword(newPassword);
  await db.transaction().execute(async (trx) => {
    // Compare the hash so a concurrent credential reset cannot be overwritten.
    const changed =
      await sql`UPDATE account SET password=${newHash}, updatedAt=${new Date().toISOString()} WHERE userId=${userId} AND providerId='credential' AND password=${oldHash}`.execute(
        trx,
      );
    if (Number(changed.numAffectedRows ?? 0) !== 1) throw new Error("The credential changed; sign in again.");
    await sql`DELETE FROM backup_recovery WHERE user_id=${userId}`.execute(trx);
    await sql`DELETE FROM session WHERE userId=${userId}`.execute(trx);
  });
}
