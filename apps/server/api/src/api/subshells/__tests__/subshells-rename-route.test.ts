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
 * PATCH /api/subshells/:id/name — the owner renames their subshell; blank
 * names are refused; a subshell bearer key can rename ITS OWN subshell and
 * never another's (same permission shape as /attention).
 */
describe("PATCH /api/subshells/:id/name", () => {
  let userId: string;
  let token: string;
  const email = `rename-${crypto.randomUUID()}@subshell.local`;
  const pw = "rename-pass-1";
  const createdSubshells: string[] = [];
  const createdKeys: string[] = [];

  beforeAll(async () => {
    await setupAuthTables();
    userId = await new UsersRepository(db).createUser({ email, passwordHash: await hashPassword(pw), role: "user" });
    token = await signIn(email, pw);
  });

  afterAll(async () => {
    for (const kid of createdKeys) authDatabase().run("DELETE FROM apikey WHERE id = ?", [kid]);
    for (const sid of createdSubshells) await db.deleteFrom("subshells").where("id", "=", sid).execute();
    await deleteUserByEmailOrId(email);
  });

  /** Creates a subshell row and mints its real bearer token. */
  async function subshellWithToken(name = "rename-me"): Promise<{ id: string; key: string }> {
    const id = crypto.randomUUID();
    createdSubshells.push(id);
    await new SubshellsRepository(db).create({
      id,
      userId,
      profileId: "p",
      harnessId: "claude-code",
      name,
      workingDir: "/tmp",
      tmuxSocket: null,
    });
    const key = await issueSubshellToken(id, userId);
    const row = await new SubshellsRepository(db).findById(id);
    if (row?.apiKeyId) createdKeys.push(row.apiKeyId);
    return { id, key };
  }

  function patch(id: string, body: unknown, headers: Record<string, string>) {
    return subshellRoutes.fetch(
      new Request(`http://localhost:3080/api/subshells/${id}/name`, {
        method: "PATCH",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(body),
      }),
    );
  }

  it("owner cookie renames and the row persists", async () => {
    const s = await subshellWithToken();
    const res = await patch(s.id, { name: "  API redesign  " }, { cookie: `better-auth.session_token=${token}` });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { ok: boolean }).ok).toBe(true);
    const row = await new SubshellsRepository(db).findById(s.id);
    expect(row?.name).toBe("API redesign"); // trimmed on the way in
  });

  it("renaming locks the name — a rename IS the pin, and there is no unlock path", async () => {
    const s = await subshellWithToken();
    const headers = { cookie: `better-auth.session_token=${token}` };
    await patch(s.id, { name: "Pinned by hand" }, headers);
    expect((await new SubshellsRepository(db).findById(s.id))?.nameLocked).toBe(1);

    // A second rename updates the name but never releases the lock (spec
    // 2026-09-03: the autoTitle escape hatch was removed with the pin UI).
    await patch(s.id, { name: "Renamed again" }, headers);
    const row = await new SubshellsRepository(db).findById(s.id);
    expect(row?.nameLocked).toBe(1);
    expect(row?.name).toBe("Renamed again");
  });

  it("empty body (no name) -> 400", async () => {
    const s = await subshellWithToken();
    const res = await patch(s.id, {}, { cookie: `better-auth.session_token=${token}` });
    expect(res.status).toBe(400);
  });

  it("blank (whitespace-only) name -> 400", async () => {
    const s = await subshellWithToken();
    const res = await patch(s.id, { name: "   " }, { cookie: `better-auth.session_token=${token}` });
    expect(res.status).toBe(400);
  });

  it("unknown subshell -> 404", async () => {
    const res = await patch(crypto.randomUUID(), { name: "x" }, { cookie: `better-auth.session_token=${token}` });
    expect(res.status).toBe(404);
  });

  it("a subshell token renames itself (200) but not another subshell (403)", async () => {
    const a = await subshellWithToken();
    const b = await subshellWithToken();
    expect((await patch(a.id, { name: "own rename" }, { authorization: `Bearer ${a.key}` })).status).toBe(200);
    expect((await patch(b.id, { name: "cross rename" }, { authorization: `Bearer ${a.key}` })).status).toBe(403);
    const bRow = await new SubshellsRepository(db).findById(b.id);
    expect(bRow?.name).toBe("rename-me");
  });

  it("unauthenticated -> 401", async () => {
    const s = await subshellWithToken();
    expect((await patch(s.id, { name: "x" }, {})).status).toBe(401);
  });
});
