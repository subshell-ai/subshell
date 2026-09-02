import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { hashPassword } from "better-auth/crypto";
import { sessionRoutes } from "@/api/sessions/index.js";
import { authDatabase } from "@/auth/database.js";
import { auth } from "@/auth.js";
import { db } from "@/db/index.js";
import { SessionsRepository } from "@/db/repositories/sessions.repository.js";
import { UsersRepository } from "@/db/repositories/users.repository.js";
import { issueSessionToken } from "@/services/session-tokens.js";
import { authedRequest, deleteUserByEmailOrId, setupAuthTables, signIn } from "../../__tests__/helpers/auth-tables.js";

/**
 * The extend-token route's security property: a session bearer key can
 * refresh ITS OWN expiry — and never another session's. Owner cookies can
 * extend any of their own sessions.
 */
describe("POST /api/sessions/:id/extend-token", () => {
  let userId: string;
  let token: string;
  const email = `ext-${crypto.randomUUID()}@subshell.local`;
  const pw = "extend-pass-1";
  const createdSessions: string[] = [];
  const createdKeys: string[] = [];

  beforeAll(async () => {
    await setupAuthTables();
    userId = await new UsersRepository(db).createUser({ email, passwordHash: await hashPassword(pw), role: "user" });
    token = await signIn(email, pw);
  });

  afterAll(async () => {
    for (const kid of createdKeys) authDatabase().run("DELETE FROM apikey WHERE id = ?", [kid]);
    for (const sid of createdSessions) await db.deleteFrom("sessions").where("id", "=", sid).execute();
    await deleteUserByEmailOrId(email);
  });

  async function sessionWithToken(): Promise<{ id: string; key: string }> {
    const id = crypto.randomUUID();
    createdSessions.push(id);
    await new SessionsRepository(db).create({
      id,
      userId,
      profileId: "p",
      harnessId: "claude-code",
      name: "ext",
      workingDir: "/tmp",
      tmuxSocket: null,
    });
    const key = await issueSessionToken(id, userId);
    const row = await new SessionsRepository(db).findById(id);
    if (row?.apiKeyId) createdKeys.push(row.apiKeyId);
    return { id, key };
  }

  async function bearerExtend(id: string, key: string) {
    const res = await sessionRoutes.fetch(
      new Request(`http://localhost:3080/api/sessions/${id}/extend-token`, {
        method: "POST",
        headers: { authorization: `Bearer ${key}` },
      }),
    );
    return { status: res.status, body: res.ok ? ((await res.json()) as { extended: boolean }) : null };
  }

  it("owner cookie extends its own session token", async () => {
    const s = await sessionWithToken();
    const res = await sessionRoutes.fetch(
      authedRequest(`/api/sessions/${s.id}/extend-token`, token, { method: "POST" }),
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as { extended: boolean }).extended).toBe(true);
  });

  it("a session token extends itself (200) but not another session (403)", async () => {
    const a = await sessionWithToken();
    const b = await sessionWithToken();
    const own = await bearerExtend(a.id, a.key);
    expect(own.status).toBe(200);
    expect(own.body?.extended).toBe(true);
    const cross = await bearerExtend(b.id, a.key);
    expect(cross.status).toBe(403);
  });

  it("session without a token reports extended:false", async () => {
    const id = crypto.randomUUID();
    createdSessions.push(id);
    await new SessionsRepository(db).create({
      id,
      userId,
      profileId: "p",
      harnessId: "claude-code",
      name: "no-token",
      workingDir: "/tmp",
      tmuxSocket: null,
    });
    const res = await sessionRoutes.fetch(authedRequest(`/api/sessions/${id}/extend-token`, token, { method: "POST" }));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { extended: boolean }).extended).toBe(false);
  });

  it("anonymous -> 401", async () => {
    const res = await sessionRoutes.fetch(
      new Request("http://localhost:3080/api/sessions/any/extend-token", { method: "POST" }),
    );
    expect(res.status).toBe(401);
  });

  // A session token that is linked (passes the guard's apiKeyId check) but
  // carries a reduced grant set — proves the routes enforce requirePerm, not
  // just that session tokens reach them. issueSessionToken always mints full
  // grants, so mint the linked key directly to scope it down.
  async function sessionWithScopedToken(permissions: Record<string, string[]>): Promise<{ id: string; key: string }> {
    const id = crypto.randomUUID();
    createdSessions.push(id);
    await new SessionsRepository(db).create({
      id,
      userId,
      profileId: "p",
      harnessId: "claude-code",
      name: "scoped",
      workingDir: "/tmp",
      tmuxSocket: null,
    });
    const created = (await auth.api.createApiKey({
      body: { name: `sess:${id}`, userId, metadata: { kind: "session", sessionId: id }, permissions },
    })) as unknown as { id: string; key: string };
    createdKeys.push(created.id);
    await new SessionsRepository(db).update(id, { apiKeyId: created.id });
    return { id, key: created.key };
  }

  it("session-key grant gates sessions routes: read passes, write -> 403", async () => {
    const s = await sessionWithScopedToken({ sessions: ["read"] });
    const list = await sessionRoutes.fetch(
      new Request("http://localhost:3080/api/sessions", { headers: { authorization: `Bearer ${s.key}` } }),
    );
    expect(list.status).toBe(200); // read grant is sufficient
    const term = await sessionRoutes.fetch(
      new Request(`http://localhost:3080/api/sessions/${s.id}/terminate`, {
        method: "POST",
        headers: { authorization: `Bearer ${s.key}` },
      }),
    );
    expect(term.status).toBe(403); // write not granted
  });
});
