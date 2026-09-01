import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { hashPassword } from "better-auth/crypto";
import { Elysia } from "elysia";
import { sessionRoutes } from "@/api/sessions/index.js";
import { authDatabase } from "@/auth/database.js";
import { db } from "@/db/index.js";
import { SessionsRepository } from "@/db/repositories/sessions.repository.js";
import { UsersRepository } from "@/db/repositories/users.repository.js";
import { errorHandlerPlugin } from "@/plugins/error-handler.plugin.js";
import { issueSessionToken } from "@/services/session-tokens.js";
import { deleteUserByEmailOrId, setupAuthTables, signIn } from "../../__tests__/helpers/auth-tables.js";

/**
 * PATCH /api/sessions/:id/replay — the per-session terminal history cap.
 * Cookie `edit`-tier config (rename/notes class): persisted as given, null
 * clears back to the instance default, 1–200 enforced by the schema, and
 * session bearer keys are refused outright.
 */
describe("PATCH /api/sessions/:id/replay", () => {
  let userId: string;
  let otherId: string;
  const email = `replay-${crypto.randomUUID()}@mote.local`;
  const pw = "replay-pass-1";
  const createdSessions: string[] = [];
  const createdKeys: string[] = [];
  let cookie = "";
  // Production shape: the global handler turns validation 422s into the shared 400 body.
  const app = new Elysia().use(errorHandlerPlugin).use(sessionRoutes);

  beforeAll(async () => {
    await setupAuthTables();
    userId = await new UsersRepository(db).createUser({ email, passwordHash: await hashPassword(pw), role: "user" });
    otherId = `replay-other-${crypto.randomUUID()}`;
    await new UsersRepository(db).createUser({
      email: `replay-other-${crypto.randomUUID()}@mote.local`,
      passwordHash: await hashPassword(pw),
      role: "user",
    });
    cookie = `better-auth.session_token=${await signIn(email, pw)}`;
  });

  afterAll(async () => {
    for (const kid of createdKeys) authDatabase().run("DELETE FROM apikey WHERE id = ?", [kid]);
    for (const sid of createdSessions) await db.deleteFrom("sessions").where("id", "=", sid).execute();
    await deleteUserByEmailOrId(email);
  });

  async function ownSession(): Promise<string> {
    const id = crypto.randomUUID();
    createdSessions.push(id);
    await new SessionsRepository(db).create({
      id,
      userId,
      profileId: "p",
      harnessId: "claude-code",
      name: "replay-test",
      workingDir: "/tmp",
      tmuxSocket: null,
    });
    return id;
  }

  function patch(id: string, body: unknown, headers: Record<string, string> = {}) {
    return app.fetch(
      new Request(`http://localhost:3080/api/sessions/${id}/replay`, {
        method: "PATCH",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(body),
      }),
    );
  }

  it("stores a valid per-session cap and clears it back to null", async () => {
    const id = await ownSession();
    const ok = await patch(id, { lines: 150 }, { cookie });
    expect(ok.status).toBe(200);
    expect((await new SessionsRepository(db).findById(id))?.terminalReplayLines).toBe(150);

    const cleared = await patch(id, { lines: null }, { cookie });
    expect(cleared.status).toBe(200);
    expect((await new SessionsRepository(db).findById(id))?.terminalReplayLines).toBeNull();
  });

  it("accepts the 1 and 200 bounds and rejects 0/201/non-integers with 400", async () => {
    const id = await ownSession();
    expect((await patch(id, { lines: 1 }, { cookie })).status).toBe(200);
    expect((await patch(id, { lines: 200 }, { cookie })).status).toBe(200);
    expect((await patch(id, { lines: 0 }, { cookie })).status).toBe(400);
    expect((await patch(id, { lines: 201 }, { cookie })).status).toBe(400);
    expect((await patch(id, { lines: 12.5 }, { cookie })).status).toBe(400);
  });

  it("refuses session bearer keys (human config surface)", async () => {
    const id = await ownSession();
    const key = await issueSessionToken(id, userId);
    const row = await new SessionsRepository(db).findById(id);
    if (row?.apiKeyId) createdKeys.push(row.apiKeyId);
    const res = await patch(id, { lines: 50 }, { authorization: `Bearer ${key}` });
    expect(res.status).toBe(403);
  });

  it("404s an invisible session without leaking existence", async () => {
    const res = await patch(crypto.randomUUID(), { lines: 50 }, { cookie });
    expect(res.status).toBe(404);
    // A session owned by ANOTHER user is also 404 (invisible, not 403).
    const other = crypto.randomUUID();
    createdSessions.push(other);
    await new SessionsRepository(db).create({
      id: other,
      userId: otherId,
      profileId: "p",
      harnessId: "claude-code",
      name: "foreign",
      workingDir: "/tmp",
      tmuxSocket: null,
    });
    expect((await patch(other, { lines: 50 }, { cookie })).status).toBe(404);
  });

  it("echoes terminalReplayLines on the session view", async () => {
    const id = await ownSession();
    await patch(id, { lines: 75 }, { cookie });
    const res = await app.fetch(new Request(`http://localhost:3080/api/sessions/${id}`, { headers: { cookie } }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { terminalReplayLines?: number | null };
    expect(body.terminalReplayLines).toBe(75);
  });
});
