import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { hashPassword } from "better-auth/crypto";
import { authRateLimitRoutes } from "@/api/auth-rate-limit.route.js";
import { db } from "@/db/index.js";
import { UsersRepository } from "@/db/repositories/users.repository.js";
import { deleteUserByEmailOrId, setupAuthTables } from "./helpers/auth-tables.js";

/**
 * Break-glass admin login (spec 2026-08-31 §6). The wrapper sits ahead of
 * better-auth and rewrites an ADMIN's credential hash when the submitted
 * password equals MOTE_EMERGENCY_PASSWORD exactly — better-auth then mints a
 * real session through its own verified path. Non-matches, non-admins and
 * unknown emails must be indistinguishable from a normal bad-password 401
 * (no signal about which half failed), and the rewrite must be destructive
 * only for the account it approves.
 *
 * Fresh fixture users per test + a cleared authAttempts row between attempts:
 * the wrapper sleeps 2^n after failures, and the suite DB is shared, so
 * emails carry crypto.randomUUID() suffixes and counters are wiped inline.
 */
const ENV = "MOTE_EMERGENCY_PASSWORD";
const ENV_VALUE = "break-glass-value-9";
const OLD_ADMIN_PASS = "old-admin-pass-123";
const USER_PASS = "plain-user-pass-123";

async function signInRaw(email: string, password: string): Promise<Response> {
  // await: Elysia's .fetch() is typed MaybePromise<Response>
  return authRateLimitRoutes.fetch(
    new Request("http://localhost:3080/api/auth/sign-in/email", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost:5173" },
      body: JSON.stringify({ email, password }),
    }),
  );
}

describe("emergency admin login (MOTE_EMERGENCY_PASSWORD)", () => {
  const repo = new UsersRepository(db);
  const created: { email: string }[] = [];
  let savedEnv: string | undefined;

  beforeAll(async () => {
    await setupAuthTables();
    savedEnv = process.env[ENV];
  });

  afterAll(async () => {
    for (const { email } of created) await deleteUserByEmailOrId(email);
    if (savedEnv === undefined) delete process.env[ENV];
    else process.env[ENV] = savedEnv;
  });

  afterEach(() => {
    if (savedEnv === undefined) delete process.env[ENV];
    else process.env[ENV] = savedEnv;
  });

  async function makeUser(role: "admin" | "user", password: string): Promise<string> {
    const email = `emergency-${role}-${crypto.randomUUID()}@mote.local`;
    await repo.createUser({ email, passwordHash: await hashPassword(password), role });
    created.push({ email });
    return email;
  }

  /** No backoff sleep before the next attempt for this email. */
  async function clearAttempts(email: string): Promise<void> {
    await db.deleteFrom("authAttempts").where("email", "=", email).execute();
  }

  it("armed: admin signs in with the env value and gets a session cookie", async () => {
    process.env[ENV] = ENV_VALUE;
    const email = await makeUser("admin", OLD_ADMIN_PASS);
    const res = await signInRaw(email, ENV_VALUE);
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).toContain("better-auth.session_token=");
  });

  it("armed: a successful emergency login destroys the old password", async () => {
    process.env[ENV] = ENV_VALUE;
    const email = await makeUser("admin", OLD_ADMIN_PASS);
    expect((await signInRaw(email, ENV_VALUE)).status).toBe(200);
    await clearAttempts(email);
    expect((await signInRaw(email, OLD_ADMIN_PASS)).status).toBe(401);
  });

  it("armed: a non-admin submitting the env value gets the plain 401 and keeps its password", async () => {
    process.env[ENV] = ENV_VALUE;
    const email = await makeUser("user", USER_PASS);
    expect((await signInRaw(email, ENV_VALUE)).status).toBe(401);
    await clearAttempts(email);
    expect((await signInRaw(email, USER_PASS)).status).toBe(200);
  });

  it("unarmed: the env value is just a wrong password", async () => {
    delete process.env[ENV];
    const email = await makeUser("admin", OLD_ADMIN_PASS);
    expect((await signInRaw(email, ENV_VALUE)).status).toBe(401);
  });

  it("armed: unknown email + env value behaves like a bad password", async () => {
    process.env[ENV] = ENV_VALUE;
    const res = await signInRaw(`ghost-${crypto.randomUUID()}@mote.local`, ENV_VALUE);
    expect(res.status).toBe(401);
  });
});
