import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { CamelCasePlugin, Kysely, sql } from "kysely";
import { BunSqliteDialect } from "kysely-bun-sqlite-dialect";
import { AUTH_OPTIONS, auth, promoteFirstUserAtomically, setAuthPolicyDb } from "@/auth.js";
import { runAuthMigrations } from "@/db/auth-migrations.js";
import { db } from "@/db/index.js";
import { runMigrations } from "@/db/migrate.js";
import { openSqliteDatabase } from "@/db/open-database.js";
import type { Database } from "@/db/types/index.js";

/**
 * Security-audit 2026-08 fixes in `src/auth.ts`:
 *
 * - F5: the better-auth `cookieCache` must be bounded (5 min, not 7 days) so
 *   a copied/stale cookie jar stops passing better-auth's own requireSession
 *   endpoints long after sign-out.
 * - F6a: the registration gate must FAIL CLOSED on an unparseable
 *   `allow_registrations` value (missing row still means open — the pre-setup
 *   default).
 * - F6b: first-admin promotion must be ONE atomic statement, so two
 *   concurrent first sign-ups cannot both count zero and both mint admin,
 *   and the old onConflict role-overwrite can never flip the loser over the
 *   winner.
 *
 * NOTE on isolation: the test DB is a per-process temp FILE shared by every
 * test file in the run (it no longer persists across runs or leaks into
 * other processes, but sibling suites in this process do write users) — so
 * nothing here may assume `user_meta` is globally empty, and the concurrency
 * proof runs against a genuinely private `:memory:` scratch database calling
 * the same exported statement the `after` hook runs. The real sign-up path
 * (hooks included) is still exercised here: the gate tests below drive
 * `auth.api.signUpEmail`.
 */

const createdEmails: string[] = [];
const createdUserIds: string[] = [];

function newEmail(): string {
  const e = `reg-${crypto.randomUUID()}@mote.local`;
  createdEmails.push(e);
  return e;
}

async function signUpEmail(email: string): Promise<{ user: { id: string } }> {
  const res = (await auth.api.signUpEmail({
    body: { name: email, email, password: "registration-pass-1" },
  })) as unknown as { user: { id: string } };
  if (res?.user?.id) createdUserIds.push(res.user.id);
  return res;
}

async function roleFor(userId: string): Promise<string | null> {
  const row = await db.selectFrom("userMeta").select("role").where("userId", "=", userId).executeTakeFirst();
  return row?.role ?? null;
}

async function userExists(email: string): Promise<boolean> {
  // Raw SQL: better-auth's `user` table has literal camelCase columns that
  // the app Kysely instance's CamelCasePlugin would rewrite through a builder.
  const row = await sql`SELECT id FROM user WHERE email = ${email}`.execute(db);
  return row.rows.length > 0;
}

async function setRegistrationSetting(value: string): Promise<void> {
  await db
    .insertInto("settings")
    .values({ key: "allow_registrations", value, updatedAt: new Date().toISOString() })
    .onConflict((oc) => oc.column("key").doUpdateSet({ value }))
    .execute();
}

/** A private in-memory DB with the real `user_meta` DDL from migration 0001. */
function scratchDb(): Kysely<Database> {
  const scratch = new Kysely<{ userMeta: { userId: string; role: string } }>({
    dialect: new BunSqliteDialect({ database: openSqliteDatabase(":memory:") }),
    plugins: [new CamelCasePlugin()],
  });
  return scratch as unknown as Kysely<Database>;
}

beforeAll(async () => {
  await runMigrations();
  await runAuthMigrations();
  setAuthPolicyDb(db);
});

afterAll(async () => {
  await db.deleteFrom("settings").where("key", "=", "allow_registrations").execute();
  for (const id of createdUserIds) {
    await db.deleteFrom("userMeta").where("userId", "=", id).execute();
    // Real sign-ups run the seeding hook, so these users own Default
    // profiles — remove them too, or the shared per-process DB keeps
    // unremovable rows for users that no longer exist.
    await db.deleteFrom("profiles").where("userId", "=", id).execute();
  }
  for (const email of createdEmails) {
    await sql`DELETE FROM user WHERE email = ${email}`.execute(db);
  }
});

describe("cookieCache bound (F5)", () => {
  it("is enabled with a 5-minute maxAge, not 7 days", () => {
    expect(AUTH_OPTIONS.session.cookieCache).toEqual({ enabled: true, maxAge: 300 });
  });
});

describe("first-admin promotion is atomic (F6b)", () => {
  it("two concurrent promotions of an EMPTY user_meta mint exactly one admin", async () => {
    const scratch = scratchDb();
    await sql`CREATE TABLE user_meta (user_id TEXT PRIMARY KEY, role TEXT NOT NULL DEFAULT 'user')`.execute(scratch);

    const u1 = crypto.randomUUID();
    const u2 = crypto.randomUUID();
    await Promise.all([promoteFirstUserAtomically(scratch, u1), promoteFirstUserAtomically(scratch, u2)]);

    const rows = await scratch.selectFrom("userMeta").selectAll().execute();
    expect(rows).toHaveLength(2);
    // The regression: the old count-then-insert let BOTH concurrent callers
    // read zero and write 'admin'. Documented loser semantics: it lands on
    // role 'user' and is never overwritten afterwards.
    expect(rows.filter((r) => r.role === "admin")).toHaveLength(1);
  });

  it("re-running the promotion never flips an existing admin (no role-overwrite)", async () => {
    const scratch = scratchDb();
    await sql`CREATE TABLE user_meta (user_id TEXT PRIMARY KEY, role TEXT NOT NULL DEFAULT 'user')`.execute(scratch);

    const first = crypto.randomUUID();
    await promoteFirstUserAtomically(scratch, first);
    expect(
      await scratch.selectFrom("userMeta").select("role").where("userId", "=", first).executeTakeFirstOrThrow(),
    ).toEqual({ role: "admin" });

    // A second signup gets 'user'... and re-promoting the ADMIN must not
    // overwrite it (the old onConflict doUpdateSet({role}) could).
    const second = crypto.randomUUID();
    await promoteFirstUserAtomically(scratch, second);
    await promoteFirstUserAtomically(scratch, first);

    const roles = await scratch.selectFrom("userMeta").select(["userId", "role"]).execute();
    expect(roles.find((r) => r.userId === first)?.role).toBe("admin");
    expect(roles.find((r) => r.userId === second)?.role).toBe("user");
  });

  it("the real sign-up hook still promotes nobody once users exist", async () => {
    // Seed the precondition in-suite: the per-process temp DB starts empty,
    // so a bare sign-up here would BE the first user and correctly land on
    // admin. Sign one up first (that one is promoted by the same hook), then
    // the second end-to-end sign-up must be 'user' — the `ELSE 'user'` half
    // of the statement.
    await signUpEmail(newEmail());
    const r = await signUpEmail(newEmail());
    expect(await roleFor(r.user.id)).toBe("user");
  });
});

describe("registration gate fails closed (F6a)", () => {
  it("unparseable allow_registrations blocks registration", async () => {
    await setRegistrationSetting("this-is-not-json{");
    const e = newEmail();
    await expect(signUpEmail(e)).rejects.toThrow();
    expect(await userExists(e)).toBe(false);
  });

  it('explicit "false" blocks registration', async () => {
    await setRegistrationSetting("false");
    const e = newEmail();
    await expect(signUpEmail(e)).rejects.toThrow();
    expect(await userExists(e)).toBe(false);
  });

  it('explicit "true" allows registration again', async () => {
    await setRegistrationSetting("true");
    const r = await signUpEmail(newEmail());
    expect(r.user.id).toBeTruthy();
  });
});

describe("default-profile seeding hook (auto-defaulted profiles)", () => {
  // The registration seam's only end-to-end proof: this file is the one suite
  // that drives the REAL signUpEmail path with setAuthPolicyDb applied, so the
  // better-auth after-hook (promotion + seeding) actually runs here. Calling
  // the service directly (default-profiles.test.ts) cannot catch the hook
  // itself being dropped.
  it("a real sign-up lands a blank, unremovable Default per enabled harness", async () => {
    const r = await signUpEmail(newEmail());
    const rows = await db.selectFrom("profiles").selectAll().where("userId", "=", r.user.id).execute();
    expect(rows.length).toBeGreaterThan(0);
    for (const p of rows) {
      expect(p.name).toBe("Default");
      expect(p.isDefault).toBe(1); // the unremovable flag rides along
      expect(p.envJson).toBeNull();
      expect(p.flagsJson).toBeNull();
      expect(p.settingsJson).toBeNull();
    }
    // No harness may collect more than one seeded row per pair.
    const perHarness = new Set(rows.map((p) => p.harnessId));
    expect(perHarness.size).toBe(rows.length);
  });
});
