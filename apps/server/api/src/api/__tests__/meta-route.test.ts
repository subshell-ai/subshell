import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { hashPassword } from "better-auth/crypto";
import { Elysia } from "elysia";
import { metaRoutes } from "@/api/meta.route.js";
import { db } from "@/db/index.js";
import { UsersRepository } from "@/db/repositories/users.repository.js";
import { errorHandlerPlugin } from "@/plugins/error-handler.plugin.js";
import { SERVER_VERSION } from "@/version.js";
import { authedRequest, deleteUserByEmailOrId, setupAuthTables, signIn } from "./helpers/auth-tables.js";

/**
 * GET /api/meta/status.
 *
 * This route had NO test and reported a hardcoded `appVersion: "1.0.0"` while
 * the server was at 1.5.0 — a lie that survived five releases precisely
 * because nothing compared it to anything. It also has no callers, so no
 * feature broke to reveal it. The assertion below is the whole point of the
 * file: the reported version must be DERIVED, never restated.
 */
const app = new Elysia().use(errorHandlerPlugin).use(metaRoutes);

describe("GET /api/meta/status", () => {
  let userId: string;
  const email = `meta-user-${crypto.randomUUID()}@subshell.local`;
  const password = "meta-user-pass-1";
  let cookie: string;

  beforeAll(async () => {
    await setupAuthTables();
    userId = await new UsersRepository(db).createUser({
      email,
      passwordHash: await hashPassword(password),
      role: "user",
    });
    cookie = await signIn(email, password);
  });

  afterAll(async () => {
    await deleteUserByEmailOrId(userId);
  });

  it("reports the real SERVER_VERSION, not a literal", async () => {
    const res = await app.fetch(authedRequest("/api/meta/status", cookie));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { appVersion: string; serverTime: string };
    expect(body.appVersion).toBe(SERVER_VERSION);
    // Guard the guard: a SERVER_VERSION that had itself gone empty or
    // undefined would satisfy the compare above and prove nothing.
    expect(body.appVersion).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("stamps a parseable ISO server time", async () => {
    const res = await app.fetch(authedRequest("/api/meta/status", cookie));
    const body = (await res.json()) as { serverTime: string };
    expect(Number.isNaN(Date.parse(body.serverTime))).toBe(false);
  });

  it("stays behind authGuard — anonymous callers get 401", async () => {
    const res = await app.fetch(new Request("http://localhost:3080/api/meta/status"));
    expect(res.status).toBe(401);
  });
});
