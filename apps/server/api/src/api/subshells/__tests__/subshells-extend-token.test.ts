import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { generateKeypair } from "@internal/mcp-core";
import { hashPassword } from "better-auth/crypto";
import { channelRoutes } from "@/api/channels/index.js";
import { identityRoutes } from "@/api/identities.route.js";
import { subshellRoutes } from "@/api/subshells/index.js";
import { db } from "@/db/index.js";
import { SubshellsRepository } from "@/db/repositories/subshells.repository.js";
import { UsersRepository } from "@/db/repositories/users.repository.js";
import { getAuth } from "@/modules/auth/auth.js";
import { authDatabase } from "@/modules/auth/database.js";
import { issueSubshellToken, reportingTokenPermissions } from "@/modules/subshells/tokens.js";
import { authedRequest, deleteUserByEmailOrId, setupAuthTables, signIn } from "../../../testing/api/auth-tables.js";

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

  /**
   * The depth decision of the MCP-off switch, made visible at the HTTP
   * boundary. A pane whose MCP was refused (by account or node preference) is
   * minted `reportingTokenPermissions()`: the four harness self-report verbs
   * survive, and the sibling surface §4 of docs/security.md accounts for
   * disappears from the key itself, not just from the tool list a disabled
   * pane would never load. The full-scope control in the same test is what
   * makes the refusals mean SOMETHING: without it, a blanket 403 from a broken
   * fixture would pass for the wrong reason.
   */
  describe("a report-only pane token (MCP switched off)", () => {
    // `fetch` on a composed Elysia instance returns MaybePromise<Response>;
    // awaiting it here is what the route tests already do inline.
    async function bearer(
      route: { fetch(req: Request): Response | Promise<Response> },
      path: string,
      init?: RequestInit,
      key?: string,
    ) {
      const res = await route.fetch(
        new Request(`http://localhost:3080${path}`, {
          ...init,
          headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) },
        }),
      );
      return res.status;
    }

    it("passes all four hook doors: bell, exit, session id, roster", async () => {
      // One POST per door the `subshell report` verbs hit, because a per-file
      // revert of any ONE of them to requirePerm silently 403s an opted-out
      // pane's reporting for that verb (runReport swallows failures as "a lost
      // report") while every other suite stays green. `exit` goes LAST on
      // purpose: it writes the death row, and the roster door 409s a row that
      // is no longer live (the session door would answer 200 and silently
      // drop it).
      const s = await subshellWithScopedToken(reportingTokenPermissions());
      expect(
        await bearer(
          subshellRoutes,
          `/api/subshells/${s.id}/attention`,
          { method: "POST", body: '{"kind":"turn_complete"}' },
          s.key,
        ),
      ).toBe(200);
      expect(
        await bearer(
          subshellRoutes,
          `/api/subshells/${s.id}/harness-session`,
          { method: "POST", body: JSON.stringify({ sessionId: crypto.randomUUID() }) },
          s.key,
        ),
      ).toBe(200);
      expect(
        await bearer(
          subshellRoutes,
          `/api/subshells/${s.id}/subagents/report`,
          { method: "POST", body: '{"event":"snapshot","agents":[]}' },
          s.key,
        ),
      ).toBe(200);
      expect(
        await bearer(subshellRoutes, `/api/subshells/${s.id}/exit`, { method: "POST", body: '{"exitCode":0}' }, s.key),
      ).toBe(200);
    });

    it("still extends its own token: the door is ownership-only, so the 7-day wall never lands", async () => {
      // Every `subshell report` verb but `exit` rides this extend, and a
      // report-only pane launches no MCP child to arm the periodic one. If a
      // future pass gates this route on a scope (plausibly `subshells:write`,
      // which every pre-switch pane key held), this cell goes red now rather
      // than leaving a long-lived opted-out pane's hooks to silently 403 a
      // week in.
      const s = await subshellWithScopedToken(reportingTokenPermissions());
      expect(await bearer(subshellRoutes, `/api/subshells/${s.id}/extend-token`, { method: "POST" }, s.key)).toBe(200);
    });

    it("cannot read a channel or register an identity: channels is absent from its map", async () => {
      const s = await subshellWithScopedToken(reportingTokenPermissions());
      // The channels read is the plain scope check.
      expect(await bearer(channelRoutes, "/api/channels", undefined, s.key)).toBe(403);
      // Identity registration is gated on channels:write, so it is the one door
      // that discriminates a narrowed pane from a full one even when the
      // legacy concession is in view. The map carries NEITHER `channels` nor
      // `prompts`, so it is not a recognizable pre-prompts shape and cannot
      // claim that pass.
      const { publicJwk } = await generateKeypair();
      expect(
        await bearer(
          identityRoutes,
          "/api/identities",
          { method: "POST", body: JSON.stringify({ publicKey: publicJwk }) },
          s.key,
        ),
      ).toBe(403);
    });

    it("control: the SAME doors accept a full-scope pane token", async () => {
      // Without this cell the two above only prove "some scoped token is
      // refused"; this proves the refusal is the narrowing, not the fixture.
      const s = await subshellWithScopedToken({ channels: ["read", "write"], subshells: ["read", "write"] });
      expect(await bearer(channelRoutes, "/api/channels", undefined, s.key)).toBe(200);
      const { publicJwk } = await generateKeypair();
      expect(
        await bearer(
          identityRoutes,
          "/api/identities",
          { method: "POST", body: JSON.stringify({ publicKey: publicJwk }) },
          s.key,
        ),
      ).toBe(200);
    });
  });
});
