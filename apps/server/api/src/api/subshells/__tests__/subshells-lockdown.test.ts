import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { hashPassword } from "better-auth/crypto";
import { Elysia } from "elysia";
import { nodesRoutes } from "@/api/nodes/index.js";
import { settingsRoutes } from "@/api/settings.route.js";
import { subshellRoutes } from "@/api/subshells/index.js";
import { db } from "@/db/index.js";
import { NodesRepository } from "@/db/repositories/nodes.repository.js";
import { PresetsRepository } from "@/db/repositories/presets.repository.js";
import { SettingsRepository } from "@/db/repositories/settings.repository.js";
import { SubshellsRepository } from "@/db/repositories/subshells.repository.js";
import { UsersRepository } from "@/db/repositories/users.repository.js";
import { LOCAL_NODE_ID } from "@/db/types/nodes.db-types.js";
import { errorHandlerPlugin } from "@/plugins/error-handler.plugin.js";
import { LOCKDOWN_KEY } from "@/services/lockdown.js";
import { ensureLocalNode } from "@/services/nodes/seed-local.js";
import { deleteUserByEmailOrId, setupAuthTables, signIn } from "../../__tests__/helpers/auth-tables.js";

/**
 * Lockdown mode (operator ask, 2026-09-24): one instance-wide emergency
 * switch. Turning it ON stops every running subshell and refuses every new
 * one, on every machine, for every caller — admins and MCP sibling launches
 * included. Distinct from the two neighbours this file's siblings pin:
 *
 *   - `subshells-server-as-node.test.ts` is ONE HOST declining launches;
 *     lockdown is everywhere, so the node view must NOT change (`canLaunch`
 *     stays true — grey-ing only the Server while nodes are equally dead
 *     would be a lie), and
 *   - node maintenance is per-machine, owner-scoped and mirrored onto the
 *     machine; lockdown is neither — it is the plane refusing before any
 *     machine is consulted, which is why an implicit launch 403s here rather
 *     than answering NODE_REQUIRED.
 *
 * The gate is set through the SETTINGS ROW directly for the refusal cases
 * (the confirm-name ritual is pinned in `settings-route.test.ts`), but the
 * stop-all act runs through the real PATCH, because "what did it stop" is the
 * response's promise. Runs like the sibling suites: a bogus CLAUDE_PATH makes
 * a PASSED node gate answer 409 at the harness, which is how "back off ⇒
 * launches again" proves itself without a real `claude`.
 */

const app = new Elysia().use(errorHandlerPlugin).use(subshellRoutes).use(nodesRoutes).use(settingsRoutes);
const settings = new SettingsRepository(db);
const subshells = new SubshellsRepository(db);

/** A fake AGENT node, offline by definition — its rows retire unverified. */
const AGENT_NODE = `lkd-agent-${crypto.randomUUID().slice(0, 8)}`;

describe("lockdown mode", () => {
  const pw = "lkd-pass-1";
  const adminEmail = `lkd-admin-${crypto.randomUUID()}@subshell.local`;
  let adminCookie = "";
  let adminId = "";
  let presetId = "";
  const insertedIds: string[] = [];
  let previousClaudePath: string | undefined;

  async function setLockdownRow(on: boolean | null): Promise<void> {
    if (on === null) await db.deleteFrom("settings").where("key", "=", LOCKDOWN_KEY).execute();
    else await settings.set(LOCKDOWN_KEY, on);
  }

  beforeAll(async () => {
    previousClaudePath = process.env.CLAUDE_PATH;
    process.env.CLAUDE_PATH = "/definitely/not/here/claude";
    await setupAuthTables();
    adminId = await new UsersRepository(db).createUser({
      email: adminEmail,
      name: adminEmail,
      passwordHash: await hashPassword(pw),
      role: "admin",
    });
    adminCookie = await signIn(adminEmail, pw);
    await ensureLocalNode(db);
    const now = new Date().toISOString();
    await db
      .insertInto("nodes")
      .values({
        id: AGENT_NODE,
        ownerUserId: adminId,
        name: AGENT_NODE,
        kind: "agent",
        status: "offline",
        createdAt: now,
        updatedAt: now,
      } as never)
      .execute();
    const preset = await new PresetsRepository(db).create({
      id: crypto.randomUUID(),
      userId: adminId,
      harnessId: "claude-code",
      name: `lkd-${crypto.randomUUID().slice(0, 8)}`,
      description: null,
      envJson: null,
      flagsJson: null,
      settingsJson: null,
      configIsolation: 0,
    });
    presetId = preset.id;
  });

  afterAll(async () => {
    await setLockdownRow(null);
    if (insertedIds.length > 0) {
      await db.deleteFrom("subshells").where("id", "in", insertedIds).execute();
    }
    await db.deleteFrom("nodes").where("id", "=", AGENT_NODE).execute();
    await db.deleteFrom("presets").where("id", "=", presetId).execute();
    await db
      .deleteFrom("auditEvents")
      .where("actorUserId", "=", adminId)
      .where("action", "=", "settings.update")
      .where("targetId", "=", LOCKDOWN_KEY)
      .execute();
    await deleteUserByEmailOrId(adminEmail);
    if (previousClaudePath === undefined) delete process.env.CLAUDE_PATH;
    else process.env.CLAUDE_PATH = previousClaudePath;
  });

  async function req(path: string, init?: RequestInit): Promise<Response> {
    return app.fetch(
      new Request(`http://localhost:3080${path}`, {
        ...init,
        headers: { "content-type": "application/json", cookie: `better-auth.session_token=${adminCookie}` },
      }),
    );
  }
  const post = (body: unknown) => req("/api/subshells", { method: "POST", body: JSON.stringify(body) });
  const patchSettings = (body: unknown) => req("/api/settings", { method: "PATCH", body: JSON.stringify(body) });

  /** A running row with no tmuxSocket: the terminate path retires it through
   *  the bookkeeping half only (the maintenance suite's fixture rule). */
  async function seedRunning(nodeId: string): Promise<string> {
    const id = `lkd-${crypto.randomUUID().slice(0, 8)}`;
    insertedIds.push(id);
    await db
      .insertInto("subshells")
      .values({
        id,
        userId: adminId,
        name: id,
        harnessId: "claude-code",
        workingDir: "/tmp",
        tmuxSocket: null,
        nodeId,
        status: "running",
        alive: 1,
      } as never)
      .execute();
    return id;
  }

  it("an absent row means no lockdown: launches run and both reads say off", async () => {
    await setLockdownRow(null);
    const pub = (await (await req("/api/settings/public")).json()) as { lockdown: boolean };
    expect(pub.lockdown).toBe(false);
    const full = (await (await req("/api/settings")).json()) as { lockdown: boolean; localNodeName: string };
    expect(full.lockdown).toBe(false);
    expect(typeof full.localNodeName).toBe("string");
    // Past the lockdown gate; the bogus CLAUDE_PATH answers 409 next, which
    // is the proof the flag did NOT refuse.
    const res = await post({ harnessId: "claude-code", presetId, workingDir: "/tmp", nodeId: LOCAL_NODE_ID });
    expect(res.status).toBe(409);
  });

  it("an explicit launch while locked → 403 that names the lockdown", async () => {
    await setLockdownRow(true);
    const res = await post({ harnessId: "claude-code", presetId, workingDir: "/tmp", nodeId: LOCAL_NODE_ID });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { message: string };
    expect(body.message).toMatch(/lockdown/i);
    // The sibling remedies must not be confused with this one: neither a
    // share to ask for nor a maintenance window to wait out ends a lockdown.
    expect(body.message).not.toMatch(/[Ss]hare/);
    expect(body.message).not.toMatch(/maintenance/i);
  });

  it("an implicit launch is refused BEFORE any machine is chosen", async () => {
    await setLockdownRow(true);
    // No online agent in this harness ⇒ with no lockdown this answers
    // NODE_REQUIRED (the server-as-node suite pins that). Lockdown must
    // 403 first: the instance said no, the resolver was never asked.
    const res = await post({ harnessId: "claude-code", presetId, workingDir: "/tmp" });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { message: string }).message).toMatch(/lockdown/i);
  });

  it("a restart while locked is refused too", async () => {
    await setLockdownRow(true);
    const id = crypto.randomUUID();
    insertedIds.push(id);
    await subshells.create({
      id,
      userId: adminId,
      presetId,
      harnessId: "claude-code",
      name: `lkd-${id.slice(0, 8)}`,
      workingDir: "/tmp",
      tmuxSocket: `lkd-sock-${id}`,
      nodeId: LOCAL_NODE_ID,
      alive: 0,
    });
    const res = await req(`/api/subshells/${id}/restart`, { method: "POST" });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { message: string }).message).toMatch(/lockdown/i);
  });

  it("the lockdown is not a node fact: the node view is untouched", async () => {
    await setLockdownRow(true);
    const view = (await (await req(`/api/nodes/${LOCAL_NODE_ID}`)).json()) as {
      canLaunch: boolean;
      maintenance: boolean;
    };
    // The picker keeps offering the Server because EVERY machine is refused,
    // and the refusal the person meets says so — greying one row would blame
    // the wrong machine.
    expect(view.canLaunch).toBe(true);
    expect(view.maintenance).toBe(false);
  });

  it("turning it ON stops everything running and reports what it stopped", async () => {
    await setLockdownRow(null);
    const localId = await seedRunning(LOCAL_NODE_ID);
    const agentId = await seedRunning(AGENT_NODE);
    const name = (await new NodesRepository(db).findById(LOCAL_NODE_ID))?.name ?? "Server";

    const res = await patchSettings({ lockdown: true, lockdownConfirm: name });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { lockdown: boolean; stopped?: string[] };
    expect(body.lockdown).toBe(true);
    expect(body.stopped).toContain(localId);
    expect(body.stopped).toContain(agentId);

    // The rows are retired, not merely reported — a stop that only answered
    // in the response is a stop that never happened.
    for (const id of [localId, agentId]) {
      const row = await subshells.findById(id);
      expect(row?.status).toBe("terminated");
    }
    // And the trail names them, the way maintenance audits its list.
    const events = await db
      .selectFrom("auditEvents")
      .select(["metadataJson"])
      .where("actorUserId", "=", adminId)
      .where("action", "=", "settings.update")
      .where("targetId", "=", LOCKDOWN_KEY)
      .execute();
    const meta = JSON.parse(events.at(-1)?.metadataJson ?? "{}") as { stopped?: string[] };
    expect(meta.stopped).toContain(localId);
    expect(meta.stopped).toContain(agentId);
    await setLockdownRow(null);
  });

  it("ending asks the same name, and off frees launches again", async () => {
    await setLockdownRow(true);
    // The way OUT is as instance-wide an act as the way IN (operator ruling
    // 2026-09-24): an unanswered attempt leaves the ground still frozen.
    expect((await patchSettings({ lockdown: false })).status).toBe(400);
    const name = (await new NodesRepository(db).findById(LOCAL_NODE_ID))?.name ?? "Server";
    const res = await patchSettings({ lockdown: false, lockdownConfirm: name });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { lockdown: boolean }).lockdown).toBe(false);
    const pub = (await (await req("/api/settings/public")).json()) as { lockdown: boolean };
    expect(pub.lockdown).toBe(false);
    // Past the lockdown gate; the 409-harness from CLAUDE_PATH is the signal
    // the flag cleared (a 403 would mean it is still refusing).
    const launch = await post({ harnessId: "claude-code", presetId, workingDir: "/tmp", nodeId: LOCAL_NODE_ID });
    expect(launch.status).toBe(409);
  });

  it("survives as a real setting: a stored ON reads ON through the public route", async () => {
    await setLockdownRow(true);
    const pub = (await (await req("/api/settings/public")).json()) as { lockdown: boolean };
    expect(pub.lockdown).toBe(true);
    await setLockdownRow(null);
  });
});
