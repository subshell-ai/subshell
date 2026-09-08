import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { authRateLimitRoutes } from "@/api/auth-rate-limit.route.js";
import { db } from "@/db/index.js";
import { setupAuthTables } from "./helpers/auth-tables.js";

/**
 * Route-level test for the sign-in rate limiter (Elysia wrapper over
 * better-auth). The wrapper reads and rebuilds the request body before
 * delegating; with the dev singleton DB these tests assert the real chain:
 * better-auth rejects the fake credential with 401, and the counter row is
 * recorded. Success-path clearing would need a real user; covered by the
 * live check plus authDelayMs/recordFailedLogin unit tests.
 */

describe("rate-limit route (redirect-off sign-in)", () => {
  beforeAll(async () => {
    await setupAuthTables();
  });
  afterAll(async () => {});

  const makeRequest = (email: string) => {
    const headers = new Headers({ "content-type": "application/json" });
    headers.set("origin", "http://localhost:5173");
    return new Request("http://localhost:3080/api/auth/sign-in/email", {
      method: "POST",
      headers,
      body: JSON.stringify({ email, password: "wrong-password" }),
    });
  };

  it("delegates to better-auth and records a failed attempt (401)", async () => {
    const email = `route-test-${crypto.randomUUID()}@subshell.local`;
    const res = await authRateLimitRoutes.fetch(makeRequest(email));
    expect(res.status).toBe(401);
    const row = await db
      .selectFrom("authAttempts")
      .select(["attemptCount", "lastAttemptAt"])
      .where("email", "=", email)
      .executeTakeFirst();
    expect(row?.attemptCount).toBe(1);
    expect(row?.lastAttemptAt).toBeTruthy();
    await db.deleteFrom("authAttempts").where("email", "=", email).execute();
  });

  it("rejects non-JSON bodies with 400 (the wrapper forwards JSON only)", async () => {
    const headers = new Headers({ "content-type": "application/x-www-form-urlencoded" });
    headers.set("origin", "http://localhost:5173");
    const req = new Request("http://localhost:3080/api/auth/sign-in/email", {
      method: "POST",
      headers,
      body: "email=a%40b.c&password=x",
    });
    const res = await authRateLimitRoutes.fetch(req);
    expect(res.status).toBe(400);
  });
});
