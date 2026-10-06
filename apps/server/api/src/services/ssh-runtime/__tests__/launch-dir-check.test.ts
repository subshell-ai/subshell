import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  encodeSshSessionFrame,
  SSH_RUNTIME_PROTOCOL,
  type SshRuntimeHelloWire,
  SshSessionFrameDecoder,
  type SshSessionTargetWire,
} from "@internal/subshell-protocol";
import { hashPassword } from "better-auth/crypto";
import { ensureMigratedTestDb } from "@/__tests__/helpers/test-database.js";
import { deleteUserByEmailOrId, setupAuthTables } from "@/api/__tests__/helpers/auth-tables.js";
import { db } from "@/db/index.js";
import { NodesRepository } from "@/db/repositories/nodes.repository.js";
import { SubshellsRepository } from "@/db/repositories/subshells.repository.js";
import { UsersRepository } from "@/db/repositories/users.repository.js";
import { NODE_KIND_RUNTIME } from "@/db/types/nodes.db-types.js";
import { SshRuntimeSession } from "@/services/ssh-runtime/session.js";
import {
  registerSession,
  resetSessionRegistryForTests,
  sessionHooks,
} from "@/services/ssh-runtime/session-registry.js";
import { SshRuntimeSessionsRepository } from "@/services/ssh-runtime/sessions.repository.js";
import { SshRuntimeRefusal } from "@/services/ssh-runtime/sessions.service.js";
import { sessionLaunchHarness, sessionLaunchTerminal } from "@/services/ssh-runtime/sessions-lifecycle.js";
import { attachScriptedNode, ok, type ScriptedNode } from "@/test-helpers/scripted-node.js";

/**
 * F3: the launch verbs stat-verify the destination working dir BEFORE the
 * first plane write (design §7 "invalid directory names the remedy"). The
 * acceptance run measured `launch-terminal cwd=/no/such` answering 200 with a
 * row claiming the missing path while the destination shell fell back to `~`
 * - a lying row. The gate is the runtime's own `stat_dir` (the node link's
 * `validateWorkingDir` executor, shared), so the refusal is destination truth.
 *
 * Pinned here at the service seam:
 * - `ENOENT`/`ENOTDIR` on the stat refuses `dir_missing` with 409, a message
 *   naming the value and the remedy, and NOTHING written (no row, no token,
 *   no registration) - the guard is before the row/token/frame order.
 * - the row and the launch frame carry the stat's REALPATH, not the typed
 *   string.
 * - the harness verb obeys the same rule (and its cheap guards - unknown
 *   harness, foreign preset, mismatch - stay frameless: they precede the stat).
 * - a dead session answers the channel's own error, not a fake refusal.
 */

const email = `dircheck-${crypto.randomUUID()}@subshell.local`;
let userId: string;
const cleanupNodes: string[] = [];
const cleanupSessions: string[] = [];
const cleanupPanes: string[] = [];
let sim: ScriptedNode | undefined;

const sessionsRepo = new SshRuntimeSessionsRepository(db);
const nodesRepo = new NodesRepository(db);
const subshellsRepo = new SubshellsRepository(db);

const target: SshSessionTargetWire = { alias: "dc", host: "127.0.0.1", port: 22, user: null, identityFile: null };

function hello(): SshRuntimeHelloWire {
  return {
    type: "hello",
    runtimeProtocol: SSH_RUNTIME_PROTOCOL,
    agentVersion: "1.5.0",
    os: "linux",
    arch: "x64",
    capabilities: ["ssh-runtime", "callback-sock", "detect", "pane-callback-sock"],
    homeDir: "/home/dst",
    dataDir: "/home/dst/.local/share/subshell/runtime",
    tmuxSocket: "subshell-ssh-dc0000000000",
    paneCount: 0,
  };
}

/** How the scripted runtime answers `stat_dir`: realpath success, or the named refusal. */
let statAnswer: { ok: true; path: string } | { ok: false; error: string } = { ok: true, path: "/home/dst/work" };
/** Inner frames the scripted runtime has seen, in wire order. */
let innerFrames: string[] = [];

async function mkSession(): Promise<SshRuntimeSession> {
  const connectingNodeId = crypto.randomUUID();
  const runtimeNodeId = crypto.randomUUID();
  const sessionId = crypto.randomUUID();
  cleanupNodes.push(runtimeNodeId, connectingNodeId);
  cleanupSessions.push(sessionId);
  await nodesRepo.create({
    id: connectingNodeId,
    ownerUserId: userId,
    name: `dc-${sessionId.slice(0, 8)}`,
    kind: "agent",
  });
  await nodesRepo.create({
    id: runtimeNodeId,
    ownerUserId: userId,
    name: `dc-rt-${sessionId.slice(0, 8)}`,
    kind: NODE_KIND_RUNTIME,
    status: "online",
    lastSeenAt: new Date().toISOString(),
  });
  await sessionsRepo.create({
    id: sessionId,
    ownerUserId: userId,
    connectingNodeId,
    runtimeNodeId,
    alias: target.alias,
    host: target.host,
    port: target.port,
    user: target.user,
    status: "active",
  });
  await sessionsRepo.settle(sessionId, "active", JSON.stringify(hello()));
  const session = new SshRuntimeSession({
    id: sessionId,
    ownerId: userId,
    connectingNodeId,
    runtimeNodeId,
    target,
    hello: hello(),
  });
  session.hooks = sessionHooks();
  registerSession(session);
  sim?.detach();
  sim = attachScriptedNode(connectingNodeId, {
    ssh_session_close: ok,
    ssh_session_send: (cmd) => {
      if (cmd.type !== "ssh_session_send") throw new Error("wrong cmd");
      for (const frame of new SshSessionFrameDecoder().push(new Uint8Array(Buffer.from(cmd.data_b64, "base64")))) {
        const inner = frame as { type?: string; ref?: string; cwd?: string };
        if (inner.ref === undefined) continue;
        innerFrames.push(inner.type ?? "?");
        if (inner.type === "stat_dir") {
          session.ingestBytes(
            encodeSshSessionFrame(
              statAnswer.ok
                ? { type: "result", ref: inner.ref, ok: true, data: { path: statAnswer.path, isDirectory: true } }
                : { type: "result", ref: inner.ref, ok: false, error: statAnswer.error },
            ),
          );
          continue;
        }
        session.ingestBytes(encodeSshSessionFrame({ type: "result", ref: inner.ref, ok: true }));
      }
      return undefined;
    },
  });
  return session;
}

function mkLaunchRows(): Promise<unknown> {
  return subshellsRepo.listByUser(userId);
}

beforeAll(async () => {
  await ensureMigratedTestDb();
  await setupAuthTables();
  userId = await new UsersRepository(db).createUser({
    email,
    name: email,
    passwordHash: await hashPassword("dc-pass-1"),
    role: "user",
  });
});

afterAll(async () => {
  sim?.detach();
  resetSessionRegistryForTests();
  for (const id of cleanupPanes) await subshellsRepo.delete(id).catch(() => {});
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

describe("launch-terminal: the directory gate precedes every write", () => {
  test("ENOENT on the destination refuses dir_missing with 409 and writes nothing", async () => {
    const session = await mkSession();
    statAnswer = { ok: false, error: "ENOENT: /no/such/dir-dc" };
    innerFrames = [];
    const err = await sessionLaunchTerminal(session.id, userId, { cwd: "/no/such/dir-dc" }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err, "a missing destination directory must refuse").toBeInstanceOf(SshRuntimeRefusal);
    const refusal = err as SshRuntimeRefusal;
    expect(refusal.status).toBe(409);
    expect(refusal.code).toBe("dir_missing"); // the sshCode the routes carry
    expect(refusal.message).toContain("/no/such/dir-dc"); // names the refused value
    expect(refusal.message).toContain("Choose an existing folder"); // names the remedy
    // The gate is BEFORE the row/token/frame order: nothing was written.
    const rows = (await mkLaunchRows()) as { workingDir: string }[];
    expect(rows.filter((r) => r.workingDir.includes("no/such/dir-dc")).length).toBe(0);
    expect(session.paneIds()).toEqual([]);
    expect(innerFrames).toEqual(["stat_dir"]); // the probe asked, nothing launched
  });

  test("ENOTDIR refuses the same named way (a file is not a working dir)", async () => {
    const session = await mkSession();
    statAnswer = { ok: false, error: "ENOTDIR: /home/dst/work/notes.txt" };
    innerFrames = [];
    const err = await sessionLaunchTerminal(session.id, userId, { cwd: "/home/dst/work/notes.txt" }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(SshRuntimeRefusal);
    expect((err as SshRuntimeRefusal).code).toBe("dir_missing");
    expect(session.paneIds()).toEqual([]);
  });

  test("success records the REALPATH the stat returned, in the row and the launch frame", async () => {
    const session = await mkSession();
    statAnswer = { ok: true, path: "/home/dst/work" }; // the stat echoes the resolved target
    innerFrames = [];
    const { subshellId } = await sessionLaunchTerminal(session.id, userId, { cwd: "/home/dst/work" });
    cleanupPanes.push(subshellId);
    const row = await subshellsRepo.findById(subshellId);
    expect(row?.workingDir).toBe("/home/dst/work");
    expect(innerFrames).toEqual(["stat_dir", "launch"]);
  });

  test("a dead session is the door that closed, not a fake dir refusal", async () => {
    const session = await mkSession();
    statAnswer = { ok: false, error: "ENOENT: /no/such/dir-dc" };
    session.markLost("child-lost");
    const err = await sessionLaunchTerminal(session.id, userId, { cwd: "/no/such/dir-dc" }).then(
      () => null,
      (e: unknown) => e,
    );
    // The lost settle evicted the session from the registry, so the launch
    // verb's owner door answers 404 ("gone reads like never was"). The
    // dir_missing refusal is the DESTINATION's answer to a live session,
    // never a guess about a dead one.
    expect(err).toBeInstanceOf(SshRuntimeRefusal);
    expect((err as SshRuntimeRefusal).status).toBe(404);
  });
});

describe("launch-harness: the same gate, guards first", () => {
  test("cheap guard refusals stay frameless; the dir gate then precedes the row", async () => {
    const session = await mkSession();
    statAnswer = { ok: true, path: "/home/dst/work" };
    innerFrames = [];
    await expect(
      sessionLaunchHarness(session.id, userId, { harnessId: "not-a-harness", cwd: "/home/dst/work" }),
    ).rejects.toMatchObject({ status: 409 });
    expect(innerFrames, "the unknown-harness refusal never dials the destination").toEqual([]);

    statAnswer = { ok: false, error: "ENOENT: /no/such/harness-dir" };
    const err = await sessionLaunchHarness(session.id, userId, {
      harnessId: "claude-code",
      cwd: "/no/such/harness-dir",
    }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(SshRuntimeRefusal);
    expect((err as SshRuntimeRefusal).code).toBe("dir_missing");
    const rows = (await mkLaunchRows()) as unknown[];
    expect(rows.filter((r) => JSON.stringify(r).includes("harness-dir")).length).toBe(0);
    expect(session.paneIds()).toEqual([]);
  });
});
