import { beforeAll, describe, expect, it } from "bun:test";
import { hashPassword } from "better-auth/crypto";
import { sql } from "kysely";
import { setupAuthTables, signIn } from "@/api/__tests__/helpers/auth-tables.js";
import { getAuth } from "@/auth.js";
import { db } from "@/db/index.js";
import { UsersRepository } from "@/db/repositories/users.repository.js";

/**
 * Server-side passkey plugin (spec 2026-08-31 §4): the migration chain must
 * create the plugin table, and the better-auth handler must expose the
 * registration-options endpoint. The WebAuthn ceremony itself is browser
 * territory — verified manually (Task 8); this pins the server half.
 */
describe("passkey plugin (server)", () => {
  const password = "passkey-test-pass-1";
  let email = "";
  let token = "";

  beforeAll(async () => {
    await setupAuthTables();
    email = `passkey-${crypto.randomUUID()}@subshell.local`;
    await new UsersRepository(db).createUser({
      email,
      name: email,
      passwordHash: await hashPassword(password),
      role: "user",
    });
    token = await signIn(email, password);
  });

  it("runAuthMigrations creates the passkey table", async () => {
    const { rows } = await sql`
      SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'passkey'
    `.execute(db);
    expect(rows).toHaveLength(1);
  });

  it("generate-register-options refuses an anonymous request", async () => {
    const res = await getAuth().handler(
      new Request("http://localhost:3080/api/auth/passkey/generate-register-options", {
        headers: { origin: "http://localhost:5173" },
      }),
    );
    expect([401, 403]).toContain(res.status);
  });

  it("generate-register-options returns WebAuthn options for a subshell", async () => {
    const res = await getAuth().handler(
      new Request("http://localhost:3080/api/auth/passkey/generate-register-options", {
        headers: { origin: "http://localhost:5173", cookie: `better-auth.session_token=${token}` },
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { challenge?: string; rp?: { name?: string; id?: string } };
    expect(typeof body.challenge).toBe("string");
    expect(body.rp?.name).toBe("subshell");
    // rpID regression pin (code-review 2026-08-31): better-auth 1.7.1 derives
    // it from the CONFIGURED baseURL (new URL(baseURL).hostname), never the
    // request host — under tests APP_BASE_URL is forced to localhost:3080, so
    // "localhost" must appear regardless of the Origin header sent above.
    // Passkeys therefore bind to the instance's canonical address, NOT per
    // browsing origin; if this ever returns the request host, the UI copy in
    // login.tsx/passkeys-card.tsx needs revisiting.
    expect(body.rp?.id).toBe("localhost");
  });
});
