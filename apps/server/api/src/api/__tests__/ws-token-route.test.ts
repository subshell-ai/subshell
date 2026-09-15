import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { hashPassword } from "better-auth/crypto";
import { Elysia } from "elysia";
import { wsTokenRoutes } from "@/api/ws-token.route.js";
import { authDatabase } from "@/auth/database.js";
import { ensureSystemUser } from "@/auth/system-user.js";
import { getAuth } from "@/auth.js";
import { db } from "@/db/index.js";
import { SubshellsRepository } from "@/db/repositories/subshells.repository.js";
import { UsersRepository } from "@/db/repositories/users.repository.js";
import { errorHandlerPlugin } from "@/plugins/error-handler.plugin.js";
import { issueSubshellToken } from "@/services/subshell-tokens.js";
import { authedRequest, deleteUserByEmailOrId, setupAuthTables, signIn } from "./helpers/auth-tables.js";

/**
 * POST /api/auth/ws-token is cookie-only.
 *
 * issueWsToken binds the attach token to the AUTHENTICATED USER id, and on a
 * bearer request authGuard sets that to the subshell's OWNER — so any subshell
 * token could previously mint an attach token and drive the terminal of ANY
 * sibling subshell of the same owner through /ws (full keystroke injection).
 * Interactive attach is a human path: no agent tool calls this route.
 */

const app = new Elysia().use(errorHandlerPlugin).use(wsTokenRoutes);

describe("ws-token route (cookie only)", () => {
  let userId: string;
  const email = `wstok-${crypto.randomUUID()}@subshell.local`;
  const password = "wstok-pass-1234";
  let cookie: string;
  let subshellKey: string;
  let systemKey: string;
  let subshellId: string;
  const createdKeyIds: string[] = [];

  function bearerRequest(path: string, key: string, init?: RequestInit): Request {
    const headers = new Headers(init?.headers);
    headers.set("authorization", `Bearer ${key}`);
    return new Request(`http://localhost:3080${path}`, { ...init, headers });
  }

  beforeAll(async () => {
    await setupAuthTables();
    userId = await new UsersRepository(db).createUser({
      email,
      name: email,
      passwordHash: await hashPassword(password),
      role: "user",
    });
    cookie = await signIn(email, password);

    subshellId = crypto.randomUUID();
    await new SubshellsRepository(db).create({
      id: subshellId,
      userId,
      presetId: "p",
      harnessId: "claude-code",
      name: "wstok-test",
      workingDir: "/tmp",
      tmuxSocket: null,
    });
    subshellKey = await issueSubshellToken(subshellId, userId);
    const row = await new SubshellsRepository(db).findById(subshellId);
    if (row?.apiKeyId) createdKeyIds.push(row.apiKeyId);

    const created = (await getAuth().api.createApiKey({
      body: { name: "wstok-sys-test", userId: await ensureSystemUser(), metadata: { kind: "system" } },
    })) as unknown as { id: string; key: string };
    createdKeyIds.push(created.id);
    systemKey = created.key;
  });

  afterAll(async () => {
    await db.deleteFrom("subshells").where("id", "=", subshellId).execute();
    for (const kid of createdKeyIds) authDatabase().run(`DELETE FROM apikey WHERE id = ?`, [kid]);
    await db.deleteFrom("userMeta").where("userId", "=", userId).execute();
    await deleteUserByEmailOrId(email);
  });

  it("anonymous -> 401", async () => {
    const res = await app.fetch(new Request("http://localhost:3080/api/auth/ws-token", { method: "POST" }));
    expect(res.status).toBe(401);
  });

  it("cookie session -> 200 with an attach token", async () => {
    const res = await app.fetch(authedRequest("/api/auth/ws-token", cookie, { method: "POST" }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { token: string };
    expect(typeof body.token).toBe("string");
    expect(body.token.length).toBeGreaterThan(0);
  });

  it("subshell token -> 403 (cannot mint owner-bound attach tokens)", async () => {
    const res = await app.fetch(bearerRequest("/api/auth/ws-token", subshellKey, { method: "POST" }));
    expect(res.status).toBe(403);
    const body = (await res.json()) as { code: string; statusCode: number };
    expect(body.code).toBe("ACCESS_DENIED");
    expect(body.statusCode).toBe(403);
  });

  it("system key -> 403", async () => {
    const res = await app.fetch(bearerRequest("/api/auth/ws-token", systemKey, { method: "POST" }));
    expect(res.status).toBe(403);
  });
});
