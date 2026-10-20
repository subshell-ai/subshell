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
    const served = ((await state.json()) as { agents: { startedAt: number }[] }).agents;
    // Every served child carries the server's sighting stamp; the harness's
    // own words come back unchanged beside it.
    expect(served.map(({ startedAt: _stamp, ...rest }) => rest)).toEqual(body.agents);
    expect(typeof served[0]?.startedAt).toBe("number");
    expect((await request(a.id, "/select", cookie, { agentId: "missing" })).status).toBe(409);
    expect((await request(a.id, "/select", cookie, { agentId: "child" })).status).toBe(200);
    const poll = await request(a.id, "/report", { authorization: `Bearer ${a.key}` }, body);
    expect(((await poll.json()) as { command: { agentId: string } }).command.agentId).toBe("child");
    expect((await request(a.id, "/select", { authorization: `Bearer ${a.key}` }, { agentId: "child" })).status).toBe(
      403,
    );
  });
  it("answers the batch collection through its own route, visible only to those who see the pane", async () => {
    // GET /api/subshells/subagents sits where the :id detail route could
    // shadow it (id = "subagents"), and it is the sidebar's ONE poll per tick.
    // A route-order regression here silences the whole feature, so pin both
    // the answer shape and the per-viewer visibility.
    const a = await subshellWithToken();
    const own = { authorization: `Bearer ${a.key}` };
    expect(
      (
        await request(a.id, "/report", own, {
          event: "snapshot",
          agents: [{ id: "child", name: "Review", status: "running" }],
        })
      ).status,
    ).toBe(200);
    const ownerCookieHdr = { cookie: `better-auth.session_token=${ownerCookie}` };
    const res = await app.fetch(new Request("http://localhost/api/subshells/subagents", { headers: ownerCookieHdr }));
    expect(res.status).toBe(200);
    const all = (await res.json()) as Record<string, { agents: { startedAt: number }[] }>;
    expect(all[a.id]?.agents.map(({ startedAt: _stamp, ...rest }) => rest)).toEqual([
      { id: "child", name: "Review", status: "running" },
    ]);
    const foreignEmail = `subagent-stranger-${crypto.randomUUID()}@subshell.local`;
    const foreignId = await new UsersRepository(db).createUser({
      email: foreignEmail,
      name: foreignEmail,
      passwordHash: await hashPassword(pw),
      role: "user",
    });
    try {
      const foreign = { cookie: `better-auth.session_token=${await signIn(foreignEmail, pw)}` };
      const unseen = (await (
        await app.fetch(new Request("http://localhost/api/subshells/subagents", { headers: foreign }))
      ).json()) as Record<string, unknown>;
      expect(a.id in unseen).toBe(false);
    } finally {
      void foreignId;
      await deleteUserByEmailOrId(foreignEmail);
    }
  });

  it("pairs a describe label with the next child of its type and normalizes it", async () => {
    const a = await subshellWithToken();
    const own = { authorization: `Bearer ${a.key}` };
    expect(
      (
        await request(a.id, "/report", own, {
          event: "describe",
          agentType: "Explorer",
          activity: "Map the \u001b[31mrepo",
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await request(a.id, "/report", own, {
          event: "start",
          agents: [{ id: "c1", name: "Explorer", status: "running" }],
        })
      ).status,
    ).toBe(200);
    const view = (await (await request(a.id, "", own)).json()) as {
      agents: { id: string; activity?: string; startedAt: number }[];
    };
    const c1 = view.agents.find((agent) => agent.id === "c1");
    // The pane-reported label takes the same NAME-path treatment as names:
    // the ESC becomes a space, and readers get one line, not a terminal.
    expect(c1?.activity).toBe("Map the [31mrepo");
    expect(typeof c1?.startedAt).toBe("number");
  });

  it("refuses oversized and malformed reports at the boundary with production errors", async () => {
    const a = await subshellWithToken();
    const own = { authorization: `Bearer ${a.key}` };
    const longName = { event: "snapshot", agents: [{ id: "x", name: "n".repeat(161), status: "running" }] };
    expect((await request(a.id, "/report", own, longName)).status).toBe(400);
    const badEvent = { event: "explode" };
    expect((await request(a.id, "/report", own, badEvent)).status).toBe(400);
    const badStatus = { event: "snapshot", agents: [{ id: "x", name: "n", status: "paused" }] };
    expect((await request(a.id, "/report", own, badStatus)).status).toBe(400);
    const tooMany = {
      event: "snapshot",
      agents: Array.from({ length: 257 }, (_, i) => ({ id: `a${i}`, name: `n${i}`, status: "idle" })),
    };
    expect((await request(a.id, "/report", own, tooMany)).status).toBe(400);
  });

  it("refuses a finished pane and a superseded key, and normalizes pane-reported names", async () => {
    const gone = await subshellWithToken("terminated");
    const body = { event: "snapshot", agents: [{ id: "child", name: "Review", status: "running" }] };
    expect((await request(gone.id, "/report", { authorization: `Bearer ${gone.key}` }, body)).status).toBe(409);
    // A restart rotates the key on the same row; the OLD key must not keep
    // writing into the NEW run's state. Re-issue revokes the old key, so the
    // guard's "the row is lifecycle truth" answers 401 before the route's
    // own-key currentness 403 can be reached (that 403 is the in-flight race).
    const a = await subshellWithToken();
    await issueSubshellToken(a.id, userId);
    expect((await request(a.id, "/report", { authorization: `Bearer ${a.key}` }, body)).status).toBe(401);
    const b = await subshellWithToken();
    // Pane-reported text is a NAME path: control characters (ESC included)
    // fold to spaces and format characters drop before anything is stored.
    const raw = {
      event: "snapshot",
      agents: [{ id: "c", name: "Esc\u001b loop \u007f ", status: "running" }],
      unavailableReason: "bad\u0007 chars\t here ",
    };
    expect((await request(b.id, "/report", { authorization: `Bearer ${b.key}` }, raw)).status).toBe(200);
    const clean = (await (await request(b.id, "", { cookie: `better-auth.session_token=${ownerCookie}` })).json()) as {
      agents: { name: string }[];
      unavailableReason?: string;
    };
    expect(clean.agents[0]?.name).toBe("Esc loop");
    expect(clean.unavailableReason).toBe("bad chars here");
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
