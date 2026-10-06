import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  SSH_RUNTIME_PROTOCOL,
  SSH_SESSIONS_PER_NODE,
  type SshRuntimeHelloWire,
  type SshSessionTargetWire,
} from "@internal/subshell-protocol";
import { hashPassword } from "better-auth/crypto";
import { ensureMigratedTestDb } from "@/__tests__/helpers/test-database.js";
import { deleteUserByEmailOrId, setupAuthTables } from "@/api/__tests__/helpers/auth-tables.js";
import { db } from "@/db/index.js";
import { NodesRepository } from "@/db/repositories/nodes.repository.js";
import { UsersRepository } from "@/db/repositories/users.repository.js";
import { NODE_KIND_RUNTIME } from "@/db/types/nodes.db-types.js";
import { allLiveSessionIds, resetSessionRegistryForTests } from "@/services/ssh-runtime/session-registry.js";
import { openSession, SshRuntimeRefusal, type SshRuntimeSessionView } from "@/services/ssh-runtime/sessions.service.js";
import { attachScriptedNode, ok, type ScriptedHandlers } from "@/test-helpers/scripted-node.js";

/**
 * The OPEN-door guardrails (design 2026-10-05 §2/§4), pinned at the service
 * seam with a scripted connecting node (the real `sendCommand` chain, no RPC
 * mocks):
 *
 * - **Incompatible runtime version refuses BY NAME** (the acceptance run of
 *   2026-10-05 measured it: a well-framed hello with `runtimeProtocol: 99`
 *   is refused, the message says both numbers and the remedy, and NOTHING
 *   remains: no `opening` row, no hidden runtime node, no registry session,
 *   and the broker saw exactly one open plus the unroll's close - zero pump
 *   frames for a session that never spoke the language).
 * - **The plane-side quota mirror** refuses the 9th open with the named
 *   `session_quota` BEFORE the broker is dialed (the node holds its own copy
 *   of the same number; the mirror is what the plane enforces first), and the
 *   node-side refusal (`result.error: "session_quota"` on the open RPC) maps
 *   to the same named refusal through `mapOpenError` - both sides of the
 *   quota land on one equality-mapped code.
 */

const email = `openguard-${crypto.randomUUID()}@subshell.local`;
let userId: string;
const cleanupNodes: string[] = [];
const cleanupSessions: string[] = [];

const target: SshSessionTargetWire = {
  alias: "guard",
  host: "127.0.0.1",
  port: 22,
  user: null,
  identityFile: null,
};

function hello(runtimeProtocol: number): SshRuntimeHelloWire {
  return {
    type: "hello",
    runtimeProtocol,
    agentVersion: "1.5.0",
    os: "linux",
    arch: "x64",
    capabilities: ["ssh-runtime", "callback-sock", "detect", "pane-callback-sock"],
    homeDir: "/home/dst",
    dataDir: "/home/dst/.local/share/subshell/runtime",
    tmuxSocket: "subshell-ssh-guard000000",
    paneCount: 0,
  };
}

/** The `ssh_session_open` result the scripted node answers with. */
function openResult(runtimeProtocol = SSH_RUNTIME_PROTOCOL) {
  return { hello: hello(runtimeProtocol), host: target.host, port: target.port, user: target.user };
}

/** A fresh owned agent node row (the scripted connection is attached per test). */
async function mkConnectingNode(name: string): Promise<string> {
  const id = crypto.randomUUID();
  cleanupNodes.push(id);
  await new NodesRepository(db).create({ id, ownerUserId: userId, name, kind: "agent" });
  return id;
}

/** One seeded history row with its hidden runtime node (the quota mirror counts these). */
async function seedActiveSession(connectingNodeId: string, tag: string): Promise<void> {
  const runtimeNodeId = crypto.randomUUID();
  const sessionId = crypto.randomUUID();
  cleanupNodes.push(runtimeNodeId);
  cleanupSessions.push(sessionId);
  const now = new Date().toISOString();
  await new NodesRepository(db).create({
    id: runtimeNodeId,
    ownerUserId: userId,
    name: `guard-rt-${tag}`,
    kind: NODE_KIND_RUNTIME,
    status: "online",
    lastSeenAt: now,
  });
  await db
    .insertInto("sshRuntimeSessions")
    .values({
      id: sessionId,
      ownerUserId: userId,
      connectingNodeId,
      runtimeNodeId,
      alias: target.alias,
      host: target.host,
      port: target.port,
      user: target.user,
      status: "active",
      helloJson: null,
      createdAt: now,
      lastSeenAt: null,
      closedAt: null,
    })
    .execute();
}

beforeAll(async () => {
  await ensureMigratedTestDb();
  await setupAuthTables();
  userId = await new UsersRepository(db).createUser({
    email,
    name: email,
    passwordHash: await hashPassword("guard-pass-1"),
    role: "user",
  });
});

afterAll(async () => {
  resetSessionRegistryForTests();
  await db
    .deleteFrom("sshRuntimeSessions")
    .execute()
    .catch(() => {});
  for (const id of cleanupNodes) {
    await db
      .deleteFrom("nodes")
      .where("id", "=", id)
      .execute()
      .catch(() => {});
  }
  await deleteUserByEmailOrId(email).catch(() => {});
});

describe("open: incompatible runtime version refuses by name", () => {
  test("hello(runtimeProtocol 99) answers the both-numbers refusal and leaves zero residue", async () => {
    const node = await mkConnectingNode(`guard-v99-${crypto.randomUUID().slice(0, 8)}`);
    const seenCloseRefs: string[] = [];
    const sim = attachScriptedNode(node, {
      ssh_session_open: () => openResult(99),
      ssh_session_close: (cmd) => {
        if (cmd.type === "ssh_session_close") seenCloseRefs.push(cmd.ref);
        return undefined;
      },
    });
    try {
      const err = await openSession(userId, { connectingNodeId: node, target }).then(
        () => null,
        (e: unknown) => e,
      );
      expect(err, "the mismatched open must refuse").toBeInstanceOf(SshRuntimeRefusal);
      const refusal = err as SshRuntimeRefusal;
      // The exact shipped sentence: BOTH numbers and the destination remedy.
      expect(refusal.message).toBe(
        `the destination runtime speaks protocol 99; this plane speaks ${SSH_RUNTIME_PROTOCOL} - update the subshell binary on the destination`,
      );
      // No session residue, asserted at every door the failed open touched:
      expect(
        await db.selectFrom("sshRuntimeSessions").selectAll().where("connectingNodeId", "=", node).execute(),
      ).toEqual([]); // no `opening`/`lost` row survived the unroll
      expect(
        await db
          .selectFrom("nodes")
          .selectAll()
          .where("kind", "=", NODE_KIND_RUNTIME)
          .where("ownerUserId", "=", userId)
          .execute(),
      ).toEqual([]);
      expect(allLiveSessionIds()).toEqual([]); // the registry never held it
      // The broker saw the open and the unroll's close, and NOT a live pump:
      expect(sim.countOf("ssh_session_open")).toBe(1);
      expect(sim.countOf("ssh_session_close")).toBe(1);
      expect(seenCloseRefs.length).toBe(1);
      expect(sim.countOf("ssh_session_send")).toBe(0);
    } finally {
      sim.detach();
      await db
        .deleteFrom("nodes")
        .where("id", "=", node)
        .execute()
        .catch(() => {});
    }
  });
});

describe("open: the plane-side quota mirror", () => {
  test("the open after SSH_SESSIONS_PER_NODE active refuses session_quota BEFORE the broker", async () => {
    const node = await mkConnectingNode(`guard-quota-${crypto.randomUUID().slice(0, 8)}`);
    const handlers: ScriptedHandlers = {
      ssh_session_open: () => openResult(),
      ssh_session_close: ok,
    };
    const sim = attachScriptedNode(node, handlers);
    try {
      // The gate is real below the cap first: one open answers 200-ish (the
      // service's view) and lands `active` on the mirror.
      const view: SshRuntimeSessionView = await openSession(userId, { connectingNodeId: node, target });
      expect(view.status).toBe("active");
      cleanupSessions.push(view.id);
      // Fill the node to exactly the cap (the fresh open above is one of the
      // counted rows; seed the rest).
      for (let i = 1; i < SSH_SESSIONS_PER_NODE; i++) await seedActiveSession(node, `q${i}`);
      const before = sim.countOf("ssh_session_open");

      const err = await openSession(userId, { connectingNodeId: node, target }).then(
        () => null,
        (e: unknown) => e,
      );
      expect(err, "the 9th open must refuse").toBeInstanceOf(SshRuntimeRefusal);
      const refusal = err as SshRuntimeRefusal;
      expect(refusal.status).toBe(409);
      expect(refusal.code).toBe("session_quota"); // the equality-mapped name the routes carry as sshCode
      expect(refusal.message).toBe("the connecting node carries its share of open sessions");
      expect(sim.countOf("ssh_session_open"), "the mirror refuses without dialing the broker").toBe(before);
      const rows = await db.selectFrom("sshRuntimeSessions").selectAll().where("connectingNodeId", "=", node).execute();
      expect(rows.length).toBe(SSH_SESSIONS_PER_NODE); // no 9th row, not even `opening`
    } finally {
      sim.detach();
      resetSessionRegistryForTests();
      await db
        .deleteFrom("sshRuntimeSessions")
        .execute()
        .catch(() => {});
      await db
        .deleteFrom("nodes")
        .where("id", "=", node)
        .execute()
        .catch(() => {});
    }
  });

  test("the node-side quota refusal maps to the same named session_quota, and the attempt unrolls", async () => {
    const node = await mkConnectingNode(`guard-nodeq-${crypto.randomUUID().slice(0, 8)}`);
    // The supervisor's own quota check answers the bare code on the wire; the
    // plane's mapper must name it the same as its mirror's.
    const sim = attachScriptedNode(node, { ssh_session_open: () => new Error("session_quota"), ssh_session_close: ok });
    try {
      const err = await openSession(userId, { connectingNodeId: node, target }).then(
        () => null,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(SshRuntimeRefusal);
      const refusal = err as SshRuntimeRefusal;
      expect(refusal.status).toBe(409);
      expect(refusal.code).toBe("session_quota");
      expect(refusal.message).toBe("the connecting node carries its share of open sessions");
      // `mapOpenError` consumed it, so nothing was left behind to settle:
      expect(
        await db.selectFrom("sshRuntimeSessions").selectAll().where("connectingNodeId", "=", node).execute(),
      ).toEqual([]);
      expect(allLiveSessionIds()).toEqual([]);
    } finally {
      sim.detach();
      await db
        .deleteFrom("nodes")
        .where("id", "=", node)
        .execute()
        .catch(() => {});
    }
  });
});
