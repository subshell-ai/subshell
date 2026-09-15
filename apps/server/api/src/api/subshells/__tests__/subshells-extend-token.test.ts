import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { hashPassword } from "better-auth/crypto";
import { subshellRoutes } from "@/api/subshells/index.js";
import { authDatabase } from "@/auth/database.js";
import { getAuth } from "@/auth.js";
import { db } from "@/db/index.js";
import { SubshellsRepository } from "@/db/repositories/subshells.repository.js";
import { UsersRepository } from "@/db/repositories/users.repository.js";
import { issueSubshellToken } from "@/services/subshell-tokens.js";
import { authedRequest, deleteUserByEmailOrId, setupAuthTables, signIn } from "../../__tests__/helpers/auth-tables.js";

/**
 * The extend-token route's security property: a subshell bearer key can
 * refresh ITS OWN expiry — and never another subshell's. Owner cookies can
 * extend any of their own subshells.
 */
describe("POST /api/subshells/:id/extend-token", () => {
  let userId: string;
  let token: string;
  const email = `ext-${crypto.randomUUID()}@subshell.local`;
  const pw = "extend-pass-1";
  const createdSubshells: string[] = [];
  const createdKeys: string[] = [];

  beforeAll(async () => {
    await setupAuthTables();
    userId = await new UsersRepository(db).createUser({
      email,
      name: email,
      passwordHash: await hashPassword(pw),
      role: "user",
    });
    token = await signIn(email, pw);
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
      presetId: "p",
      harnessId: "claude-code",
      name: "ext",
      workingDir: "/tmp",
      tmuxSocket: null,
    });
    const key = await issueSubshellToken(id, userId);
    const row = await new SubshellsRepository(db).findById(id);
    if (row?.apiKeyId) createdKeys.push(row.apiKeyId);
    return { id, key };
  }

  async function bearerExtend(id: string, key: string) {
    const res = await subshellRoutes.fetch(
      new Request(`http://localhost:3080/api/subshells/${id}/extend-token`, {
        method: "POST",
        headers: { authorization: `Bearer ${key}` },
      }),
    );
    return { status: res.status, body: res.ok ? ((await res.json()) as { extended: boolean }) : null };
  }

  it("owner cookie extends its own subshell token", async () => {
    const s = await subshellWithToken();
    const res = await subshellRoutes.fetch(
      authedRequest(`/api/subshells/${s.id}/extend-token`, token, { method: "POST" }),
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as { extended: boolean }).extended).toBe(true);
  });

  it("a subshell token extends itself (200) but not another subshell (403)", async () => {
    const a = await subshellWithToken();
    const b = await subshellWithToken();
    const own = await bearerExtend(a.id, a.key);
    expect(own.status).toBe(200);
    expect(own.body?.extended).toBe(true);
    const cross = await bearerExtend(b.id, a.key);
    expect(cross.status).toBe(403);
  });

  it("subshell without a token reports extended:false", async () => {
    const id = crypto.randomUUID();
    createdSubshells.push(id);
    await new SubshellsRepository(db).create({
      id,
      userId,
      presetId: "p",
      harnessId: "claude-code",
      name: "no-token",
      workingDir: "/tmp",
      tmuxSocket: null,
    });
    const res = await subshellRoutes.fetch(
      authedRequest(`/api/subshells/${id}/extend-token`, token, { method: "POST" }),
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as { extended: boolean }).extended).toBe(false);
  });

  it("anonymous -> 401", async () => {
    const res = await subshellRoutes.fetch(
      new Request("http://localhost:3080/api/subshells/any/extend-token", { method: "POST" }),
    );
    expect(res.status).toBe(401);
  });

  // A subshell token that is linked (passes the guard's apiKeyId check) but
  // carries a reduced grant set — proves the routes enforce requirePerm, not
  // just that subshell tokens reach them. issueSubshellToken always mints full
  // grants, so mint the linked key directly to scope it down.
  async function subshellWithScopedToken(permissions: Record<string, string[]>): Promise<{ id: string; key: string }> {
    const id = crypto.randomUUID();
    createdSubshells.push(id);
    await new SubshellsRepository(db).create({
      id,
      userId,
      presetId: "p",
      harnessId: "claude-code",
      name: "scoped",
      workingDir: "/tmp",
      tmuxSocket: null,
    });
    const created = (await getAuth().api.createApiKey({
      body: { name: `sess:${id}`, userId, metadata: { kind: "subshell", subshellId: id }, permissions },
    })) as unknown as { id: string; key: string };
    createdKeys.push(created.id);
    await new SubshellsRepository(db).update(id, { apiKeyId: created.id });
    return { id, key: created.key };
  }

  it("subshell-key grant gates subshells routes: read passes, write -> 403", async () => {
    const s = await subshellWithScopedToken({ subshells: ["read"] });
    const list = await subshellRoutes.fetch(
      new Request("http://localhost:3080/api/subshells", { headers: { authorization: `Bearer ${s.key}` } }),
    );
    expect(list.status).toBe(200); // read grant is sufficient
    const term = await subshellRoutes.fetch(
      new Request(`http://localhost:3080/api/subshells/${s.id}/terminate`, {
        method: "POST",
        headers: { authorization: `Bearer ${s.key}` },
      }),
    );
    expect(term.status).toBe(403); // write not granted
  });
});
