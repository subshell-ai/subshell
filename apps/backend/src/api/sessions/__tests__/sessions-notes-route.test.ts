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
 * PATCH /api/sessions/:id/notes — the self-only rule: a session bearer key
 * may write the note of ITS OWN session and never another session's, even
 * one owned by the same user (requirePerm is scope-wide; the per-row check
 * is the route's).
 */
describe("PATCH /api/sessions/:id/notes (self-only)", () => {
  let userId: string;
  const email = `notes-${crypto.randomUUID()}@mote.local`;
  const pw = "notes-pass-1";
  const createdSessions: string[] = [];
  const createdKeys: string[] = [];

  beforeAll(async () => {
    await setupAuthTables();
    userId = await new UsersRepository(db).createUser({ email, passwordHash: await hashPassword(pw), role: "user" });
    await signIn(email, pw);
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
      name: "notes-test",
      workingDir: "/tmp",
      tmuxSocket: null,
    });
    const key = await issueSessionToken(id, userId);
    const row = await new SessionsRepository(db).findById(id);
    if (row?.apiKeyId) createdKeys.push(row.apiKeyId);
    return { id, key };
  }

  function patchNotes(id: string, key: string, notes: string) {
    return sessionRoutes.fetch(
      new Request(`http://localhost:3080/api/sessions/${id}/notes`, {
        method: "PATCH",
        headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
        body: JSON.stringify({ notes }),
      }),
    );
  }

  it("a session token writes its own note (200) but not another session's (403)", async () => {
    const a = await sessionWithToken();
    const b = await sessionWithToken();
    expect((await patchNotes(a.id, a.key, "mine")).status).toBe(200);
    expect((await patchNotes(b.id, a.key, "not mine")).status).toBe(403);
    const bRow = await new SessionsRepository(db).findById(b.id);
    expect(bRow?.notes).toBeNull();
  });
});
