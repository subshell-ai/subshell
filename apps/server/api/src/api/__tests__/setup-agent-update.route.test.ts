import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { hashPassword } from "better-auth/crypto";
import { Elysia } from "elysia";
import { setHasUsersProbeForTests } from "@/api/setup.route.js";
import {
  setAgentCommandDepsForTests,
  setupAgentInstallRoute,
  setupAgentUpdateRoute,
} from "@/api/setup-agent-command.route.js";
import { authDatabase } from "@/auth/database.js";
import { db } from "@/db/index.js";
import { AuditRepository } from "@/db/repositories/audit.repository.js";
import { SubshellsRepository } from "@/db/repositories/subshells.repository.js";
import { UsersRepository } from "@/db/repositories/users.repository.js";
import { errorHandlerPlugin } from "@/plugins/error-handler.plugin.js";
import { issueSubshellToken } from "@/services/subshell-tokens.js";
import { authedRequest, deleteUserByEmailOrId, setupAuthTables, signIn } from "./helpers/auth-tables.js";

/**
 * `POST /api/setup/agents/:pluginId/update` (spec 2026-09-28 § 2), the update
 * twin of `setup-agent-install.route.test.ts`. The fixture machinery is that
 * file's: same gate (admin cookie only, NEVER public, so the no-users 401 is
 * again the load-bearing case), same seams, same audit shape under the
 * `agent.update` action. Both routes are mounted on one app because the
 * single flight is SHARED ACROSS KINDS: an update must not run beside an
 * install of the same id, and the refusal sentence names the work under way.
 */

const app = new Elysia().use(errorHandlerPlugin).use(setupAgentInstallRoute).use(setupAgentUpdateRoute);

function bearerRequest(path: string, key: string, init?: RequestInit): Request {
  const headers = new Headers(init?.headers);
  headers.set("authorization", `Bearer ${key}`);
  return new Request(`http://localhost:3080${path}`, { ...init, headers });
}

async function update(pluginId: string, init?: RequestInit): Promise<Response> {
  return await app.fetch(
    new Request(`http://localhost:3080/api/setup/agents/${pluginId}/update`, { method: "POST", ...init }),
  );
}

/** Audit rows for one action + id, newest first (mirrors the install file's `agentInstallAudit`). */
async function auditRows(
  action: string,
  pluginId: string,
): Promise<{ actorUserId: string | null; targetType: string | null; metadata: Record<string, unknown> }[]> {
  const events = await new AuditRepository(db).listLatest(300);
  return events
    .filter((e) => e.action === action && e.targetId === pluginId)
    .map((e) => ({
      actorUserId: e.actorUserId,
      targetType: e.targetType,
      metadata: JSON.parse(String(e.metadataJson ?? "{}")) as Record<string, unknown>,
    }));
}

/** The `agent.update` audit trail for one id, newest first. */
async function agentUpdateAudit(pluginId: string) {
  return await auditRows("agent.update", pluginId);
}

describe("POST /api/setup/agents/:pluginId/update", () => {
  const email = `agent-update-${crypto.randomUUID()}@subshell.local`;
  const password = "agent-update-pass-1234";
  const adminEmail = `agent-update-admin-${crypto.randomUUID()}@subshell.local`;
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
      name: email,
      passwordHash: await hashPassword(password),
      role: "user",
    });
    cookie = await signIn(email, password);

    await new UsersRepository(db).createUser({
      email: adminEmail,
      name: adminEmail,
      passwordHash: await hashPassword(password),
      role: "admin",
    });
    adminCookie = await signIn(adminEmail, password);

    subshellId = crypto.randomUUID();
    await new SubshellsRepository(db).create({
      id: subshellId,
      userId,
      presetId: "p",
      harnessId: "claude-code",
      name: "agent-update-test",
      workingDir: "/tmp",
      tmuxSocket: null,
    });
    subshellKey = await issueSubshellToken(subshellId, userId);
    apiKeyId = (await new SubshellsRepository(db).findById(subshellId))?.apiKeyId ?? undefined;
  });

  afterAll(async () => {
    setHasUsersProbeForTests(null);
    setAgentCommandDepsForTests("update", null);
    setAgentCommandDepsForTests("install", null);
    if (subshellId) await db.deleteFrom("subshells").where("id", "=", subshellId).execute();
    if (apiKeyId) authDatabase().run(`DELETE FROM apikey WHERE id = ?`, [apiKeyId]);
    if (userId) await db.deleteFrom("userMeta").where("userId", "=", userId).execute();
    await deleteUserByEmailOrId(email);
    await deleteUserByEmailOrId(adminEmail);
  });

  it("401s with no credential at all, even while the instance has no users yet", async () => {
    // The load-bearing case, same as the install file's: the rest of
    // /api/setup is public during first-run, but this route makes the host
    // run a vendor command, so it must stay behind an admin cookie regardless
    // of hasUsersProbe.
    setHasUsersProbeForTests(async () => false);
    try {
      const res = await update("claude-code");
      expect(res.status).toBe(401);
    } finally {
      setHasUsersProbeForTests(null);
    }
  });

  it("403s a signed-in non-admin cookie", async () => {
    const req = authedRequest(`/api/setup/agents/claude-code/update`, cookie, { method: "POST" });
    const res = await app.fetch(req);
    expect(res.status).toBe(403);
  });

  it("403s any bearer key, including a valid subshell key", async () => {
    const res = await app.fetch(bearerRequest("/api/setup/agents/claude-code/update", subshellKey, { method: "POST" }));
    expect(res.status).toBe(403);
  });

  it("400s an id this build does not carry, as a status and not a frame", async () => {
    // Refusal-before-the-body, the cheap id to prove: once a stream starts the
    // status line is sent and 200 cannot be taken back.
    const req = authedRequest(`/api/setup/agents/nope/update`, adminCookie, { method: "POST" });
    const res = await app.fetch(req);
    expect(res.status).toBe(400);
    expect(res.headers.get("content-type")).toContain("application/json");
  });

  it("400s an id with nothing to update, falling back to its empty install command", async () => {
    // Real built-in fixture: `terminal` declares no update command and its
    // install command is empty, so the fallback has nothing to run either.
    const req = authedRequest(`/api/setup/agents/terminal/update`, adminCookie, { method: "POST" });
    const res = await app.fetch(req);
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("nothing to update");
  });

  it("409s an INSTALL of the same id while an update is running (shared single flight)", async () => {
    // The second request must arrive AFTER the first has taken the in-flight
    // slot, and firing them back to back does not guarantee that; the install
    // file's test explains the gate. Here the point is the CROSS kind: the
    // slot is per-id, not per-id-and-kind, and the sentence names the work
    // under way ("being updated"), not the kind being refused.
    let entered!: () => void;
    const firstIsInside = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let calls = 0;
    setAgentCommandDepsForTests("update", {
      commandFor: async () => {
        if (++calls === 1) entered();
        return "sleep 0.2";
      },
      timeoutMs: 5_000,
      extraPath: async () => [],
    });
    setAgentCommandDepsForTests("install", {
      commandFor: async () => "sleep 99",
      timeoutMs: 5_000,
      extraPath: async () => [],
    });
    // `codex` is out of bounds: the install file's own 409 case sleeps on it
    // and that stream outlives its test, and `bun test` shares one process.
    // `hermes` is a real built-in id nothing else runs long here.
    try {
      const first = app.fetch(authedRequest(`/api/setup/agents/hermes/update`, adminCookie, { method: "POST" }));
      await firstIsInside;
      await new Promise((resolve) => setTimeout(resolve, 0));

      const second = await app.fetch(
        authedRequest(`/api/setup/agents/hermes/install`, adminCookie, { method: "POST" }),
      );
      expect(second.status).toBe(409);
      const body = (await second.json()) as { message?: string };
      expect(body.message).toContain("already being updated");
      expect((await first).status).toBe(200);
    } finally {
      // The install seam must not leak: the install route's own file expects
      // the real manifest when it runs after this one.
      setAgentCommandDepsForTests("install", null);
    }
  });

  it("200s for the admin, running the fake updater and re-probing the harness", async () => {
    setAgentCommandDepsForTests("update", {
      commandFor: async (_id, kind) => (kind === "update" ? "echo up" : "sleep 99"),
      timeoutMs: 5_000,
      extraPath: async () => [],
    });
    const req = authedRequest(`/api/setup/agents/claude-code/update`, adminCookie, { method: "POST" });
    const res = await app.fetch(req);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/x-ndjson");
    const frames = (await res.text())
      .split("\n")
      .filter((l) => l.trim() !== "")
      .map(
        (l) =>
          JSON.parse(l) as { type: string; text?: string; ok?: boolean; output?: string; harness?: { id: string } },
      );
    expect(frames.some((f) => f.type === "line" && f.text === "up")).toBe(true);
    const done = frames.at(-1);
    expect(done?.type).toBe("done");
    expect(done?.ok).toBe(true);
    expect(done?.output).toContain("up");
    expect(done?.harness?.id).toBe("claude-code");
  });

  it("audits exactly one agent.update row and no agent.install row", async () => {
    // A fresh id: the rows for ids used above are that run's, and this case
    // asks "exactly one" about a command that ran nowhere else.
    setAgentCommandDepsForTests("update", {
      commandFor: async () => "true",
      timeoutMs: 5_000,
      extraPath: async () => [],
    });
    const res = await app.fetch(authedRequest(`/api/setup/agents/opencode/update`, adminCookie, { method: "POST" }));
    expect(res.status).toBe(200);
    const frames = (await res.text())
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(frames.at(-1)).toMatchObject({ type: "done", ok: true, exitCode: 0 });
    expect((frames.at(-1) as { harness: Record<string, unknown> }).harness.id).toBe("opencode");

    const audits = await agentUpdateAudit("opencode");
    expect(audits).toHaveLength(1);
    expect(audits[0]?.targetType).toBe("plugin");
    expect(audits[0]?.metadata).toMatchObject({ ok: true, exitCode: 0 });
    expect(typeof audits[0]?.metadata.durationMs).toBe("number");
    // The update action is its own: the trail must not claim an install ran.
    expect(await auditRows("agent.install", "opencode")).toHaveLength(0);
  });
});
