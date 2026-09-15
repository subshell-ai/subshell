import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { CamelCasePlugin, Kysely, sql } from "kysely";
import { BunSqliteDialect } from "kysely-bun-sqlite-dialect";
import { seedLocalPluginsForTests } from "@/api/__tests__/helpers/auth-tables.js";
import { AUTH_OPTIONS, getAuth, promoteFirstUserAtomically, setAuthPolicyDb } from "@/auth.js";
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
  const e = `reg-${crypto.randomUUID()}@subshell.local`;
  createdEmails.push(e);
  return e;
}

async function signUpEmail(email: string, name = email): Promise<{ user: { id: string } }> {
  const res = (await getAuth().api.signUpEmail({
    body: { name, email, password: "registration-pass-1" },
  })) as unknown as { user: { id: string } };
  if (res?.user?.id) createdUserIds.push(res.user.id);
  return res;
}

/** The `user.name` actually written, read past the CamelCasePlugin. */
async function storedName(email: string): Promise<string | undefined> {
  const { rows } = await sql<{ name: string }>`SELECT name FROM user WHERE email = ${email}`.execute(db);
  return rows[0]?.name;
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
  // The instance plugin store, prepared like boot's. The tests here assert
  // sign-up posture, but the per-process suites share this data dir and many
  // of them read harness usability off the seeded built-ins.
  await seedLocalPluginsForTests();
});

afterAll(async () => {
  await db.deleteFrom("settings").where("key", "=", "allow_registrations").execute();
  for (const id of createdUserIds) {
    await db.deleteFrom("userMeta").where("userId", "=", id).execute();
    // A user's preset rows must not outlive the user in the shared
    // per-process DB.
    await db.deleteFrom("presets").where("userId", "=", id).execute();
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
    // **Registration is opened EXPLICITLY for the second one.** With no row,
    // an instance that already has a user is now closed — that is the whole
    // point of the new default, and it refuses this sign-up outright. This
    // test is about PROMOTION, not about the gate, so it states the condition
    // it needs rather than relying on a default that no longer holds.
    await setRegistrationSetting("true");
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

  it("with NO row, an instance that already has a user refuses sign-up", async () => {
    // The default flipped (2026-09-13). Before, an absent row meant open
    // unconditionally, so every instance shipped accepting sign-ups from
    // anyone who could reach it until an admin noticed. By this point in the
    // suite users exist, which is the condition that now closes it.
    await db.deleteFrom("settings").where("key", "=", "allow_registrations").execute();
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

/**
 * The display name a person types at FIRST RUN never passes through
 * `POST /api/users` — the setup wizard calls better-auth's own
 * `signUp.email` — so the route's normalizer does not cover it. The
 * `user.create.before` hook does, because it is the one seam every sign-up
 * shares.
 */
describe("display names are normalized on the sign-up path", () => {
  it("strips control characters and collapses whitespace before the row is written", async () => {
    await setRegistrationSetting("true");
    const email = newEmail();
    await signUpEmail(email, "  Ada\r\n Love\u0007lace  ");
    expect(await storedName(email)).toBe("Ada Love lace");
  });

  it("caps an over-long name instead of refusing the very first account", async () => {
    // The asymmetry with the admin route is deliberate: there an admin is
    // typing into a form and can be told to shorten it, here a refusal would
    // land as a failed first run with no account and no way to make one.
    await setRegistrationSetting("true");
    const email = newEmail();
    await signUpEmail(email, "Z".repeat(200));
    expect(await storedName(email)).toBe("Z".repeat(64));
  });

  it("stores an unprintable name as empty, which renders as the email", async () => {
    // `displayNamesByIds` prefers a real name and falls back to the address
    // (`COALESCE(NULLIF(name, ''), email)`), so "" is the one value that means
    // "this person has no chosen name" — the right answer here, and better
    // than storing the control characters that were typed.
    await setRegistrationSetting("true");
    const email = newEmail();
    await signUpEmail(email, "\r\n\t");
    expect(await storedName(email)).toBe("");
  });
});
