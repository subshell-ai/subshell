import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { builtInIds, listInstalled, pluginsDir } from "@internal/pane-runtime";
import { hashPassword } from "better-auth/crypto";
import { HarnessStateError } from "@/api/harness-utils.js";
import { SUBSHELL_SERVER_DATA_DIR } from "@/constants.js";
import { db } from "@/db/index.js";
import { NodesRepository } from "@/db/repositories/nodes.repository.js";
import { UsersRepository } from "@/db/repositories/users.repository.js";
import { LOCAL_NODE_ID, type NodeTable } from "@/db/types/nodes.db-types.js";
import { uninstallLocalPlugin } from "@/services/nodes/local-plugins.js";
import {
  attachConnection,
  getLive,
  type NodeSocket,
  resetNodeRegistryForTests,
} from "@/services/nodes/node-registry.js";
import { resolveResult } from "@/services/nodes/node-rpc.js";
import { installNodePlugin } from "@/services/nodes/plugin-sync.js";
import { ensureLocalNode } from "@/services/nodes/seed-local.js";
import { deleteUserByEmailOrId, setupAuthTables } from "../../../api/__tests__/helpers/auth-tables.js";
import { type FakeRegistry, makePluginTgz, startFakeRegistry } from "./helpers/fake-npm-registry.js";

/**
 * The spec passthrough at the service seam (phase 3): `installNodePlugin`
 * with and without a `spec`.
 *
 * The agent path is driven with a scripted node — the same fake-socket idiom
 * the route tests use — so the assertion lands on the CAPTURED command object:
 * absent means the v1 shape with no `spec` key at all, present means the
 * string forwarded verbatim (this layer must not normalize, re-parse, or
 * otherwise rewrite what the node will parse). The local path is driven
 * against the in-test fake registry: a spec that fails integrity must reach
 * the caller as a 409 carrying the pane-runtime message, never a bare Error
 * the global handler dresses up as a 500.
 */

const nodes = new NodesRepository(db);

function fakeSocket(): NodeSocket & { sent: string[] } {
  return {
    sent: [],
    send(data: string) {
      this.sent.push(data);
      return data.length;
    },
    close() {},
  };
}

async function waitFor(cond: () => boolean, what: string, budgetMs = 2000): Promise<void> {
  for (let waited = 0; ; waited += 5) {
    if (cond()) return;
    if (waited > budgetMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** The command claims inside the first frame the fake node saw. */
function capturedCmd(sock: { sent: string[] }): { jti: string; cmd: Record<string, unknown> } {
  const frame = JSON.parse(String(sock.sent[0])) as { jws: string };
  return JSON.parse(Buffer.from(frame.jws.split(".")[1], "base64url").toString("utf8")) as {
    jti: string;
    cmd: Record<string, unknown>;
  };
}

describe("installNodePlugin spec passthrough", () => {
  let localRow: NodeTable;
  let agentRow: NodeTable;
  let userId: string;
  const email = `pspec-${crypto.randomUUID()}@subshell.local`;
  const agentId = crypto.randomUUID();
  const reg: FakeRegistry = startFakeRegistry();

  beforeAll(async () => {
    await setupAuthTables();
    userId = await new UsersRepository(db).createUser({
      email,
      passwordHash: await hashPassword("pspec-1"),
      role: "user",
    });
    await ensureLocalNode(db);
    const host = await nodes.findById(LOCAL_NODE_ID);
    if (!host) throw new Error("the local node row must exist");
    localRow = host;

    await nodes.create({
      id: agentId,
      ownerUserId: userId,
      name: `pspec-${agentId.slice(0, 8)}`,
      kind: "agent",
      status: "offline",
    });
    const agent = await nodes.findById(agentId);
    if (!agent) throw new Error("the agent node row must exist");
    agentRow = agent;

    reg.served.set("third-party", {
      latest: "1.0.0",
      versions: { "1.0.0": makePluginTgz({ name: "third-party", version: "1.0.0", id: "third" }) },
    });
    reg.served.set("tampered", {
      latest: "1.0.0",
      tamper: true,
      versions: { "1.0.0": makePluginTgz({ name: "tampered", version: "1.0.0", id: "tampered" }) },
    });
  });

  afterAll(async () => {
    resetNodeRegistryForTests();
    reg.stop();
    // A registry-installed plugin seeds Default profiles for every real user;
    // the unremovable-flag guard lives in the DELETE route, so the sweep here
    // goes straight at the table. (Only `third` was ever installed: the
    // malformed-spec and integrity cases refuse before anything is seeded.)
    await db.deleteFrom("profiles").where("harnessId", "=", "third").execute();
    await nodes.deleteById(agentId);
    await deleteUserByEmailOrId(email);
  });

  it("forwards a present spec to the agent VERBATIM in the signed command", async () => {
    const sock = fakeSocket();
    attachConnection(agentId, sock);
    try {
      const done = installNodePlugin(agentRow, "third", "third-party@1.0.0");
      await waitFor(() => sock.sent.length > 0, "plugin_install on the wire");
      const claims = capturedCmd(sock);
      expect(claims.cmd).toEqual({ type: "plugin_install", id: "third", spec: "third-party@1.0.0" });
      const conn = getLive(agentId);
      if (!conn) throw new Error("connection must be live");
      resolveResult(conn, {
        type: "result",
        ref: claims.jti,
        ok: true,
        data: {
          plugins: [
            { id: "third", name: "third", type: "agent-harness", version: "1.0.0", description: "", capabilities: [] },
          ],
        },
      });
      await done;
      const mirrored = JSON.parse(String((await nodes.findById(agentId))?.pluginsJson ?? "[]")) as { id: string }[];
      expect(mirrored.map((p) => p.id)).toEqual(["third"]);
    } finally {
      resetNodeRegistryForTests();
    }
  });

  it("a spec-less install still sends the v1 shape, with no spec key at all", async () => {
    const sock = fakeSocket();
    attachConnection(agentId, sock);
    try {
      const done = installNodePlugin(agentRow, "claude-code");
      await waitFor(() => sock.sent.length > 0, "plugin_install on the wire");
      const claims = capturedCmd(sock);
      expect(claims.cmd).toEqual({ type: "plugin_install", id: "claude-code" });
      expect("spec" in claims.cmd).toBe(false);
      const conn = getLive(agentId);
      if (!conn) throw new Error("connection must be live");
      resolveResult(conn, { type: "result", ref: claims.jti, ok: true, data: { plugins: [] } });
      await done;
    } finally {
      resetNodeRegistryForTests();
    }
  });

  it("a malformed spec is a 400 naming it, before any command reaches the node", async () => {
    const sock = fakeSocket();
    attachConnection(agentId, sock);
    try {
      const err = await installNodePlugin(agentRow, "third", "bad@^1").catch((e: unknown) => e);
      expect(err).toBeInstanceOf(HarnessStateError);
      expect((err as HarnessStateError).status).toBe(400);
      expect((err as Error).message).toContain("^1");
      // Validated FIRST: a malformed spec must never spend a signed command.
      expect(sock.sent).toEqual([]);
    } finally {
      resetNodeRegistryForTests();
    }
  });

  it("the spec-absent built-in pre-check still answers 400 on the control-plane host", async () => {
    const err = await installNodePlugin(localRow, "nope-not-carried").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HarnessStateError);
    expect((err as HarnessStateError).status).toBe(400);
    expect((err as Error).message).toMatch(/not a plugin this build carries/);
    // The refusal was the pre-check, not an accident of the id list.
    expect(await builtInIds()).not.toContain("nope-not-carried");
  });

  it("a malformed spec is a 400 on the local path too", async () => {
    const err = await installNodePlugin(localRow, "codex", "bad@^1").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HarnessStateError);
    expect((err as HarnessStateError).status).toBe(400);
    expect((err as Error).message).toContain("^1");
  });

  it("a local registry install succeeds through the same door and mirrors", async () => {
    const before = String((await nodes.findById(LOCAL_NODE_ID))?.pluginsJson ?? "[]");
    expect(before).not.toContain("third");

    await installNodePlugin(localRow, "third", "third-party@1.0.0", reg.base);

    expect((await listInstalled(SUBSHELL_SERVER_DATA_DIR)).map((p) => p.id)).toContain("third");
    const mirrored = JSON.parse(String((await nodes.findById(LOCAL_NODE_ID))?.pluginsJson ?? "[]")) as {
      id: string;
    }[];
    expect(mirrored.map((p) => p.id)).toContain("third");

    // Put the host back: the data dir is shared by every later file's suite.
    expect(await uninstallLocalPlugin("third")).toBe(true);
    expect(existsSync(join(pluginsDir(SUBSHELL_SERVER_DATA_DIR), "third"))).toBe(false);
  });

  it("a local integrity failure maps to 409 with the package's message, not a bare 500", async () => {
    const before = String((await nodes.findById(LOCAL_NODE_ID))?.pluginsJson ?? "[]");

    const err = await installNodePlugin(localRow, "tampered", "tampered@1.0.0", reg.base).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HarnessStateError);
    expect((err as HarnessStateError).status).toBe(409);
    expect((err as Error).message).toMatch(/integrity/i);

    // Nothing moved: no bytes on disk, mirror exactly as found.
    expect(existsSync(join(pluginsDir(SUBSHELL_SERVER_DATA_DIR), "tampered"))).toBe(false);
    expect(String((await nodes.findById(LOCAL_NODE_ID))?.pluginsJson ?? "[]")).toBe(before);
  });
});
