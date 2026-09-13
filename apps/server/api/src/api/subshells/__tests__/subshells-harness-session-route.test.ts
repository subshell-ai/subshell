import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { hashPassword } from "better-auth/crypto";
import { Elysia } from "elysia";
import { subshellRoutes } from "@/api/subshells/index.js";
import { authDatabase } from "@/auth/database.js";
import { db } from "@/db/index.js";
import { SubshellsRepository } from "@/db/repositories/subshells.repository.js";
import { UsersRepository } from "@/db/repositories/users.repository.js";
import { errorHandlerPlugin } from "@/plugins/error-handler.plugin.js";
import { issueSubshellToken } from "@/services/subshell-tokens.js";
import { deleteUserByEmailOrId, setupAuthTables, signIn } from "../../__tests__/helpers/auth-tables.js";

// errorHandlerPlugin mounted like createApp() so validation failures
// serialize like production (400, not Elysia's raw 422).
const app = new Elysia().use(errorHandlerPlugin).use(subshellRoutes);

/**
 * POST /api/subshells/:id/harness-session — the pane re-pins its harness
 * conversation id when the session changes IN-PANE (/clear, /resume, /fork —
 * nothing else tells the server, so restart-resume would resurrect a stale
 * transcript). Same self-only rule as /attention: the subshell's own bearer,
 * never another's, never a browser.
 */
describe("POST /api/subshells/:id/harness-session (self-only)", () => {
  let userId: string;
  const email = `hsess-${crypto.randomUUID()}@subshell.local`;
  const pw = "hsess-pass-1";
  const createdSubshells: string[] = [];
  const createdKeys: string[] = [];

  let ownerCookie: string;

  beforeAll(async () => {
    await setupAuthTables();
    userId = await new UsersRepository(db).createUser({ email, passwordHash: await hashPassword(pw), role: "user" });
    ownerCookie = await signIn(email, pw);
  });

  afterAll(async () => {
    for (const kid of createdKeys) authDatabase().run("DELETE FROM apikey WHERE id = ?", [kid]);
    for (const sid of createdSubshells) await db.deleteFrom("subshells").where("id", "=", sid).execute();
    await deleteUserByEmailOrId(email);
  });

  async function subshellWithToken(status = "running"): Promise<{ id: string; key: string }> {
    const id = crypto.randomUUID();
    createdSubshells.push(id);
    await new SubshellsRepository(db).create({
      id,
      userId,
      presetId: "p",
      harnessId: "claude-code",
      name: "hsess-test",
      workingDir: "/tmp",
      tmuxSocket: null,
    });
    if (status !== "running") {
      await new SubshellsRepository(db).update(id, { status: status as "terminated", alive: 0 });
    }
    const key = await issueSubshellToken(id, userId);
    const row = await new SubshellsRepository(db).findById(id);
    if (row?.apiKeyId) createdKeys.push(row.apiKeyId);
    return { id, key };
  }

  function report(id: string, key: string, sessionId: unknown) {
    return app.fetch(
      new Request(`http://localhost:3080/api/subshells/${id}/harness-session`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
        body: JSON.stringify({ sessionId }),
      }),
    );
  }

  it("a subshell token re-pins its OWN row's harness session id", async () => {
    const a = await subshellWithToken();
    const newId = crypto.randomUUID();
    const res = await report(a.id, a.key, newId);
    expect(res.status).toBe(200);
    const row = await new SubshellsRepository(db).findById(a.id);
    expect(row?.harnessSessionId).toBe(newId);
  });

  it("never writes another subshell's row (403) and leaves it untouched", async () => {
    const a = await subshellWithToken();
    const b = await subshellWithToken();
    const res = await report(b.id, a.key, crypto.randomUUID());
    expect(res.status).toBe(403);
    const bRow = await new SubshellsRepository(db).findById(b.id);
    expect(bRow?.harnessSessionId).toBeNull();
  });

  it("rejects a non-UUID sessionId (400)", async () => {
    const a = await subshellWithToken();
    const res = await report(a.id, a.key, "not-a-uuid");
    expect(res.status).toBe(400);
    const row = await new SubshellsRepository(db).findById(a.id);
    expect(row?.harnessSessionId).toBeNull();
  });

  it("a cookie actor (even the owner) is turned away — harness-only endpoint", async () => {
    const a = await subshellWithToken();
    const res = await app.fetch(
      new Request(`http://localhost:3080/api/subshells/${a.id}/harness-session`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie: `better-auth.session_token=${ownerCookie}` },
        body: JSON.stringify({ sessionId: crypto.randomUUID() }),
      }),
    );
    expect(res.status).toBe(403);
  });

  it("a terminated row silently drops the report (200, no write)", async () => {
    const a = await subshellWithToken("terminated");
    const res = await report(a.id, a.key, crypto.randomUUID());
    expect(res.status).toBe(200);
    const row = await new SubshellsRepository(db).findById(a.id);
    expect(row?.harnessSessionId).toBeNull();
  });
});
