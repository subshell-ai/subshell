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
import { consumeWsToken } from "@/ws/ws-token.js";
import { authedRequest, deleteUserByEmailOrId, setupAuthTables, signIn } from "./helpers/auth-tables.js";

/**
 * POST /api/auth/ws-token — the human mint is unscoped, machine mints are
 * bound to ONE subshell.
 *
 * The route was cookie-only because issueWsToken binds the attach token to
 * the authenticated USER id, and on a bearer request authGuard sets that to
 * the subshell's OWNER — an unscoped bearer mint would let any subshell token
 * drive a SIBLING agent's pane through /ws. That stays true: a subshell key
 * may mint only with subshellId equal to its OWN principal. A system key may
 * name any subshell (it is already the instance-wide bearer credential), and
 * every bearer token carries the binding that attach enforces at redemption;
 * /ws/live refuses scoped tokens outright. The minted token records the
 * SUBSHELL'S OWNER as its identity (the scoped binding, not the identity, is
 * the containment — the system service user would resolve access `none`).
 */

const app = new Elysia().use(errorHandlerPlugin).use(wsTokenRoutes);

describe("ws-token route (unscoped cookie mints, scoped bearer mints)", () => {
  let userId: string;
  const email = `wstok-${crypto.randomUUID()}@subshell.local`;
  const password = "wstok-pass-1234";
  let cookie: string;
  let subshellKey: string;
  let systemKey: string;
  let subshellId: string;
  let siblingId: string;
  const createdKeyIds: string[] = [];

  function bearerRequest(path: string, key: string, body?: unknown): Request {
    const headers = new Headers({ authorization: `Bearer ${key}` });
    const init: RequestInit = { method: "POST", headers };
    if (body !== undefined) {
      headers.set("content-type", "application/json");
      init.body = JSON.stringify(body);
    }
    return new Request(`http://localhost:3080${path}`, init);
  }

  async function mintedToken(res: Response): Promise<string> {
    expect(res.status).toBe(200);
    return ((await res.json()) as { token: string }).token;
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
    siblingId = crypto.randomUUID();
    for (const [id, name] of [
      [subshellId, "wstok-test"],
      [siblingId, "wstok-sibling"],
    ] as const) {
      await new SubshellsRepository(db).create({
        id,
        userId,
        presetId: "p",
        harnessId: "claude-code",
        name,
        workingDir: "/tmp",
        tmuxSocket: null,
      });
    }
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
    for (const id of [subshellId, siblingId]) {
      await db.deleteFrom("subshells").where("id", "=", id).execute();
    }
    for (const kid of createdKeyIds) authDatabase().run(`DELETE FROM apikey WHERE id = ?`, [kid]);
    await db.deleteFrom("userMeta").where("userId", "=", userId).execute();
    await deleteUserByEmailOrId(email);
  });

  it("anonymous -> 401", async () => {
    const res = await app.fetch(new Request("http://localhost:3080/api/auth/ws-token", { method: "POST" }));
    expect(res.status).toBe(401);
  });

  it("cookie session -> 200 with an UNBOUND attach token", async () => {
    const res = await app.fetch(authedRequest("/api/auth/ws-token", cookie, { method: "POST" }));
    const token = await mintedToken(res);
    // Unscoped: the human token attaches wherever the session's access
    // allows, exactly as the SPA and mobile always have.
    expect(consumeWsToken(token)).toEqual({ userId, subshellId: null });
  });

  it("cookie session ignores subshellId (scoping only narrows a human)", async () => {
    const res = await app.fetch(
      authedRequest("/api/auth/ws-token", cookie, {
        method: "POST",
        headers: new Headers({ "content-type": "application/json" }),
        body: JSON.stringify({ subshellId }),
      }),
    );
    const token = await mintedToken(res);
    expect(consumeWsToken(token)).toEqual({ userId, subshellId: null });
  });

  it("system key, no subshellId -> 400 (machine mints are always scoped)", async () => {
    const res = await app.fetch(bearerRequest("/api/auth/ws-token", systemKey));
    expect(res.status).toBe(400);
  });

  it("system key, unknown subshellId -> 404", async () => {
    const res = await app.fetch(bearerRequest("/api/auth/ws-token", systemKey, { subshellId: crypto.randomUUID() }));
    expect(res.status).toBe(404);
  });

  it("system key -> 200, bound to the named pane, recording the OWNER", async () => {
    const res = await app.fetch(bearerRequest("/api/auth/ws-token", systemKey, { subshellId }));
    const token = await mintedToken(res);
    // The identity is the subshell's owner (a scoped token resolves access
    // as the owner; the binding confines it to this one pane), and the
    // binding is the token's reason to exist.
    expect(consumeWsToken(token)).toEqual({ userId, subshellId });
  });

  it("subshell key -> 200 for its OWN pane only, bound", async () => {
    const res = await app.fetch(bearerRequest("/api/auth/ws-token", subshellKey, { subshellId }));
    const token = await mintedToken(res);
    expect(consumeWsToken(token)).toEqual({ userId, subshellId });
  });

  it("subshell key naming a SIBLING -> 403 (the original cookie-only rationale)", async () => {
    // A subshell key resolves as its OWNER on the guard; without this
    // equality check a pane's key could mint its way into any sibling of the
    // same owner. The refusal is ACCESS_DENIED, and NO token was spent.
    const res = await app.fetch(bearerRequest("/api/auth/ws-token", subshellKey, { subshellId: siblingId }));
    expect(res.status).toBe(403);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("ACCESS_DENIED");
  });

  it("subshell key, no subshellId -> 400 (no unscoped machine mints, ever)", async () => {
    const res = await app.fetch(bearerRequest("/api/auth/ws-token", subshellKey));
    expect(res.status).toBe(400);
  });
});
