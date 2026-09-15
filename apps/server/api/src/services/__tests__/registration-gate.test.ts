import { describe, expect, it } from "bun:test";
import { CamelCasePlugin, Kysely, sql } from "kysely";
import { BunSqliteDialect } from "kysely-bun-sqlite-dialect";
import { SYSTEM_USER_EMAIL } from "@/auth/system-user.js";
import { openSqliteDatabase } from "@/db/open-database.js";
import type { Database } from "@/db/types/index.js";
import { hasAnyUser, registrationDecision } from "@/services/registration-gate.js";

/**
 * The registration rule, including the one case that makes a closed default
 * possible at all.
 *
 * Driven through the PURE decision rather than the database: the suite shares
 * one DB across files, so asserting "no users exist" against the real count
 * passes alone and fails beside any test that registers someone — which is
 * exactly how this test first failed.
 */
describe("registrationDecision", () => {
  it("is OPEN with no row and no users — the first admin has to be creatable", () => {
    // Closed here would brick a fresh install: the FIRST account registered
    // becomes the admin, so a closed empty instance could never mint the one
    // person able to open it, and the boot wizard would point at a sign-up
    // form that refuses.
    expect(registrationDecision(undefined, false)).toBe(true);
  });

  it("is CLOSED with no row once a user exists — the door shuts behind itself", () => {
    // The change: an instance no longer ships accepting sign-ups from anyone
    // who can reach it until an admin happens to notice.
    expect(registrationDecision(undefined, true)).toBe(false);
  });

  it("honours an explicit answer either way, users or not", () => {
    expect(registrationDecision("true", true)).toBe(true);
    expect(registrationDecision("true", false)).toBe(true);
    expect(registrationDecision("false", false)).toBe(false);
    // Explicit false wins even in the first-run window: an operator who said
    // no before anyone registered meant it.
    expect(registrationDecision("false", true)).toBe(false);
  });

  it("FAILS CLOSED on a corrupt or non-boolean row, even with no users", () => {
    // Treating corruption as open turns a damaged settings row into silently
    // re-opened registration (security audit 2026-08, F6a) — and the no-users
    // carve-out must not become a way back in for it.
    for (const bad of ["not json", '"true"', "1", "null", "{}", ""]) {
      expect(registrationDecision(bad, false)).toBe(false);
      expect(registrationDecision(bad, true)).toBe(false);
    }
  });
});

/**
 * The counter the rule above is fed, which is a different question from the
 * rule itself: WHICH rows mean "somebody has registered".
 *
 * Driven against a private `:memory:` scratch database — the same idiom
 * `auth-registration.test.ts` uses for the promotion statement — because the
 * one case that matters most is the EMPTY instance, and the per-process test
 * database is shared by every file in the run and can never be observed
 * empty.
 */
describe("hasAnyUser", () => {
  /** A scratch database holding just the two tables this counter can see. */
  async function scratchDb(): Promise<Kysely<Database>> {
    const scratch = new Kysely<{
      user: { id: string; email: string; name: string };
      userMeta: { userId: string; role: string };
    }>({
      dialect: new BunSqliteDialect({ database: openSqliteDatabase(":memory:") }),
      plugins: [new CamelCasePlugin()],
    }) as unknown as Kysely<Database>;
    // better-auth's physical spelling, which is what the repository queries.
    await sql`CREATE TABLE user (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, name TEXT NOT NULL)`.execute(scratch);
    await sql`CREATE TABLE user_meta (user_id TEXT PRIMARY KEY, role TEXT NOT NULL DEFAULT 'user')`.execute(scratch);
    return scratch;
  }

  /** Insert a `user` row the way better-auth would, with no meta row. */
  async function addUser(scratch: Kysely<Database>, email: string): Promise<string> {
    const id = crypto.randomUUID();
    await sql`INSERT INTO user (id, email, name) VALUES (${id}, ${email}, ${email})`.execute(scratch);
    return id;
  }

  it("is false on an empty instance — the first admin has to be creatable", async () => {
    expect(await hasAnyUser(await scratchDb())).toBe(false);
  });

  it("counts a user whose user_meta row is MISSING", async () => {
    // The regression this closes. `user_meta` is a role side-table written by
    // a SEPARATE better-auth `after` hook, so a user row can exist without
    // one — and counting the side-table read that instance as "nobody has
    // registered", which silently reopens registration AND makes the
    // first-run `/api/setup/*` window public again on an instance with real
    // accounts.
    const scratch = await scratchDb();
    await addUser(scratch, "nometa@subshell.local");
    expect(await hasAnyUser(scratch)).toBe(true);
  });

  it("does NOT count the system service account", async () => {
    // `ensureSystemUser` INSERTs straight into `user` and mints no meta row,
    // so this divergence is not hypothetical — it is the shape of every
    // instance that has ever had a system API key. The account carries no
    // credential row and can never sign in, so it is not somebody having
    // registered: counting it would brick a fresh install by closing the
    // door before anyone walked through it.
    const scratch = await scratchDb();
    await addUser(scratch, SYSTEM_USER_EMAIL);
    expect(await hasAnyUser(scratch)).toBe(false);

    await addUser(scratch, "real@subshell.local");
    expect(await hasAnyUser(scratch)).toBe(true);
  });
});
