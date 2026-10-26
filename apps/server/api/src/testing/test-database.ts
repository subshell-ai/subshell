import { runAuthMigrations } from "@/db/auth-migrations.js";
import { runMigrations } from "@/db/migrate.js";

/**
 * Ensures the test database carries both the app's tables and better-auth's,
 * via the same runners the server calls at boot. Both are idempotent (each
 * tracks applied state inside the database itself), so this is a full build
 * on a pristine file and a fast no-op afterwards.
 *
 * Every suite that touches `db` - directly or through a service - must call
 * this in `beforeAll`. Until issue #261 the rule was implicit: serial `bun
 * test` shares one module cache across files, so one early file's migrations
 * served every later file in the process. `--parallel` isolates each file
 * (fresh `db` singleton, fresh database file), and the implicit-boot suites
 * surfaced it as `no such table` - 14 suites, measured 2026-09-29.
 */
export async function ensureMigratedTestDb(): Promise<void> {
  await runMigrations();
  await runAuthMigrations();
}
