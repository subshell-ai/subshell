import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { NodeCommandBody } from "@internal/subshell-protocol";
import { NODE_RESULT_MAINTENANCE } from "@internal/subshell-protocol";
import { hashPassword } from "better-auth/crypto";
import { Elysia } from "elysia";
import { subshellRoutes } from "@/api/subshells/index.js";
import { db } from "@/db/index.js";
import { NodesRepository } from "@/db/repositories/nodes.repository.js";
import { PresetsRepository } from "@/db/repositories/presets.repository.js";
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
import { deleteUserByEmailOrId, setupAuthTables, signIn } from "../../__tests__/helpers/auth-tables.js";

/**
 * Maintenance at the HTTP surface (spec 2026-09-14 §7).
 *
 * Two refusals reach a caller, and they come from different places:
 *
 * - the plane's own gate, from the node row, on create AND on restart —
 *   restart never touches `resolveLaunchNode`, so without its own check it
 *   would be the one way to start a pane on a machine refusing them, and on
 *   `local` it is the ONLY gate that exists (there is no agent, so no file);
 * - the MACHINE's refusal, mapped, for the window where the node knows first —
 *   somebody ran `subshell maintenance on` at the keyboard and the agent's
 *   event has not converged the row yet. That used to be a 500, which reads
 *   as a broken server rather than as the setting somebody just changed.
 */

const app = new Elysia().use(errorHandlerPlugin).use(subshellRoutes);
const nodes = new NodesRepository(db);
const subshells = new SubshellsRepository(db);

describe("maintenance refusals on /api/subshells", () => {
  const pw = "maintroute-pass-1";
  const email = `maintroute-${crypto.randomUUID()}@subshell.local`;
  let userId: string;
  let cookie: string;
  let presetId: string;
  const nodeIds: string[] = [];
  const subshellIds: string[] = [];

  /** An agent node this user owns, with fresh inventory so the harness gate cannot answer first. */
  async function mkNode(maintenance: boolean): Promise<string> {
    const id = crypto.randomUUID();
    nodeIds.push(id);
    await nodes.create({ id, ownerUserId: userId, name: `mr-${id.slice(0, 8)}`, kind: "agent" });
    await nodes.applyInventory(
      id,
      JSON.stringify([{ harnessId: "claude-code", installed: true, binaryPath: "/usr/bin/claude" }]),
    );
    if (maintenance) {
      await nodes.setMaintenance(id, { on: true, changedAt: new Date().toISOString(), source: "plane" });
    }
    return id;
  }

  /** A running row on `nodeId`, owned by the signed-in user. */
  async function mkSubshell(nodeId: string): Promise<string> {
    const id = crypto.randomUUID();
    subshellIds.push(id);
    await subshells.create({
      id,
      userId,
      presetId,
      harnessId: "claude-code",
      name: `mr-${id.slice(0, 8)}`,
      workingDir: "/tmp",
      tmuxSocket: `mr-sock-${id}`,
      nodeId,
      alive: 0,
    });
    return id;
  }

  /**
   * A scripted agent socket that answers the real RemoteLauncher's RPCs by
   * unwrapping each signed envelope (decode-only, the `subshells-create-nodeid`
   * pattern). `launch` is REFUSED with the bare wire constant — exactly what
   * an agent whose own file says "in maintenance" sends.
   */
  function refusingNode(nodeId: string): () => void {
    let conn: NodeConnection;
    const ws: NodeSocket = {
      send(data) {
        const frame = JSON.parse(String(data)) as { jws: string };
        const claims = JSON.parse(Buffer.from(frame.jws.split(".")[1] ?? "", "base64url").toString("utf8")) as {
          jti: string;
          cmd: NodeCommandBody;
        };
        const result: Parameters<typeof resolveResult>[1] =
          claims.cmd.type === "launch"
            ? { type: "result", ref: claims.jti, ok: false, error: NODE_RESULT_MAINTENANCE }
            : { type: "result", ref: claims.jti, ok: true };
        if (claims.cmd.type === "stat_dir") {
          (result as { data?: unknown }).data = { path: claims.cmd.path, isDirectory: true };
        }
        resolveResult(conn, result);
        return 0;
      },
      close: () => {},
    };
    conn = attachConnection(nodeId, ws);
    conn.agent = {
      dataDir: "/node-data",
      capabilities: ["uploads"],
      hostname: "mr",
      agentVersion: "1.0.0",
      selfInvoke: { command: "/usr/bin/subshell", args: [] },
    };
    return () => detachConnection(nodeId, ws);
  }

  async function post(path: string, body?: unknown): Promise<Response> {
    return app.fetch(
      new Request(`http://localhost:3080${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie: `better-auth.session_token=${cookie}` },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
  }

  const bodyOf = async (res: Response) => (await res.json()) as { code: string; message: string };

  beforeAll(async () => {
    await setupAuthTables();
    resetNodeRegistryForTests();
    userId = await new UsersRepository(db).createUser({
      email,
      name: email,
      passwordHash: await hashPassword(pw),
      role: "user",
    });
    cookie = await signIn(email, pw);
    await ensureLocalNode(db);
    const preset = await new PresetsRepository(db).create({
      id: crypto.randomUUID(),
      userId,
      harnessId: "claude-code",
      name: `mr-${crypto.randomUUID().slice(0, 8)}`,
      description: null,
      envJson: null,
      flagsJson: null,
      settingsJson: null,
      configIsolation: 0,
    });
    presetId = preset.id;
  });

  afterAll(async () => {
    resetNodeRegistryForTests();
    for (const id of subshellIds) await db.deleteFrom("subshells").where("id", "=", id).execute();
    for (const id of nodeIds) await nodes.deleteById(id);
    await db.deleteFrom("presets").where("id", "=", presetId).execute();
    await deleteUserByEmailOrId(email);
  });

  it("create naming a node in maintenance → 409 NODE_IN_MAINTENANCE, for its own owner", async () => {
    const nodeId = await mkNode(true);
    const res = await post("/api/subshells", { harnessId: "claude-code", presetId, workingDir: "/tmp", nodeId });
    expect(res.status).toBe(409);
    expect((await bodyOf(res)).code).toBe("NODE_IN_MAINTENANCE");
  });

  it("restart of a subshell whose node is in maintenance → 409, never a relaunch", async () => {
    const nodeId = await mkNode(true);
    const id = await mkSubshell(nodeId);
    const res = await post(`/api/subshells/${id}/restart`);
    expect(res.status).toBe(409);
    expect((await bodyOf(res)).code).toBe("NODE_IN_MAINTENANCE");
  });

  it("the restart refusal names no node, because this caller may not be able to see one", async () => {
    // Subshell shares and node shares are independent axes: an `edit` grantee
    // on somebody else's subshell reaches this line holding no access at all
    // to the machine it runs on. Every other refusal on the restart path is
    // name-free for that reason, and the NAMED variant lives in
    // `resolveLaunchNode`, which sits behind a visibility 404.
    const nodeId = await mkNode(true);
    const id = await mkSubshell(nodeId);
    const name = (await nodes.findById(nodeId))?.name ?? "";
    const { message } = await bodyOf(await post(`/api/subshells/${id}/restart`));
    expect(name).not.toBe("");
    expect(message).not.toContain(name);
    expect(message).toBe("That node is in maintenance and is accepting no new subshells");
  });

  it("restart on `local` in maintenance → 409, the ONLY gate there is", async () => {
    // The control-plane host has no agent and therefore no fail-closed file
    // to refuse a second time. If this check were missing, restart would
    // start a pane on a host whose own switch says it takes no work.
    const before = await nodes.findById(LOCAL_NODE_ID);
    await nodes.setMaintenance(LOCAL_NODE_ID, {
      on: true,
      changedAt: new Date().toISOString(),
      source: "plane",
    });
    try {
      const id = await mkSubshell(LOCAL_NODE_ID);
      const res = await post(`/api/subshells/${id}/restart`);
      expect(res.status).toBe(409);
      expect((await bodyOf(res)).code).toBe("NODE_IN_MAINTENANCE");
    } finally {
      await nodes.setMaintenance(LOCAL_NODE_ID, {
        on: before?.maintenance === 1,
        changedAt: before?.maintenanceAt ?? new Date().toISOString(),
        source: "plane",
      });
    }
  });

  it("a node that knows FIRST answers 409, not the 500 an unmapped refusal used to be", async () => {
    // The plane's row says nothing is wrong — somebody flipped it at the
    // keyboard and the agent's `maintenance` event has not landed yet. The
    // agent refuses the launch with the bare wire constant, compared by
    // EQUALITY against `NodeRpcError.detail`.
    const nodeId = await mkNode(false);
    const off = refusingNode(nodeId);
    try {
      const res = await post("/api/subshells", { harnessId: "claude-code", presetId, workingDir: "/tmp", nodeId });
      expect(res.status).toBe(409);
      expect((await bodyOf(res)).code).toBe("NODE_IN_MAINTENANCE");
    } finally {
      off();
    }
  });

  it("an unrelated node failure is still an unrelated node failure", async () => {
    // The mapping is one exact string, not "any refusal from a node": a
    // launch that fails for another reason must not be reported to the
    // operator as a maintenance window somebody opened.
    const nodeId = await mkNode(false);
    let conn: NodeConnection;
    const ws: NodeSocket = {
      send(data) {
        const frame = JSON.parse(String(data)) as { jws: string };
        const claims = JSON.parse(Buffer.from(frame.jws.split(".")[1] ?? "", "base64url").toString("utf8")) as {
          jti: string;
          cmd: NodeCommandBody;
        };
        const result: Parameters<typeof resolveResult>[1] =
          claims.cmd.type === "launch"
            ? { type: "result", ref: claims.jti, ok: false, error: "tmux: no server running" }
            : { type: "result", ref: claims.jti, ok: true };
        if (claims.cmd.type === "stat_dir") {
          (result as { data?: unknown }).data = { path: claims.cmd.path, isDirectory: true };
        }
        resolveResult(conn, result);
        return 0;
      },
      close: () => {},
    };
    conn = attachConnection(nodeId, ws);
    conn.agent = {
      dataDir: "/node-data",
      capabilities: ["uploads"],
      hostname: "mr",
      agentVersion: "1.0.0",
      selfInvoke: { command: "/usr/bin/subshell", args: [] },
    };
    try {
      const res = await post("/api/subshells", { harnessId: "claude-code", presetId, workingDir: "/tmp", nodeId });
      expect((await bodyOf(res)).code).not.toBe("NODE_IN_MAINTENANCE");
    } finally {
      detachConnection(nodeId, ws);
    }
  });

  it("stops answering maintenance the moment the window ends", async () => {
    const nodeId = await mkNode(true);
    await nodes.setMaintenance(nodeId, { on: false, changedAt: new Date().toISOString(), source: "plane" });
    // No socket attached, so the gate runs on past the flag to the liveness
    // check — the positive form of "the window is over". A window is NOT a
    // permanent state the row carries once it has been entered.
    const res = await post("/api/subshells", { harnessId: "claude-code", presetId, workingDir: "/tmp", nodeId });
    expect((await bodyOf(res)).code).toBe("NODE_OFFLINE");
  });
});
