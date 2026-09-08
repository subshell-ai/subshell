/**
 * Dev/diagnostic helper: resets the first user's credential password.
 * Usage: bun run scripts/set-admin-password.ts <email> <new-password>
 */
import { hashPassword } from "better-auth/crypto";
import { openSqliteDatabase } from "@/db/open-database.js";

const [, , emailArg, passwordArg] = process.argv;
const email = emailArg ?? "admin@subshell.local";
const password = passwordArg ?? "admin123";

const db = openSqliteDatabase("./data/subshell.db");
const user = db.prepare("SELECT id FROM user WHERE email = ?").get(email) as { id: string } | undefined;
if (!user) {
  console.error(`No user found with email ${email}`);
  process.exit(1);
}

const hash = await hashPassword(password);
db.prepare("UPDATE account SET password = ? WHERE userId = ? AND providerId = ?").run(hash, user.id, "credential");
console.log(`Updated password for ${email}`);
