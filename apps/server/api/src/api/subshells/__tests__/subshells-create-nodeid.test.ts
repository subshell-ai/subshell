import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NodeCommandBody } from "@internal/subshell-protocol";
import { hashPassword } from "better-auth/crypto";
import { spawnSync } from "bun";
import { Elysia } from "elysia";
import { subshellRoutes } from "@/api/subshells/index.js";
import { ensureSystemUser } from "@/auth/system-user.js";
import { getAuth } from "@/auth.js";
import { db } from "@/db/index.js";
import { NodesRepository } from "@/db/repositories/nodes.repository.js";
import { ProfilesRepository } from "@/db/repositories/profiles.repository.js";
import { SubshellsRepository } from "@/db/repositories/subshells.repository.js";
import { UsersRepository } from "@/db/repositories/users.repository.js";
import { LOCAL_NODE_ID } from "@/db/types/nodes.db-types.js";
import { errorHandlerPlugin } from "@/plugins/error-handler.plugin.js";
import {
  attachConnection,
  detachConnection,
  type NodeConnection,
  type NodeSocket,
  resetNodeRegistryForTests,
} from "@/services/nodes/node-registry.js";
import { resolveResult } from "@/services/nodes/node-rpc.js";
import { ensureLocalNode } from "@/services/nodes/seed-local.js";
import { issueSubshellToken } from "@/services/subshell-tokens.js";
import { deleteUserByEmailOrId, setupAuthTables, signIn } from "../../__tests__/helpers/auth-tables.js";

/**
 * The phase-2 create-subshell node contract (spec 2026-08-31 §6.6): the
 * phase-1 `NODE_LAUNCH_NOT_READY` blanket is gone — `POST /api/subshells`
 * resolves a launch node (requested → pinned → local → single-online-agent
 * auto-pick) and every refusal is the resolution's own structured error.
 * The matrix itself is unit-tested in `subshells-resolve-launch-node.test.ts`;
 * this file pins the HTTP surface: status codes + bodies, the strict
 * bearer-actor rule, `nodeOffline` on views, and the unchanged 200/shape.
 *
 * The resolution-success path is proven WITHOUT launching: profiles carry
 * `harnessId: "no-such-harness"`, so a resolved request stops at the
 * `harness_disabled` 409 (which also proves `harnessUsable` saw the resolved
 * node id — see the online-agent case). One real 200 runs against a stub
 * harness (CLAUDE_PATH) and a real tmux socket, terminated in cleanup.
 */

const app = new Elysia().use(errorHandlerPlugin).use(subshellRoutes);

describe("POST /api/subshells node resolution (phase 2)", () => {
  const pw = "cnode-pass-1";
  const email = `cnode-${crypto.randomUUID()}@subshell.local`;
  const otherEmail = `cnode-o-${crypto.randomUUID()}@subshell.local`;
  let userId: string;
  let otherId: string;
  let cookie: string;
  const createdSubshellIds: string[] = [];
  const createdNodeIds: string[] = [];
  const createdProfileIds: string[] = [];
  const sockets = new Set<string>();
  let bogusProfileId: string;
  let claudeProfileId: string;
  const testDir = mkdtempSync(join(tmpdir(), "subshell-cnode-"));

  async function mkProfile(owner: string, harnessId: string, nodeId?: string): Promise<string> {
    const row = await new ProfilesRepository(db).create({
      id: crypto.randomUUID(),
      userId: owner,
      harnessId,
      name: `p-${crypto.randomUUID().slice(0, 8)}`,
      description: null,
      envJson: null,
      flagsJson: null,
      settingsJson: null,
      configIsolation: 0,
      nodeId: nodeId ?? null,
    });
    createdProfileIds.push(row.id);
    return row.id;
  }

  async function mkAgent(ownerUserId: string): Promise<string> {
    const id = crypto.randomUUID();
    createdNodeIds.push(id);
    await new NodesRepository(db).create({ id, ownerUserId, name: `cnode-${id}`, kind: "agent", status: "offline" });
    return id;
  }

  beforeAll(async () => {
    await setupAuthTables();
    await ensureLocalNode(db);
    userId = await new UsersRepository(db).createUser({ email, passwordHash: await hashPassword(pw), role: "user" });
    otherId = await new UsersRepository(db).createUser({
      email: otherEmail,
      passwordHash: await hashPassword(pw),
      role: "user",
    });
    cookie = await signIn(email, pw);
    bogusProfileId = await mkProfile(userId, "no-such-harness");
    claudeProfileId = await mkProfile(userId, "claude-code");
  });

  afterAll(async () => {
    resetNodeRegistryForTests();
    for (const id of createdSubshellIds) {
      await new SubshellsRepository(db).delete(id).catch(() => {});
    }
    for (const id of createdNodeIds) await new NodesRepository(db).deleteById(id);
    for (const id of createdProfileIds) await db.deleteFrom("profiles").where("id", "=", id).execute();
    await db.deleteFrom("recentPaths").where("userId", "=", userId).execute();
    // Reap any tmux server the 200-path spawned (same net the manager suite uses).
    for (const socket of sockets) {
      spawnSync(["tmux", "-L", socket, "kill-server"], { stdout: "ignore", stderr: "ignore" });
    }
    rmSync(testDir, { recursive: true, force: true });
    await deleteUserByEmailOrId(email);
    await deleteUserByEmailOrId(otherEmail);
  });

  function post(body: Record<string, unknown>, bearer?: string) {
    const headers = new Headers({ "content-type": "application/json" });
    if (bearer) headers.set("authorization", `Bearer ${bearer}`);
    else headers.set("cookie", `better-auth.session_token=${cookie}`);
    return app.fetch(
      new Request("http://localhost:3080/api/subshells", { method: "POST", headers, body: JSON.stringify(body) }),
    );
  }

  const base = (profileId: string) => ({ profileId, workingDir: "/tmp" });

  it("bogus profile + omitted nodeId → unchanged behavior (404 Profile not found)", async () => {
    const res = await post(base("no-such-profile"));
    expect(res.status).toBe(404);
    expect(((await res.json()) as { message: string }).message).toBe("Profile not found");
  });

  it("omitted nodeId → resolves to local (stops at harness_disabled, NOT a node error)", async () => {
    const res = await post(base(bogusProfileId));
    expect(res.status).toBe(409);
    const body = (await res.json()) as { code: string; message: string };
    expect(body.message).toBe("That harness is disabled on this machine");
  });

  it('nodeId "local" → same resolution as omitted', async () => {
    const res = await post({ ...base(bogusProfileId), nodeId: LOCAL_NODE_ID });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { message: string }).message).toBe("That harness is disabled on this machine");
  });

  it("unknown nodeId → 404 naming the node (not the profile)", async () => {
    const res = await post({ ...base(bogusProfileId), nodeId: crypto.randomUUID() });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { code: string; message: string };
    expect(body.code).toBe("NOT_FOUND_ERROR");
    expect(body.message).toMatch(/node/i);
  });

  it("foreign private node → 404 (invisible, never 403 — spec §2: no node-id existence oracle)", async () => {
    const node = await mkAgent(otherId);
    const res = await post({ ...base(bogusProfileId), nodeId: node });
    expect(res.status).toBe(404);
    expect(((await res.json()) as { message: string }).message).toMatch(/node/i);
  });

  it("own agent with no live connection → 409 NODE_OFFLINE", async () => {
    const node = await mkAgent(userId);
    const res = await post({ ...base(bogusProfileId), nodeId: node });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { code: string; statusCode: number };
    expect(body.code).toBe("NODE_OFFLINE");
    expect(body.statusCode).toBe(409);
  });

  it("harnessUsable sees the resolved node: an online agent with no inventory is NOT usable even though local has the binary", async () => {
    // CLAUDE_PATH makes claude-code installed ON LOCAL; the agent's inventory
    // was never reported → strict gate says no. If the local probe were used,
    // this would proceed to a real launch instead of the 409.
    const stub = join(testDir, "claude-stub");
    writeFileSync(stub, "#!/bin/sh\nexec sleep 300\n", { mode: 0o755 });
    const prev = process.env.CLAUDE_PATH;
    process.env.CLAUDE_PATH = stub;
    const nodeId = crypto.randomUUID();
    createdNodeIds.push(nodeId);
    await new NodesRepository(db).create({ id: nodeId, ownerUserId: userId, name: `cnode-${nodeId}`, kind: "agent" });
    const ws = { send: () => {}, close: () => {} };
    const conn = attachConnection(nodeId, ws);
    conn.agent = { dataDir: "/node-data", capabilities: ["mcp"], hostname: "h", agentVersion: "1.0.0" };
    try {
      // Requested explicitly: resolution passes the online gate, then the
      // per-node harness gate must reject it. A local-probe bug would fall
      // through to a real launch (200) instead of this 409. The AGENT copy
      // must name the node, not "this machine".
      const agentRes = await post({ ...base(claudeProfileId), nodeId });
      expect(agentRes.status).toBe(409);
      expect(((await agentRes.json()) as { message: string }).message).toBe(
        "That harness is disabled or not installed on that node",
      );
    } finally {
      // Detach the fake socket: a leaked "online" node would hijack the
      // later auto-pick cases. Restore CLAUDE_PATH here (not only in the
      // file-level afterAll) so no later-inserted case inherits the stub.
      detachConnection(nodeId, ws);
      if (prev === undefined) delete process.env.CLAUDE_PATH;
      else process.env.CLAUDE_PATH = prev;
    }
  });

  it('an agent node WITHOUT the "mcp" capability launches ENV-ONLY — no mcp registration on the wire (Task 13 gate)', async () => {
    // The capability gate (Task 9) + the agent-side MCP port (Task 13) land in
    // one commit, so this route-level test pins their handshake: a node that
    // advertises today's pre-13 capability set (`["uploads"]` — the exact list
    // the shipped `ready` frames carry) still gets a full launch, with the
    // SUBSHELL_* pane env present and NO `mcp` registration / config path on the
    // wire — `planRemoteSubshellMcp` was SKIPPED (control-side compose never ran;
    // the manager logged the debug note). The scripted agent socket answers the
    // real RemoteLauncher's RPCs (stat_dir + launch) by unwrapping each signed
    // envelope — decode-only, the uploads-remote.route pattern — and records
    // every command for the assertions.
    const nodeId = crypto.randomUUID();
    createdNodeIds.push(nodeId);
    const nodes = new NodesRepository(db);
    await nodes.create({ id: nodeId, ownerUserId: userId, name: `cnode-${nodeId}`, kind: "agent" });
    // Fresh inventory is what passes the strict agent launch gate for the
    // claude-code profile (CLAUDE_PATH / local probes are irrelevant here).
    await nodes.applyInventory(
      nodeId,
      JSON.stringify([{ harnessId: "claude-code", installed: true, binaryPath: "/usr/bin/claude" }]),
    );
    // And the instance has claude-code installed on disk (the suite's
    // setupAuthTables seeded the built-ins) — post-inversion, THAT plus the
    // fresh inventory is the whole gate; the node declares nothing.
    const cmds: NodeCommandBody[] = [];
    let conn: NodeConnection;
    const ws: NodeSocket = {
      send(data) {
        const frame = JSON.parse(String(data)) as { jws: string };
        const claims = JSON.parse(Buffer.from(frame.jws.split(".")[1] ?? "", "base64url").toString("utf8")) as {
          jti: string;
          cmd: NodeCommandBody;
        };
        cmds.push(claims.cmd);
        const result: Parameters<typeof resolveResult>[1] = { type: "result", ref: claims.jti, ok: true };
        if (claims.cmd.type === "stat_dir") {
          result.data = { path: claims.cmd.path, isDirectory: true };
        }
        resolveResult(conn, result);
        return 0;
      },
      close: () => {},
    };
    conn = attachConnection(nodeId, ws);
    conn.agent = {
      dataDir: "/node-data",
      capabilities: ["uploads"], // ← no "mcp": the pre-Task-13 agent, byte-for-byte
      hostname: "h",
      agentVersion: "1.0.0",
      mcpLaunch: { command: "/usr/bin/subshell", args: ["mcp"] },
    };
    try {
      const res = await post({ ...base(claudeProfileId), nodeId, name: "cnode-gate" });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { id: string };
      createdSubshellIds.push(body.id);

      const launch = cmds.find((c) => c.type === "launch") as
        | (Extract<NodeCommandBody, { type: "launch" }> & Record<string, unknown>)
        | undefined;
      expect(launch).toBeDefined();
      // Gate fired: the pure plan never ran, so no registration rides the wire.
      // The wire discriminator is `mcp` (path + content ship as `mcp.path` /
      // `mcp.fileContent` — remote-launcher.ts); `mcpConfigPath` is a
      // LaunchPlan-side name that is never a wire field, so asserting its
      // absence here would be vacuous. The positive wire shape (mcp.path under
      // the node's dataDir) is pinned by `subshells-remote.integration.test.ts`.
      expect(launch?.mcp).toBeUndefined();
      expect(launch?.mcp?.path).toBeUndefined();
      // Env-only: the SUBSHELL_* contract is shipped regardless — harnesses without
      // a registration file still reach subshell (manual setup), and the identity/
      // pin stores of the ported MCP server key off these values.
      const subshellEnv = launch?.subshellEnv as Record<string, string>;
      expect(subshellEnv.SUBSHELL_API_KEY).toBeTruthy();
      expect(subshellEnv.SUBSHELL_ID).toBe(body.id);
      expect(subshellEnv.SUBSHELL_BASE_URL).toBeTruthy();
      // The node's own dataDir wins over the backend's SUBSHELL_SERVER_DATA_DIR (Task 9)
      // — where the ported identity-store/pin-store write under SUBSHELL_DATA_DIR.
      expect(subshellEnv.SUBSHELL_DATA_DIR).toBe("/node-data");

      // Write-site per-node scoping: the recent-path touch that follows a
      // successful launch must carry the RESOLVED node, not silently default
      // to local — the remote machine's /tmp is not the control plane's /tmp.
      const recentRows = await db
        .selectFrom("recentPaths")
        .select(["path", "nodeId", "label"])
        .where("userId", "=", userId)
        .where("path", "=", "/tmp")
        .execute();
      expect(recentRows).toContainEqual({ path: "/tmp", nodeId, label: "cnode-gate" });
    } finally {
      detachConnection(nodeId, ws);
    }
  });

  it("a pin that cannot launch errors with the pin message — never silently relocates", async () => {
    const offlineAgent = await mkAgent(userId);
    const pinned = await mkProfile(userId, "no-such-harness", offlineAgent);
    const res = await post(base(pinned));
    expect(res.status).toBe(409);
    const body = (await res.json()) as { code: string; message: string };
    expect(body.code).toBe("NODE_OFFLINE");
    expect(body.message).toContain("pinned");
  });

  it("SECURITY (leaked harness keys can't spawn control-plane subshells): a regular user's bearer token gets 400 NODE_REQUIRED even with local's Everyone grant present", async () => {
    const sid = `s_cnode_tok_${crypto.randomUUID().slice(0, 8)}`;
    await new SubshellsRepository(db).create({
      id: sid,
      userId,
      profileId: bogusProfileId,
      harnessId: "claude-code",
      name: "token-source",
      workingDir: "/tmp",
      tmuxSocket: null,
    });
    createdSubshellIds.push(sid);
    const key = await issueSubshellToken(sid, userId);
    const res = await post(base(bogusProfileId), key);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("NODE_REQUIRED");
    // The source subshell is terminated cleanly so its token retires.
    await app.fetch(
      new Request(`http://localhost:3080/api/subshells/${sid}/terminate`, {
        method: "POST",
        headers: { cookie: `better-auth.session_token=${cookie}` },
      }),
    );
  });

  it("the system key still resolves local (it OWNS the local row — the strict rule targets foreign bearer actors only)", async () => {
    const systemId = await ensureSystemUser();
    // The bearer acts AS its owning user, so the profile must be the system
    // user's (a foreign profile 404s before node resolution — correct, and
    // not what this test is about).
    const systemProfile = await mkProfile(systemId, "no-such-harness");
    const created = (await getAuth().api.createApiKey({
      body: { name: "cnode-sys", userId: systemId, metadata: { kind: "system" } },
    })) as unknown as { id: string; key: string };
    const res = await post(base(systemProfile), created.key);
    expect(res.status).toBe(409); // resolution PASSED (local) — stops at the bogus harness
    expect(((await res.json()) as { message: string }).message).toBe("That harness is disabled on this machine");
  });

  it("200 happy path: cookie actor, local, stubbed harness → real launch, unchanged response shape, row + view carry nodeId/nodeOffline", async () => {
    const stub = join(testDir, "claude-stub2");
    writeFileSync(stub, "#!/bin/sh\nexec sleep 300\n", { mode: 0o755 });
    const prev = process.env.CLAUDE_PATH;
    process.env.CLAUDE_PATH = stub;
    try {
      const res = await post({ ...base(claudeProfileId), name: "cnode-200" });
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(Object.keys(body).sort()).toEqual(["id", "promptDelivered", "tmuxSocket"]);
      expect(body.promptDelivered).toBe(false);
      const id = body.id as string;
      createdSubshellIds.push(id);
      sockets.add(body.tmuxSocket as string);

      const row = await new SubshellsRepository(db).findById(id);
      expect(row?.nodeId).toBe(LOCAL_NODE_ID);

      // The local launch touches the LOCAL recent-path scope — byte-identical
      // to the pre-nodes behavior for a local subshell.
      const recentRow = await db
        .selectFrom("recentPaths")
        .select(["nodeId", "label"])
        .where("userId", "=", userId)
        .where("path", "=", "/tmp")
        .where("nodeId", "=", LOCAL_NODE_ID)
        .executeTakeFirst();
      expect(recentRow).toEqual({ nodeId: LOCAL_NODE_ID, label: "cnode-200" });

      const get = await app.fetch(
        new Request(`http://localhost:3080/api/subshells/${id}`, {
          headers: { cookie: `better-auth.session_token=${cookie}` },
        }),
      );
      expect(get.status).toBe(200);
      const view = (await get.json()) as { nodeId: string; nodeOffline: boolean };
      expect(view.nodeId).toBe(LOCAL_NODE_ID);
      expect(view.nodeOffline).toBe(false);

      await app.fetch(
        new Request(`http://localhost:3080/api/subshells/${id}/terminate`, {
          method: "POST",
          headers: { cookie: `better-auth.session_token=${cookie}` },
        }),
      );
    } finally {
      if (prev === undefined) delete process.env.CLAUDE_PATH;
      else process.env.CLAUDE_PATH = prev;
    }
  });

  it("GET /api/subshells/:id echoes nodeId (row default is 'local')", async () => {
    const id = `s_cnode_${crypto.randomUUID().slice(0, 8)}`;
    await new SubshellsRepository(db).create({
      id,
      userId,
      profileId: "p",
      harnessId: "claude-code",
      name: "cnode-view",
      workingDir: "/tmp",
      tmuxSocket: null,
    });
    createdSubshellIds.push(id);
    const res = await app.fetch(
      new Request(`http://localhost:3080/api/subshells/${id}`, {
        headers: { cookie: `better-auth.session_token=${cookie}` },
      }),
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as { nodeId: string }).nodeId).toBe("local");
  });
});

describe("POST /api/subshells/:id/restart onto an offline node (spec §5.6)", () => {
  const pw = "conode-pass-1";
  const email = `conode-${crypto.randomUUID()}@subshell.local`;
  let userId: string;
  let cookie: string;
  const createdNodeIds: string[] = [];

  beforeAll(async () => {
    await setupAuthTables();
    await ensureLocalNode(db);
    userId = await new UsersRepository(db).createUser({ email, passwordHash: await hashPassword(pw), role: "user" });
    cookie = await signIn(email, pw);
  });

  afterAll(async () => {
    resetNodeRegistryForTests();
    for (const id of createdNodeIds) await new NodesRepository(db).deleteById(id);
    await db.deleteFrom("subshells").where("userId", "=", userId).execute();
    await db.deleteFrom("profiles").where("userId", "=", userId).execute();
    await deleteUserByEmailOrId(email);
  });

  it("manual restart on an agent row with no live conn → 409 NODE_OFFLINE, row rolled back, view says nodeOffline", async () => {
    const nodeId = crypto.randomUUID();
    createdNodeIds.push(nodeId);
    await new NodesRepository(db).create({ id: nodeId, ownerUserId: userId, name: `conode-${nodeId}`, kind: "agent" });
    const profile = await new ProfilesRepository(db).create({
      id: crypto.randomUUID(),
      userId,
      harnessId: "claude-code",
      name: "conode-p",
      description: null,
      envJson: null,
      flagsJson: null,
      settingsJson: null,
      configIsolation: 0,
      nodeId,
    });
    const id = `s_conode_${crypto.randomUUID().slice(0, 8)}`;
    // Parked shape (what a crashed auto-restart row looks like) — the restart
    // takes the kill-skip path and fails inside the revive.
    await new SubshellsRepository(db).create({
      id,
      userId,
      profileId: profile.id,
      harnessId: "claude-code",
      name: "conode-row",
      workingDir: "/tmp",
      tmuxSocket: `conode-sock-${id}`,
      nodeId,
      alive: 0,
      status: "running",
    });

    const res = await app.fetch(
      new Request(`http://localhost:3080/api/subshells/${id}/restart`, {
        method: "POST",
        headers: { cookie: `better-auth.session_token=${cookie}` },
      }),
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as { code: string; statusCode: number };
    expect(body.code).toBe("NODE_OFFLINE");
    expect(body.statusCode).toBe(409);

    // Rollback shape unchanged: the parked row is terminated again (same as
    // the existing spawn-failure rollback tests pin for local rows).
    const row = await new SubshellsRepository(db).findById(id);
    expect(row?.status).toBe("terminated");

    const get = await app.fetch(
      new Request(`http://localhost:3080/api/subshells/${id}`, {
        headers: { cookie: `better-auth.session_token=${cookie}` },
      }),
    );
    expect(get.status).toBe(200);
    expect(((await get.json()) as { nodeOffline: boolean }).nodeOffline).toBe(true);
  });
});
