import { expect } from "bun:test";
import { sql } from "kysely";
import { authRateLimitRoutes } from "@/api/auth-rate-limit.route.js";
import { runAuthMigrations } from "@/db/auth-migrations.js";
import { db } from "@/db/index.js";
import { runMigrations } from "@/db/migrate.js";
import { prepareLocalPlugins } from "@/services/nodes/local-plugins.js";
import { ensureLocalNode } from "@/services/nodes/seed-local.js";

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
 *    test` never calls `runMigrations()`, only `apps/server/api/src/index.ts`
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
 * migration runners `apps/server/api/src/index.ts` calls at server boot.
 *
 * Returns nothing to tear down: the schema is migration-owned, not created
 * per test run, so there is nothing for a suite to drop afterwards. Suites
 * still clean up their own fixture *rows*.
 */
export async function setupAuthTables(): Promise<void> {
  // Same order as `apps/server/api/src/index.ts` at boot. There are no
  // cross-table foreign keys between the app tables and better-auth's, so the
  // order is immaterial today — but a pristine-database bug is exactly what
  // this helper exists to prevent, so the suite exercises production's order
  // rather than a second one nothing else uses.
  await runMigrations();
  await runAuthMigrations();
  // Boot also gives this host its plugins, and since phase 2b that is what
  // decides which harnesses it offers. Leaving it out made a pristine DB mean
  // "a control plane with no plugins", which is a real state but not the one
  // a suite that never mentions plugins is asking for.
  await seedLocalPluginsForTests();
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

/**
 * Gives the control-plane host its built-in plugins, as boot does.
 *
 * Since phase 2b `local` offers what it has INSTALLED, and both the launch
 * gate and the profile listing read that. Production writes it in `index.ts`
 * right after `ensureLocalNode`, so {@link setupAuthTables} calls this too:
 * a suite that skipped it saw every harness unavailable and every profile
 * filtered out, which is correct behaviour for a host with no plugins and
 * almost never the state a test means to be in.
 *
 * Idempotent and cheap after the first call. The data dir is per PROCESS and
 * suites share it, so the seed short-circuits on its completion marker from
 * the second file onwards. Exported as well, for the suites that uninstall
 * something and want the host put back.
 */
export async function seedLocalPluginsForTests(): Promise<void> {
  await ensureLocalNode(db);
  await prepareLocalPlugins();
}
