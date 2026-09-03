import { expect } from "bun:test";
import { sql } from "kysely";
import { authRateLimitRoutes } from "@/api/auth-rate-limit.route.js";
import { runAuthMigrations } from "@/db/auth-migrations.js";
import { db } from "@/db/index.js";
import { runMigrations } from "@/db/migrate.js";

/**
 * Shared test scaffolding for route tests that need better-auth's tables
 * (user/session/account/verification) plus the app's own tables. Extracted
 * so route test files don't have to re-declare the auth schema themselves.
 * Every route test suite uses it: `uploads-route.test.ts`,
 * `rate-limit-route.test.ts`, `users-admin.test.ts` and
 * `files-route.test.ts`. There are no hand-rolled copies left.
 *
 * `setupAuthTables` used to hand-roll `CREATE TABLE` statements for all of
 * this instead of running the real migrations, for two reasons that both
 * turned out to be wrong:
 *
 * 1. It drifts. `subshells` alone gained 8 columns across migrations 0002
 *    and 0003 that a hand-rolled snapshot of 0001 never had, so
 *    `SubshellsRepository.create()` broke against it with `no such column:
 *    alive` — invisible in this repo's dev/CI environment because
 *    `subshells` is already migrated there, but real on a pristine database
 *    (fresh clone, fresh CI runner, a new contributor's machine — `bun
 *    test` never calls `runMigrations()`, only `apps/server/src/index.ts`
 *    does at server boot, and `data/subshell.db` is gitignored).
 * 2. For better-auth's own tables it was actively wrong, not just stale:
 *    hand-rolling them through this file's `db` (which has Kysely's
 *    `CamelCasePlugin` installed) silently renamed columns like
 *    `emailVerified` to `email_verified` in the DDL. Better-auth's own
 *    runtime queries (and this file's own `deleteUserByEmailOrId`) address
 *    the literal camelCase names, so a hand-rolled `user` table fails on
 *    the very first insert with `table user has no column named
 *    emailVerified` — confirmed by constructing a genuinely pristine
 *    database and running the uploads-route suite against it.
 *
 * Both bugs have the same fix: call the same migration runners the real
 * server calls at boot. Both are idempotent (Kysely's `Migrator` and
 * better-auth's own migration runner each track what they've already
 * applied), so calling them unconditionally is a fast no-op against an
 * already-migrated database and the only way to get a correct schema
 * against a pristine one — and unlike a hand-rolled snapshot, it cannot
 * drift the next time either schema changes.
 */

/**
 * Ensures better-auth's tables and the app's own tables exist, via the same
 * migration runners `apps/server/src/index.ts` calls at server boot.
 *
 * Returns nothing to tear down: the schema is migration-owned, not created
 * per test run, so there is nothing for a suite to drop afterwards. Suites
 * still clean up their own fixture *rows*.
 */
export async function setupAuthTables(): Promise<void> {
  // Same order as `apps/server/src/index.ts` at boot. There are no
  // cross-table foreign keys between the app tables and better-auth's, so the
  // order is immaterial today — but a pristine-database bug is exactly what
  // this helper exists to prevent, so the suite exercises production's order
  // rather than a second one nothing else uses.
  await runMigrations();
  await runAuthMigrations();
}

/** Signs in through the real rate-limited wrapper; returns the session token. */
export async function signIn(email: string, password: string): Promise<string> {
  const res = await authRateLimitRoutes.fetch(
    new Request("http://localhost:3080/api/auth/sign-in/email", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost:5173" },
      body: JSON.stringify({ email, password }),
    }),
  );
  expect(res.status).toBe(200);
  const setCookie = res.headers.get("set-cookie") ?? "";
  const match = setCookie.match(/better-auth\.session_token=([^;]+)/);
  expect(match, `expected session cookie, got: ${setCookie}`).toBeTruthy();
  return match?.[1] ?? "";
}

/** Builds an app-API request authenticated with a session token. */
export function authedRequest(path: string, token: string, init?: RequestInit): Request {
  const headers = new Headers(init?.headers);
  headers.set("cookie", `better-auth.session_token=${token}`);
  if (init?.body && !headers.has("content-type") && typeof init.body === "string") {
    headers.set("content-type", "application/json");
  }
  return new Request(`http://localhost:3080${path}`, { ...init, headers });
}

/**
 * Deletes better-auth owned rows via raw SQL (the `user` table is outside the
 * typed `Database` interface). Deleting the user cascades account/session.
 */
export function deleteUserByEmailOrId(emailOrId: string): Promise<unknown> {
  return sql`DELETE FROM user WHERE id = ${emailOrId} OR email = ${emailOrId}`.execute(db);
}
