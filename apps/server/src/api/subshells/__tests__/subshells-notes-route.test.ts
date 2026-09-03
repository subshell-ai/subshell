import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { hashPassword } from "better-auth/crypto";
import { subshellRoutes } from "@/api/subshells/index.js";
import { authDatabase } from "@/auth/database.js";
import { db } from "@/db/index.js";
import { SubshellsRepository } from "@/db/repositories/subshells.repository.js";
import { UsersRepository } from "@/db/repositories/users.repository.js";
import { issueSubshellToken } from "@/services/subshell-tokens.js";
import { deleteUserByEmailOrId, setupAuthTables, signIn } from "../../__tests__/helpers/auth-tables.js";

/**
 * PATCH /api/subshells/:id/notes — the self-only rule: a subshell bearer key
 * may write the note of ITS OWN subshell and never another subshell's, even
 * one owned by the same user (requirePerm is scope-wide; the per-row check
 * is the route's).
 */
describe("PATCH /api/subshells/:id/notes (self-only)", () => {
  let userId: string;
  const email = `notes-${crypto.randomUUID()}@subshell.local`;
  const pw = "notes-pass-1";
  const createdSubshells: string[] = [];
  const createdKeys: string[] = [];

  beforeAll(async () => {
    await setupAuthTables();
    userId = await new UsersRepository(db).createUser({ email, passwordHash: await hashPassword(pw), role: "user" });
    await signIn(email, pw);
  });

  afterAll(async () => {
    for (const kid of createdKeys) authDatabase().run("DELETE FROM apikey WHERE id = ?", [kid]);
    for (const sid of createdSubshells) await db.deleteFrom("subshells").where("id", "=", sid).execute();
    await deleteUserByEmailOrId(email);
  });

  async function subshellWithToken(): Promise<{ id: string; key: string }> {
    const id = crypto.randomUUID();
    createdSubshells.push(id);
    await new SubshellsRepository(db).create({
      id,
      userId,
      profileId: "p",
      harnessId: "claude-code",
      name: "notes-test",
      workingDir: "/tmp",
      tmuxSocket: null,
    });
    const key = await issueSubshellToken(id, userId);
    const row = await new SubshellsRepository(db).findById(id);
    if (row?.apiKeyId) createdKeys.push(row.apiKeyId);
    return { id, key };
  }

  function patchNotes(id: string, key: string, notes: string) {
    return subshellRoutes.fetch(
      new Request(`http://localhost:3080/api/subshells/${id}/notes`, {
        method: "PATCH",
        headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
        body: JSON.stringify({ notes }),
      }),
    );
  }

  it("a subshell token writes its own note (200) but not another subshell's (403)", async () => {
    const a = await subshellWithToken();
    const b = await subshellWithToken();
    expect((await patchNotes(a.id, a.key, "mine")).status).toBe(200);
    expect((await patchNotes(b.id, a.key, "not mine")).status).toBe(403);
    const bRow = await new SubshellsRepository(db).findById(b.id);
    expect(bRow?.notes).toBeNull();
  });
});
