import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { hashPassword } from "better-auth/crypto";
import { Elysia } from "elysia";
import { setHasUsersProbeForTests } from "@/api/setup.route.js";
import { setAgentInstallDepsForTests, setupAgentInstallRoute } from "@/api/setup-agent-install.route.js";
import { authDatabase } from "@/auth/database.js";
import { db } from "@/db/index.js";
import { SubshellsRepository } from "@/db/repositories/subshells.repository.js";
import { UsersRepository } from "@/db/repositories/users.repository.js";
import { errorHandlerPlugin } from "@/plugins/error-handler.plugin.js";
import { issueSubshellToken } from "@/services/subshell-tokens.js";
import { authedRequest, deleteUserByEmailOrId, setupAuthTables, signIn } from "./helpers/auth-tables.js";

/**
 * `POST /api/setup/agents/:pluginId/install` (spec 2026-09-11 § 7).
 *
 * Unlike the rest of `/api/setup`, this route is NEVER public: it makes the
 * control-plane host fetch and run an installer, so an unauthenticated caller
 * reaching it on a fresh instance would be remote code execution regardless
 * of the built-in id allowlist. The 401-with-no-users case below is the one
 * that matters most — it proves the route does not inherit the rest of
 * `/api/setup`'s first-run public window.
 */

const app = new Elysia().use(errorHandlerPlugin).use(setupAgentInstallRoute);

function bearerRequest(path: string, key: string, init?: RequestInit): Request {
  const headers = new Headers(init?.headers);
  headers.set("authorization", `Bearer ${key}`);
  return new Request(`http://localhost:3080${path}`, { ...init, headers });
}

async function install(pluginId: string, init?: RequestInit): Promise<Response> {
  return await app.fetch(
    new Request(`http://localhost:3080/api/setup/agents/${pluginId}/install`, { method: "POST", ...init }),
  );
}

describe("POST /api/setup/agents/:pluginId/install", () => {
  const email = `agent-install-${crypto.randomUUID()}@subshell.local`;
  const password = "agent-install-pass-1234";
  const adminEmail = `agent-install-admin-${crypto.randomUUID()}@subshell.local`;
  let userId: string;
  let cookie: string;
  let adminCookie: string;
  let subshellId = "";
  let subshellKey = "";
  let apiKeyId: string | undefined;

  beforeAll(async () => {
    await setupAuthTables();

    userId = await new UsersRepository(db).createUser({
      email,
      passwordHash: await hashPassword(password),
      role: "user",
    });
    cookie = await signIn(email, password);

    await new UsersRepository(db).createUser({
      email: adminEmail,
      passwordHash: await hashPassword(password),
      role: "admin",
    });
    adminCookie = await signIn(adminEmail, password);

    subshellId = crypto.randomUUID();
    await new SubshellsRepository(db).create({
      id: subshellId,
      userId,
      profileId: "p",
      harnessId: "claude-code",
      name: "agent-install-test",
      workingDir: "/tmp",
      tmuxSocket: null,
    });
    subshellKey = await issueSubshellToken(subshellId, userId);
    apiKeyId = (await new SubshellsRepository(db).findById(subshellId))?.apiKeyId ?? undefined;
  });

  afterAll(async () => {
    setHasUsersProbeForTests(null);
    setAgentInstallDepsForTests(null);
    if (subshellId) await db.deleteFrom("subshells").where("id", "=", subshellId).execute();
    if (apiKeyId) authDatabase().run(`DELETE FROM apikey WHERE id = ?`, [apiKeyId]);
    if (userId) await db.deleteFrom("userMeta").where("userId", "=", userId).execute();
    await deleteUserByEmailOrId(email);
    await deleteUserByEmailOrId(adminEmail);
  });

  it("401s with no credential at all, even while the instance has no users yet", async () => {
    // The load-bearing case: the rest of /api/setup is public during
    // first-run, but this route makes the host run a remote installer, so it
    // must stay behind an admin cookie regardless of hasUsersProbe.
    setHasUsersProbeForTests(async () => false);
    try {
      const res = await install("claude-code");
      expect(res.status).toBe(401);
    } finally {
      setHasUsersProbeForTests(null);
    }
  });

  it("403s a signed-in non-admin cookie", async () => {
    const req = authedRequest(`/api/setup/agents/claude-code/install`, cookie, { method: "POST" });
    const res = await app.fetch(req);
    expect(res.status).toBe(403);
  });

  it("403s any bearer key, including a valid subshell key", async () => {
    const res = await app.fetch(
      bearerRequest("/api/setup/agents/claude-code/install", subshellKey, { method: "POST" }),
    );
    expect(res.status).toBe(403);
  });

  it("400s an id this build does not carry", async () => {
    const req = authedRequest(`/api/setup/agents/nope/install`, adminCookie, { method: "POST" });
    const res = await app.fetch(req);
    expect(res.status).toBe(400);
  });

  it("400s an id with nothing to install", async () => {
    const req = authedRequest(`/api/setup/agents/terminal/install`, adminCookie, { method: "POST" });
    const res = await app.fetch(req);
    expect(res.status).toBe(400);
  });

  it("409s a second install of the same id while one is already running", async () => {
    setAgentInstallDepsForTests({ commandFor: async () => "sleep 0.5", timeoutMs: 5_000, extraPath: async () => [] });
    const first = app.fetch(authedRequest(`/api/setup/agents/codex/install`, adminCookie, { method: "POST" }));
    const second = await app.fetch(authedRequest(`/api/setup/agents/codex/install`, adminCookie, { method: "POST" }));
    expect(second.status).toBe(409);
    expect((await first).status).toBe(200);
  });

  it("200s for the admin, running the fake installer and re-probing the harness", async () => {
    setAgentInstallDepsForTests({ commandFor: async () => "echo ok", timeoutMs: 5_000, extraPath: async () => [] });
    const req = authedRequest(`/api/setup/agents/claude-code/install`, adminCookie, { method: "POST" });
    const res = await app.fetch(req);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; output: string; harness: { id: string } };
    expect(body.ok).toBe(true);
    expect(body.output).toContain("ok");
    expect(body.harness.id).toBe("claude-code");
  });
});
