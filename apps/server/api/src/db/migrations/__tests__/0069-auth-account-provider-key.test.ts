import { afterEach, describe, expect, it } from "bun:test";
import { betterAuth } from "better-auth";
import { hashPassword } from "better-auth/crypto";
import { getMigrations } from "better-auth/db/migration";
import { Kysely, sql } from "kysely";
import { BunSqliteDialect } from "kysely-bun-sqlite-dialect";
import { up } from "@/db/migrations/0069-auth-account-provider-key.js";
import { openSqliteDatabase } from "@/db/open-database.js";
import { toGenericOAuthConfig } from "@/modules/auth/provider-rows.js";

const handles: Kysely<any>[] = [];
afterEach(async () => {
  for (const db of handles.splice(0)) await db.destroy();
});

async function fixture(legacy: boolean) {
  const sqlite = openSqliteDatabase(":memory:");
  const db = new Kysely<any>({ dialect: new BunSqliteDialect({ database: sqlite }) });
  handles.push(db);
  const options = {
    database: sqlite,
    baseURL: "http://localhost:5173",
    secret: "migration-test-secret-at-least-thirty-two-characters",
    emailAndPassword: { enabled: true },
  };
  await (await getMigrations(options)).runMigrations();
  if (legacy) {
    // Reproduce the 1.7.1 constraint on an otherwise unchanged account schema.
    sqlite.exec("ALTER TABLE account ADD COLUMN issuer TEXT NOT NULL");
    sqlite.exec('CREATE UNIQUE INDEX account_issuer_accountId_uidx ON account (issuer, "accountId")');
  }
  return { db, sqlite, options };
}

describe("Better Auth account-key upgrade", () => {
  it("preserves existing password sign-in and sessions, and allows new accounts", async () => {
    const { db, sqlite, options } = await fixture(true);
    const now = new Date().toISOString();
    sqlite
      .query("INSERT INTO user (id,name,email,emailVerified,createdAt,updatedAt) VALUES (?,?,?,0,?,?)")
      .run("u", "Existing", "existing@example.test", now, now);
    sqlite
      .query(
        "INSERT INTO account (id,issuer,accountId,providerId,userId,password,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?,?)",
      )
      .run("a", "local:credential", "u", "credential", "u", await hashPassword("existing-password"), now, now);
    sqlite
      .query("INSERT INTO session (id,token,userId,expiresAt,createdAt,updatedAt) VALUES (?,?,?,?,?,?)")
      .run("s", "existing-token", "u", new Date(Date.now() + 86400000).toISOString(), now, now);
    await db.transaction().execute(up);
    await up(db);
    expect(sqlite.query("SELECT token FROM session").get()).toEqual({ token: "existing-token" });
    expect(sqlite.query("SELECT id,accountId,providerId,userId FROM account").get()).toEqual({
      id: "a",
      accountId: "u",
      providerId: "credential",
      userId: "u",
    });
    const auth = betterAuth(options);
    const signIn = await auth.api.signInEmail({
      body: { email: "existing@example.test", password: "existing-password" },
    });
    expect(signIn.user.id).toBe("u");
    const signUp = await auth.api.signUpEmail({
      body: { name: "New", email: "new@example.test", password: "new-password" },
    });
    expect(signUp.user.email).toBe("new@example.test");
    expect(sqlite.query("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it("refuses duplicate provider keys without changing either identity", async () => {
    const { db, sqlite } = await fixture(true);
    const now = new Date().toISOString();
    sqlite.exec("DROP INDEX account_issuer_accountId_uidx");
    for (const id of ["one", "two"]) {
      sqlite
        .query("INSERT INTO user (id,name,email,emailVerified,createdAt,updatedAt) VALUES (?,?,?,0,?,?)")
        .run(id, id, `${id}@example.test`, now, now);
      sqlite
        .query("INSERT INTO account (id,issuer,accountId,providerId,userId,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?)")
        .run(id, "https://same.test", "shared", "oidc", id, now, now);
    }
    await expect(db.transaction().execute(up)).rejects.toThrow("Duplicate authentication account keys");
    expect(sqlite.query("SELECT issuer FROM account ORDER BY id").all()).toEqual([
      { issuer: "https://same.test" },
      { issuer: "https://same.test" },
    ]);
  });

  it("preserves OAuth ownership and tokens while separating equal subjects at different issuers", async () => {
    const { db, sqlite, options } = await fixture(true);
    const now = new Date().toISOString();
    for (const id of ["one", "two", "fallback"]) {
      sqlite
        .query("INSERT INTO user (id,name,email,emailVerified,createdAt,updatedAt) VALUES (?,?,?,1,?,?)")
        .run(id, id, `${id}@example.test`, now, now);
      sqlite
        .query(
          "INSERT INTO account (id,issuer,accountId,providerId,userId,accessToken,refreshToken,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?,?,?)",
        )
        .run(
          id,
          id === "fallback" ? "local:oauth:oidc" : `https://${id}.test`,
          "shared",
          "oidc",
          id,
          `access-${id}`,
          `refresh-${id}`,
          now,
          now,
        );
    }
    await db.transaction().execute(up);
    // Use the production resolver to look up each migrated identity through
    // Better Auth, so a mismatch between migration and runtime cannot pass.
    const context = await betterAuth(options).$context;
    for (const id of ["one", "two", "fallback"]) {
      const config = toGenericOAuthConfig(
        {
          id: "oidc",
          kind: "oidc",
          name: "Fixture",
          issuer: id === "fallback" ? null : `https://${id}.test`,
          clientId: "fixture",
          clientSecret: null,
          endpoints: null,
          entryOrigins: [],
          allowedDomains: [],
          signInEnabled: true,
          registrationEnabled: true,
          requireApproval: false,
        },
        options.baseURL,
      );
      const accountId = await config.accountSubject?.({ profile: { id: "shared", emailVerified: true }, tokens: {} });
      const owner = await context.internalAdapter.findAccountOwnerByKey({
        providerId: "oidc",
        accountId: String(accountId),
      });
      expect(owner?.kind).toBe("owned");
      if (owner?.kind !== "owned") throw new Error("migrated account is not owned");
      expect(owner.user.id).toBe(id);
      expect(owner.account).toMatchObject({
        id,
        userId: id,
        accessToken: `access-${id}`,
        refreshToken: `refresh-${id}`,
      });
    }
  });

  it("checks duplicate keys even when the legacy issuer column is absent", async () => {
    const { db, sqlite } = await fixture(false);
    const now = new Date().toISOString();
    sqlite
      .query(
        "INSERT INTO user (id,name,email,emailVerified,createdAt,updatedAt) VALUES ('u','User','u@example.test',0,?,?)",
      )
      .run(now, now);
    for (const id of ["one", "two"]) {
      sqlite
        .query(
          "INSERT INTO account (id,accountId,providerId,userId,createdAt,updatedAt) VALUES (?,'shared','oidc','u',?,?)",
        )
        .run(id, now, now);
    }
    await expect(up(db)).rejects.toThrow("Duplicate authentication account keys");
  });

  it("accepts fresh and already-upgraded databases", async () => {
    const { db } = await fixture(false);
    await up(db);
    await sql`DROP TABLE account`.execute(db);
    await up(db);
  });
});
