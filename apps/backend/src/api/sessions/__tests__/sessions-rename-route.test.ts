import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { hashPassword } from "better-auth/crypto";
import { sessionRoutes } from "@/api/sessions/index.js";
import { authDatabase } from "@/auth/database.js";
import { db } from "@/db/index.js";
import { SessionsRepository } from "@/db/repositories/sessions.repository.js";
import { UsersRepository } from "@/db/repositories/users.repository.js";
import { issueSessionToken } from "@/services/session-tokens.js";
import { deleteUserByEmailOrId, setupAuthTables, signIn } from "../../__tests__/helpers/auth-tables.js";

/**
 * PATCH /api/sessions/:id/name — the owner renames their session; blank
 * names are refused; a session bearer key can rename ITS OWN session and
 * never another's (same permission shape as the notes route).
 */
describe("PATCH /api/sessions/:id/name", () => {
  let userId: string;
  let token: string;
  const email = `rename-${crypto.randomUUID()}@subshell.local`;
  const pw = "rename-pass-1";
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

  /** Creates a session row and mints its real bearer token. */
  async function sessionWithToken(name = "rename-me"): Promise<{ id: string; key: string }> {
    const id = crypto.randomUUID();
    createdSessions.push(id);
    await new SessionsRepository(db).create({
      id,
      userId,
      profileId: "p",
      harnessId: "claude-code",
      name,
      workingDir: "/tmp",
      tmuxSocket: null,
    });
    const key = await issueSessionToken(id, userId);
    const row = await new SessionsRepository(db).findById(id);
    if (row?.apiKeyId) createdKeys.push(row.apiKeyId);
    return { id, key };
  }

  function patch(id: string, body: unknown, headers: Record<string, string>) {
    return sessionRoutes.fetch(
      new Request(`http://localhost:3080/api/sessions/${id}/name`, {
        method: "PATCH",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(body),
      }),
    );
  }

  it("owner cookie renames and the row persists", async () => {
    const s = await sessionWithToken();
    const res = await patch(s.id, { name: "  API redesign  " }, { cookie: `better-auth.session_token=${token}` });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { ok: boolean }).ok).toBe(true);
    const row = await new SessionsRepository(db).findById(s.id);
    expect(row?.name).toBe("API redesign"); // trimmed on the way in
  });

  it("renaming locks the name; autoTitle toggles the lock", async () => {
    const s = await sessionWithToken();
    const headers = { cookie: `better-auth.session_token=${token}` };
    await patch(s.id, { name: "Pinned by hand" }, headers);
    expect((await new SessionsRepository(db).findById(s.id))?.nameLocked).toBe(1);

    expect((await patch(s.id, { autoTitle: true }, headers)).status).toBe(200);
    expect((await new SessionsRepository(db).findById(s.id))?.nameLocked).toBe(0);

    // Pinning without a rename keeps the current name and locks it.
    expect((await patch(s.id, { autoTitle: false }, headers)).status).toBe(200);
    const row = await new SessionsRepository(db).findById(s.id);
    expect(row?.nameLocked).toBe(1);
    expect(row?.name).toBe("Pinned by hand");
  });

  it("empty body (no name, no autoTitle) -> 400", async () => {
    const s = await sessionWithToken();
    const res = await patch(s.id, {}, { cookie: `better-auth.session_token=${token}` });
    expect(res.status).toBe(400);
  });

  it("blank (whitespace-only) name -> 400", async () => {
    const s = await sessionWithToken();
    const res = await patch(s.id, { name: "   " }, { cookie: `better-auth.session_token=${token}` });
    expect(res.status).toBe(400);
  });

  it("unknown session -> 404", async () => {
    const res = await patch(crypto.randomUUID(), { name: "x" }, { cookie: `better-auth.session_token=${token}` });
    expect(res.status).toBe(404);
  });

  it("a session token renames itself (200) but not another session (403)", async () => {
    const a = await sessionWithToken();
    const b = await sessionWithToken();
    expect((await patch(a.id, { name: "own rename" }, { authorization: `Bearer ${a.key}` })).status).toBe(200);
    expect((await patch(b.id, { name: "cross rename" }, { authorization: `Bearer ${a.key}` })).status).toBe(403);
    const bRow = await new SessionsRepository(db).findById(b.id);
    expect(bRow?.name).toBe("rename-me");
  });

  it("unauthenticated -> 401", async () => {
    const s = await sessionWithToken();
    expect((await patch(s.id, { name: "x" }, {})).status).toBe(401);
  });
});
