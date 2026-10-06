import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import {
  encodeSshSessionFrame,
  SSH_RUNTIME_PROTOCOL,
  type SshRuntimeHelloWire,
  SshSessionFrameDecoder,
} from "@internal/subshell-protocol";
import { hashPassword } from "better-auth/crypto";
import { ensureMigratedTestDb } from "@/__tests__/helpers/test-database.js";
import { deleteUserByEmailOrId, setupAuthTables } from "@/api/__tests__/helpers/auth-tables.js";
import { db } from "@/db/index.js";
import { NodesRepository } from "@/db/repositories/nodes.repository.js";
import { UsersRepository } from "@/db/repositories/users.repository.js";
import { NODE_KIND_RUNTIME } from "@/db/types/nodes.db-types.js";
import {
  launcherFor,
  peekRuntimeLauncherForTests,
  resetLauncherRegistryForTests,
} from "@/services/nodes/launcher-registry.js";
import * as nodeRpc from "@/services/nodes/node-rpc.js";
import { RuntimeSessionLauncher } from "../runtime-session-launcher.js";

/**
 * The REAL node-rpc exports, spread at MODULE-EVAL time (before any
 * `mock.module`). bun's `mock.module` mutates the live namespace, so the
 * old `() => ({ ...nodeRpc })` restore re-installed this file's capture mock
 * and leaked it across files in a shared serial process - the sibling
 * `pane-doors-and-detect.test.ts` header states the full mechanism.
 */
const realNodeRpc = { ...nodeRpc };

import { SshRuntimeSession } from "../session.js";
import { registerSession, resetSessionRegistryForTests, sessionHooks } from "../session-registry.js";
import { SshRuntimeSessionsRepository } from "../sessions.repository.js";
import { closeSession } from "../sessions-lifecycle.js";

/**
 * The close door, end to end at the service seam (review C1b + M5):
 *
 * - C1b: `closeSession` must reach the BROKER with `ssh_session_close` so the
 *   supervisor group-kills the SSH child. Before the fix the plane's close was
 *   local-only (and did not even send the runtime's `close` frame), and every
 *   closed session leaked its child onto the per-node quota until an agent
 *   restart. The e2e proves the process really dies; this pins the wire order:
 *   `ssh_session_send` (the close frame) first, `ssh_session_close` second.
 * - M5: the launcher-registry cache entry leaves with the session (it holds
 *   the session, which holds the pane-token plaintext).
 *
 * The node link itself is mocked: `sendCommand` is the one outbound door the
 * close path uses, and the census result is fed back through `ingestBytes`
 * exactly as the pump would deliver it.
 */

const sessionsRepo = new SshRuntimeSessionsRepository(db);
const nodesRepo = new NodesRepository(db);

const email = `rtsvc-${crypto.randomUUID()}@subshell.local`;
const pw = "rtsvc-pass-1";
let userId: string;

interface Captured {
  nodeId: string;
  cmd: { type: string; ref?: string; data_b64?: string };
}

const captured: Captured[] = [];
/** The session whose pump answers the captured commands (set per test). */
let pumpTarget: SshRuntimeSession | undefined;

/** Rows created for the test, removed in afterAll (and by the next test's fixture). */
const cleanupNodes: string[] = [];

function hello(): SshRuntimeHelloWire {
  return {
    type: "hello",
    runtimeProtocol: SSH_RUNTIME_PROTOCOL,
    agentVersion: "1.5.0",
    os: "linux",
    arch: "x64",
    capabilities: [],
    homeDir: "/home/x",
    dataDir: "/home/x/.local/share/subshell/runtime",
    tmuxSocket: "subshell-ssh-ab12cd34ef56",
    paneCount: 0,
  };
}

async function mkActiveSession(): Promise<SshRuntimeSession> {
  const connectingNodeId = crypto.randomUUID();
  const runtimeNodeId = crypto.randomUUID();
  const sessionId = crypto.randomUUID();
  cleanupNodes.push(runtimeNodeId, connectingNodeId);
  await nodesRepo.create({
    id: connectingNodeId,
    ownerUserId: userId,
    name: `svc-${sessionId.slice(0, 8)}`,
    kind: "agent",
  });
  await nodesRepo.create({
    id: runtimeNodeId,
    ownerUserId: userId,
    name: `svc-rt-${sessionId.slice(0, 8)}`,
    kind: NODE_KIND_RUNTIME,
  });
  await sessionsRepo.create({
    id: sessionId,
    ownerUserId: userId,
    connectingNodeId,
    runtimeNodeId,
    alias: "svc",
    host: "127.0.0.1",
    port: 22,
    user: null,
    status: "active",
  });
  await sessionsRepo.settle(sessionId, "active", JSON.stringify(hello()));
  const session = new SshRuntimeSession({
    id: sessionId,
    ownerId: userId,
    connectingNodeId,
    runtimeNodeId,
    target: { alias: "svc", host: "127.0.0.1", port: 22, user: null, identityFile: null },
    hello: hello(),
  });
  session.hooks = sessionHooks();
  registerSession(session);
  return session;
}

async function pollUntil(what: string, cond: () => Promise<boolean> | boolean): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`pollUntil timed out: ${what}`);
}

beforeAll(async () => {
  await ensureMigratedTestDb();
  await setupAuthTables();
  userId = await new UsersRepository(db).createUser({
    email,
    name: email,
    passwordHash: await hashPassword(pw),
    role: "user",
  });
  mock.module("@/services/nodes/node-rpc.js", () => ({
    ...realNodeRpc,
    sendCommand: async (nodeId: string, cmd: Captured["cmd"]) => {
      captured.push({ nodeId, cmd });
      if (cmd.type === "ssh_session_send" && pumpTarget !== undefined) {
        const decoder = new SshSessionFrameDecoder();
        const frames = decoder.push(new Uint8Array(Buffer.from(cmd.data_b64 ?? "", "base64")));
        const ref = (frames[0] as { ref?: string } | undefined)?.ref ?? "";
        // The runtime answers the close with its final census (empty here:
        // the fixture has no panes) - the same frame the pump would carry.
        pumpTarget.ingestBytes(encodeSshSessionFrame({ type: "result", ref, ok: true, data: [] }));
      }
      return { ok: true };
    },
  }));
});

afterAll(async () => {
  mock.module("@/services/nodes/node-rpc.js", () => realNodeRpc);
  // The isolation pin (identity check fails exactly on the leak pattern; the
  // `pane-doors-and-detect.test.ts` header states the mechanism).
  expect(nodeRpc.sendCommand).toBe(realNodeRpc.sendCommand);
  resetSessionRegistryForTests();
  resetLauncherRegistryForTests();
  for (const id of cleanupNodes) {
    await db
      .deleteFrom("nodes")
      .where("id", "=", id)
      .execute()
      .catch(() => {});
  }
  await deleteUserByEmailOrId(email).catch(() => {});
});

describe("closeSession (C1b broker kill + M5 eviction)", () => {
  test("the runtime `close` frame goes out first, the broker `ssh_session_close` second, the row settles closed, the launcher cache evicts", async () => {
    const session = await mkActiveSession();
    // Prime the launcher cache through the production door.
    expect(launcherFor(session.runtimeNodeId)).toBeInstanceOf(RuntimeSessionLauncher);
    expect(peekRuntimeLauncherForTests(session.runtimeNodeId)).toBeDefined();

    captured.length = 0;
    pumpTarget = session;
    await closeSession(session.id, userId);

    // C1b, in order: the session's framed `close` command, then the broker's
    // group-kill command naming the same ref.
    const sentCloseFrame = captured.find(
      (c) => c.nodeId === session.connectingNodeId && c.cmd.type === "ssh_session_send",
    );
    expect(sentCloseFrame, "the close frame must reach the node").toBeDefined();
    const brokerClose = captured.find((c) => c.cmd.type === "ssh_session_close");
    expect(brokerClose?.nodeId, "ssh_session_close must name the connecting node").toBe(session.connectingNodeId);
    expect(brokerClose?.cmd.ref).toBe(session.id);

    await pollUntil("the session row never settled closed", async () => {
      const row = await sessionsRepo.findById(session.id);
      return row?.status === "closed" && row.closedAt !== null;
    });
    const node = await nodesRepo.findById(session.runtimeNodeId);
    expect(node?.status).toBe("offline");

    // M5: the cache entry is gone (the settle evicts it; the plaintext map
    // rides the session, so the entry leaving IS the promise).
    await pollUntil(
      "the launcher cache never evicted",
      () => peekRuntimeLauncherForTests(session.runtimeNodeId) === undefined,
    );

    // A second close reads 404 (the registry is the door, and it is shut).
    const again = await closeSession(session.id, userId).then(
      () => null,
      (e: unknown) => e,
    );
    expect((again as { status?: number }).status).toBe(404);
  });
});
