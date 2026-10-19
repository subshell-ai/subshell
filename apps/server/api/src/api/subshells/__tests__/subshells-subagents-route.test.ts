import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { hashPassword } from "better-auth/crypto";
import { Elysia } from "elysia";
import { subshellRoutes } from "@/api/subshells/index.js";
import { authDatabase } from "@/auth/database.js";
import { db } from "@/db/index.js";
import { SubshellSharesRepository } from "@/db/repositories/subshell-shares.repository.js";
import { SubshellsRepository } from "@/db/repositories/subshells.repository.js";
import { UsersRepository } from "@/db/repositories/users.repository.js";
import { errorHandlerPlugin } from "@/plugins/error-handler.plugin.js";
import { issueSubshellToken } from "@/services/subshell-tokens.js";
import { deleteUserByEmailOrId, setupAuthTables, signIn } from "../../__tests__/helpers/auth-tables.js";

// errorHandlerPlugin mounted like createApp() so validation failures
// serialize like production (400, not Elysia's raw 422).
const app = new Elysia().use(errorHandlerPlugin).use(subshellRoutes);

/**
 * Only the parent's own bearer may report children. Shared viewers may switch
 * the native view, but that permission must never grant terminal input.
 */
describe("harness subagent reporting and selection", () => {
  let userId: string;
  const email = `hagents-${crypto.randomUUID()}@subshell.local`;
  const pw = "hagents-pass-1";
  const createdSubshells: string[] = [];
  const createdKeys: string[] = [];

  let ownerCookie: string;

  beforeAll(async () => {
    await setupAuthTables();
    userId = await new UsersRepository(db).createUser({
      email,
      name: email,
      passwordHash: await hashPassword(pw),
      role: "user",
    });
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
      name: "hagents-test",
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

  function request(id: string, suffix: string, headers: Record<string, string>, body?: unknown) {
    return app.fetch(
      new Request(`http://localhost/api/subshells/${id}/subagents${suffix}`, {
        method: body === undefined ? "GET" : "POST",
        headers: { "content-type": "application/json", ...headers },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
  }
  it("keeps reports across requests, rejects foreign reporters, and queues only known children", async () => {
    const a = await subshellWithToken();
    const b = await subshellWithToken();
    const cookie = { cookie: `better-auth.session_token=${ownerCookie}` };
    const body = { event: "snapshot", agents: [{ id: "child", name: "Review", status: "running" }], canSelect: true };
    expect((await request(a.id, "/report", { authorization: `Bearer ${b.key}` }, body)).status).toBe(403);
    expect((await request(a.id, "/report", cookie, body)).status).toBe(403);
    expect((await request(a.id, "/report", { authorization: `Bearer ${a.key}` }, body)).status).toBe(200);
    const state = await request(a.id, "", cookie);
    expect(state.status).toBe(200);
    expect(((await state.json()) as { agents: unknown[] }).agents).toEqual(body.agents);
    expect((await request(a.id, "/select", cookie, { agentId: "missing" })).status).toBe(409);
    expect((await request(a.id, "/select", cookie, { agentId: "child" })).status).toBe(200);
    const poll = await request(a.id, "/report", { authorization: `Bearer ${a.key}` }, body);
    expect(((await poll.json()) as { command: { agentId: string } }).command.agentId).toBe("child");
    expect((await request(a.id, "/select", { authorization: `Bearer ${a.key}` }, { agentId: "child" })).status).toBe(
      403,
    );
  });
  it("viewers can select the shared view but cannot send terminal input, and strangers see nothing", async () => {
    const email = `subagent-viewer-${crypto.randomUUID()}@subshell.local`;
    const viewerId = await new UsersRepository(db).createUser({
      email,
      name: email,
      passwordHash: await hashPassword(pw),
      role: "user",
    });
    try {
      const cookie = { cookie: `better-auth.session_token=${await signIn(email, pw)}` };
      const a = await subshellWithToken();
      await request(
        a.id,
        "/report",
        { authorization: `Bearer ${a.key}` },
        { event: "snapshot", agents: [{ id: "child", name: "Review", status: "running" }], canSelect: true },
      );
      expect((await request(a.id, "", cookie)).status).toBe(404);
      expect((await request(a.id, "/select", cookie, { agentId: "child" })).status).toBe(404);
      await new SubshellSharesRepository(db).replaceForSubshell(
        a.id,
        [{ granteeUserId: viewerId, permission: "view" }],
        userId,
      );
      expect((await request(a.id, "/select", cookie, { agentId: "child" })).status).toBe(200);
      const input = await app.fetch(
        new Request(`http://localhost/api/subshells/${a.id}/input`, {
          method: "POST",
          headers: { ...cookie, "content-type": "application/json" },
          body: JSON.stringify({ text: "unsafe", submit: true }),
        }),
      );
      expect(input.status).toBe(403);
    } finally {
      await deleteUserByEmailOrId(email);
    }
  });
});
