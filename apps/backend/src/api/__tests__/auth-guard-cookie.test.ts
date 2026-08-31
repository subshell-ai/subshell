import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { hashPassword } from "better-auth/crypto";
import { sessionRoutes } from "@/api/sessions/index.js";
import { db } from "@/db/index.js";
import { UsersRepository } from "@/db/repositories/users.repository.js";
import { authedRequest, deleteUserByEmailOrId, setupAuthTables, signIn } from "./helpers/auth-tables.js";

/**
 * The cookie half of authGuard. better-auth names its session cookie
 * `__Secure-better-auth.session_token` (not the bare name) whenever the
 * effective baseURL is https — so any TLS-terminated deployment (a reverse
 * proxy, say) shipped cookies the guard's hardcoded name never matched:
 * sign-in itself 200s (better-auth reads both spellings), while every
 * guarded /api route 401s with INVALID_CREDENTIALS (incident: the
 * mote.ein.disaresta.com proxy, 2026-08-31).
 */
describe("authGuard cookie path", () => {
  let email: string;
  let _userId: string;
  const password = "cookie-guard-pass-1";
  let token: string;

  beforeAll(async () => {
    await setupAuthTables();
    email = `cookie-${crypto.randomUUID()}@mote.local`;
    _userId = await new UsersRepository(db).createUser({
      email,
      passwordHash: await hashPassword(password),
      role: "user",
    });
    token = await signIn(email, password);
  });

  afterAll(async () => {
    await deleteUserByEmailOrId(email);
  });

  it("accepts the plain cookie name (http deployments)", async () => {
    const res = await sessionRoutes.fetch(authedRequest("/api/sessions", token));
    expect(res.status).toBe(200);
  });

  it("accepts the __Secure- cookie name better-auth issues over https", async () => {
    const res = await sessionRoutes.fetch(
      new Request("http://localhost:3080/api/sessions", {
        headers: { cookie: `__Secure-better-auth.session_token=${token}` },
      }),
    );
    expect(res.status).toBe(200);
  });
});
