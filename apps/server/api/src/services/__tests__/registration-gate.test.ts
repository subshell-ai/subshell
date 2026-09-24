import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { CamelCasePlugin, Kysely, sql } from "kysely";
import { BunSqliteDialect } from "kysely-bun-sqlite-dialect";
import { SYSTEM_USER_EMAIL } from "@/auth/system-user.js";
import { runAuthMigrations } from "@/db/auth-migrations.js";
import { db } from "@/db/index.js";
import { runMigrations } from "@/db/migrate.js";
import { openSqliteDatabase } from "@/db/open-database.js";
import { AuthProvidersRepository } from "@/db/repositories/auth-providers.repository.js";
import type { Database } from "@/db/types/index.js";
import { emailRegistrationDecision, hasAnyUser, registrationOpen } from "@/services/registration-gate.js";

/**
 * The registration rule for the E-MAIL sign-in door (spec 2026-09-24 §2):
 * the `auth_providers` row with id `email` answers through its
 * `registration_enabled`, and NULL on that row means the legacy dynamic
 * window — open exactly while no real account exists, closed behind the
 * first one.
 *
 * Driven through the PURE decision rather than the database: the suite shares
 * one DB across files, so asserting "no users exist" against the real count
 * passes alone and fails beside any test that registers someone — which is
 * exactly how this test first failed.
 */
describe("emailRegistrationDecision", () => {
  it("NULL stored value = the legacy dynamic window", () => {
    // Closed here would brick a fresh install: the FIRST account registered
    // becomes the admin, so a closed empty instance could never mint the one
    // person able to open it, and the boot wizard would point at a sign-up
    // form that refuses.
    expect(emailRegistrationDecision(null, false)).toBe(true);
    // The door shuts behind the first one: an instance no longer ships
    // accepting sign-ups from anyone who can reach it until an admin notices.
    expect(emailRegistrationDecision(null, true)).toBe(false);
  });

  it("explicit booleans are honored, users or not", () => {
    expect(emailRegistrationDecision(1, true)).toBe(true);
    expect(emailRegistrationDecision(1, false)).toBe(true);
    expect(emailRegistrationDecision(0, false)).toBe(false);
    // Explicit off wins even in the first-run window: an operator who said
    // no before anyone registered meant it.
    expect(emailRegistrationDecision(0, true)).toBe(false);
  });

  it("hasUsers is ignored once the row answers", () => {
    expect(emailRegistrationDecision(1, true)).toBe(true);
  });

  it("FAILS CLOSED on anything that is not 1, even with no users", () => {
    // The ported F6a pin, in the column's own grammar: the legacy rule read
    // anything unparseable-or-not-`true` as closed, and the integer column
    // keeps the same shape — only exactly 1 opens. A damaged or hand-edited
    // row must not become a way back in through the no-users window.
    for (const bad of [0, 2, -1, "true", "1", {}]) {
      expect(emailRegistrationDecision(bad as unknown as number | null, false)).toBe(false);
      expect(emailRegistrationDecision(bad as unknown as number | null, true)).toBe(false);
    }
  });
});

/**
 * The gate wired to the EMAIL PROVIDER ROW against the real (shared)
 * database. A real account is seeded here so the legacy-window case answers
 * "there are users" no matter which order the suites run in; the provider
 * row is read before every write and restored after, because the shared DB
 * persists across files and the other suites depend on the row sitting at
 * its seeded NULL (closed-by-default-with-users).
 */
describe("registrationOpen (email provider row)", () => {
  const gate = new AuthProvidersRepository(db);
  const seedEmail = `gate-${crypto.randomUUID()}@subshell.local`;
  /** The row's stored value as this file found it — restored after every case. */
  let storedBefore: number | null | undefined;

  async function storedValue(): Promise<number | null | undefined> {
    return (await gate.getById("email"))?.registrationEnabled ?? null;
  }

  async function restore(): Promise<void> {
    await gate.update("email", { registrationEnabled: storedBefore ?? null });
  }

  beforeAll(async () => {
    await runMigrations();
    // The seed below writes better-auth's `user` table, which the app
    // migrations do not create; both migrators are idempotent, so a
    // standalone run of this file gets the same DB the full suite shares.
    await runAuthMigrations();
    // Raw SQL: better-auth's `user` table is outside the typed Database, and
    // this only needs the row the counter sees (security-actionable 2026-09
    // item 9 counts ACCOUNTS, not `user_meta` rows).
    await sql`
      INSERT INTO user (id, name, email, "emailVerified", "createdAt", "updatedAt")
      VALUES (${crypto.randomUUID()}, ${seedEmail}, ${seedEmail}, 0, datetime('now'), datetime('now'))
    `.execute(db);
    storedBefore = await storedValue();
  });

  afterAll(async () => {
    await restore();
    await sql`DELETE FROM user WHERE email = ${seedEmail}`.execute(db);
  });

  it("is CLOSED with the row at NULL while the shared test DB has users", async () => {
    await gate.update("email", { registrationEnabled: null });
    try {
      expect(await registrationOpen(db)).toBe(false);
    } finally {
      await restore();
    }
  });

  it("flips to OPEN when the email row stores 1, back to CLOSED on 0", async () => {
    await gate.update("email", { registrationEnabled: 1 });
    try {
      expect(await registrationOpen(db)).toBe(true);
    } finally {
      await restore();
    }
    await gate.update("email", { registrationEnabled: 0 });
    try {
      expect(await registrationOpen(db)).toBe(false);
    } finally {
      await restore();
    }
  });

  it("a corrupt stored value reads CLOSED through the real read path", async () => {
    // The column has INTEGER affinity, not a CHECK — a hand edit can store
    // text, and the gate must refuse it (the old settings row failed closed
    // on unparseable JSON for the same reason).
    await sql`UPDATE auth_providers SET registration_enabled = 'this-is-not-json{' WHERE id = 'email'`.execute(db);
    try {
      expect(await registrationOpen(db)).toBe(false);
    } finally {
      await restore();
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
