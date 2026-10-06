import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { ApiError, BackendErrorCodes } from "@internal/backend-errors";
import { getHarness } from "@internal/pane-runtime";
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
import { ApiContext } from "@/lib/context.js";
import { SshRuntimeSession } from "@/services/ssh-runtime/session.js";
import {
  registerSession,
  resetSessionRegistryForTests,
  sessionHooks,
} from "@/services/ssh-runtime/session-registry.js";
import { SshRuntimeSessionsRepository } from "@/services/ssh-runtime/sessions.repository.js";
import { SshRuntimeRefusal } from "@/services/ssh-runtime/sessions.service.js";
import { sessionLaunchHarness, sessionLaunchTerminal } from "@/services/ssh-runtime/sessions-lifecycle.js";
import { revokeSubshellToken } from "@/services/subshell-tokens.js";
import { attachScriptedNode, ok } from "@/test-helpers/scripted-node.js";
import { getLogger } from "@/utils/logger.js";

/**
 * The two pane-door refusals the acceptance run of 2026-10-05 measured but
 * the committed suite did not hold (walkthrough matrix: "stale input GAP",
 * "harness-binary-missing-at-launch refusal untested"):
 *
 * - **Input after loss**: when the SSH child died, the lost settling flipped
 *   the pane row to `running, alive: 0` (unavailable, not completed), and
 *   `sendSubshellInput` answers the named 409 SUBSHELL_NOT_RUNNING BEFORE
 *   resolving any launcher: nothing is typed, nothing queues, nothing
 *   replays, and the broker sees zero new frames.
 * - **Harness binary missing at launch**: the destination's resolve ladder
 *   answers the launch frame `ok:false` with the executor's own
 *   `harness binary missing:` error, and `sessionLaunchHarness` maps it to a
 *   named 409 pointing at the HARNESS on the destination - unrolling the row,
 *   the minted token, and the pane registration so no half-pane survives.
 *
 * The broker is the scripted node (the real RPC chain); its `ssh_session_send`
 * arm decodes the runtime frame and answers it back through the session's own
 * pump - success, or per-test refusal, for the frame types the test names.
 */

const email = `panerefuse-${crypto.randomUUID()}@subshell.local`;
let userId: string;
let ctx: ApiContext;
const cleanupNodes: string[] = [];
const cleanupSessions: string[] = [];
const cleanupPanes: string[] = [];

const target: SshSessionTargetWire = { alias: "pr", host: "127.0.0.1", port: 22, user: null, identityFile: null };

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
    tmuxSocket: "subshell-ssh-pr00000000",
    paneCount: 0,
  };
}

/* The scripted pump: one live session per test receives the answered frames. */
let pumpTarget: SshRuntimeSession | undefined;
/** Frame types the pump must REFUSE (with this error), instead of answering ok. */
let refuseFrames: Map<string, string> = new Map();

const sessionsRepo = new SshRuntimeSessionsRepository(db);
const subshellsRepo = new SubshellsRepository(db);

async function mkSession(tag: string): Promise<SshRuntimeSession> {
  const connectingNodeId = crypto.randomUUID();
  const runtimeNodeId = crypto.randomUUID();
  const sessionId = crypto.randomUUID();
  cleanupNodes.push(runtimeNodeId, connectingNodeId);
  cleanupSessions.push(sessionId);
  const now = new Date().toISOString();
  await new NodesRepository(db).create({ id: connectingNodeId, ownerUserId: userId, name: `pr-${tag}`, kind: "agent" });
  await new NodesRepository(db).create({
    id: runtimeNodeId,
    ownerUserId: userId,
    name: `pr-rt-${tag}`,
    kind: NODE_KIND_RUNTIME,
    status: "online",
    lastSeenAt: now,
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
  session.hooks = sessionHooks(); // the REAL hooks: the lost settling this suite asserts rides them
  registerSession(session);
  return session;
}

/** Poll a condition with the real clock (settle writes are async `void`s off the hooks). */
async function waitUntil(cond: () => boolean | Promise<boolean>, what: string): Promise<void> {
  const t0 = Date.now();
  for (;;) {
    if (await cond()) return;
    if (Date.now() - t0 > 2000) throw new Error(`timed out waiting for: ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

beforeAll(async () => {
  await ensureMigratedTestDb();
  await setupAuthTables();
  userId = await new UsersRepository(db).createUser({
    email,
    name: email,
    passwordHash: await hashPassword("pr-pass-1"),
    role: "user",
  });
  ctx = new ApiContext({ db, log: getLogger() });
});

afterAll(async () => {
  resetSessionRegistryForTests();
  for (const id of cleanupPanes) {
    await revokeSubshellToken(id).catch(() => {});
    await subshellsRepo.delete(id).catch(() => {});
  }
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

describe("input after the child died", () => {
  test("a lost session's pane answers the named stale refusal with zero frames written", async () => {
    const session = await mkSession(`lost-${crypto.randomUUID().slice(0, 8)}`);
    pumpTarget = session;
    refuseFrames = new Map();
    const sim = attachScriptedNode(session.connectingNodeId, {
      ssh_session_close: ok,
      ssh_session_send: (cmd) => {
        if (cmd.type !== "ssh_session_send" || pumpTarget === undefined) return new Error("unexpected send");
        for (const frame of new SshSessionFrameDecoder().push(new Uint8Array(Buffer.from(cmd.data_b64, "base64")))) {
          const inner = frame as { type?: string; ref?: string; path?: string };
          if (inner.ref === undefined) continue;
          const refusal = inner.type === undefined ? undefined : refuseFrames.get(inner.type);
          pumpTarget.ingestBytes(
            encodeSshSessionFrame(
              refusal === undefined
                ? {
                    type: "result",
                    ref: inner.ref,
                    ok: true,
                    // The F3 pre-launch `stat_dir` answers with the executor's
                    // realpath success shape; every other ok frame needs none.
                    ...(inner.type === "stat_dir"
                      ? { data: { path: inner.path ?? "/home/dst/work", isDirectory: true } }
                      : {}),
                  }
                : { type: "result", ref: inner.ref, ok: false, error: refusal },
            ),
          );
        }
        return undefined;
      },
    });
    try {
      // A real terminal pane on the live session: row + token + launch frame.
      const { subshellId } = await sessionLaunchTerminal(session.id, userId, { cwd: "/home/dst/work" });
      cleanupPanes.push(subshellId);
      const sentAfterLaunch = sim.countOf("ssh_session_send");
      const row0 = await subshellsRepo.findById(subshellId);
      expect(row0?.status).toBe("running");
      expect(row0?.alive).toBe(1);

      // The child dies: the loss settling (the REAL hooks) flips the row to
      // the shot-16 posture - `running` with `alive: 0`, unavailable not
      // completed - and evicts the session from the registry.
      session.markLost("child-lost");
      await waitUntil(async () => (await subshellsRepo.findById(subshellId))?.alive === 0, "pane row alive: 0");
      const row = await subshellsRepo.findById(subshellId);
      expect(row?.status).toBe("running"); // the outcome the plane never witnessed stays as it was
      expect(row?.alive).toBe(0);

      // The launcher's door from REST: the named stale refusal, before the
      // launcher is even resolved, so nothing can be written.
      const err = await ctx.services.subshells.sendSubshellInput(userId, subshellId, "WALK-PROBE", true, "cookie").then(
        () => null,
        (e: unknown) => e,
      );
      expect(err, "input into the lost pane must refuse").toBeInstanceOf(ApiError);
      const apiErr = err as ApiError;
      expect(apiErr.code).toBe(BackendErrorCodes.SUBSHELL_NOT_RUNNING);
      expect(apiErr.statusCode).toBe(409);
      expect(apiErr.message).toContain("not running; nothing was typed");
      // Zero frames: the broker saw nothing more after the launch that made
      // the pane, so nothing queued and nothing replayed.
      expect(sim.countOf("ssh_session_send")).toBe(sentAfterLaunch);
    } finally {
      sim.detach();
      pumpTarget = undefined;
    }
  });
});

describe("harness binary missing at launch", () => {
  test("the destination's launch refusal maps to the named harness remedy and unrolls every write", async () => {
    const session = await mkSession(`nobin-${crypto.randomUUID().slice(0, 8)}`);
    pumpTarget = session;
    // The runtime's own executor refuses (apps/node/agent/src/commands/launch.ts):
    // the resolve ladder found nothing on the destination.
    refuseFrames = new Map([["launch", `harness binary missing: claude-code`]]);
    const sim = attachScriptedNode(session.connectingNodeId, {
      ssh_session_close: ok,
      ssh_session_send: (cmd) => {
        if (cmd.type !== "ssh_session_send" || pumpTarget === undefined) return new Error("unexpected send");
        for (const frame of new SshSessionFrameDecoder().push(new Uint8Array(Buffer.from(cmd.data_b64, "base64")))) {
          const inner = frame as { type?: string; ref?: string; path?: string };
          if (inner.ref === undefined) continue;
          const refusal = inner.type === undefined ? undefined : refuseFrames.get(inner.type);
          pumpTarget.ingestBytes(
            encodeSshSessionFrame(
              refusal === undefined
                ? {
                    type: "result",
                    ref: inner.ref,
                    ok: true,
                    // The F3 pre-launch `stat_dir` answers with the executor's
                    // realpath success shape; every other ok frame needs none.
                    ...(inner.type === "stat_dir"
                      ? { data: { path: inner.path ?? "/home/dst/work", isDirectory: true } }
                      : {}),
                  }
                : { type: "result", ref: inner.ref, ok: false, error: refusal },
            ),
          );
        }
        return undefined;
      },
    });
    try {
      const harness = getHarness("claude-code");
      expect(harness, "the built-in claude-code harness must resolve for the fixture").toBeDefined();
      const err = await sessionLaunchHarness(session.id, userId, {
        harnessId: "claude-code",
        cwd: "/home/dst/work",
      }).then(
        () => null,
        (e: unknown) => e,
      );
      expect(err, "a missing destination harness binary must refuse").toBeInstanceOf(SshRuntimeRefusal);
      const refusal = err as SshRuntimeRefusal;
      expect(refusal.status).toBe(409);
      // The remedy names the HARNESS on the destination (not the Subshell
      // binary - that pointer belongs to the terminal verb's own refusal).
      expect(refusal.message).toBe(`Harness "${harness?.name}" is not installed on the destination.`);
      // The unroll: the pane never existed. Row, token, and registration are
      // all gone (the terminal verb's failed-spawn posture, same writes).
      const paneIds = session.paneIds();
      expect(paneIds).toEqual([]);
      const rows = await subshellsRepo.listByUser(userId);
      expect(rows.filter((r) => r.nodeId === session.runtimeNodeId)).toEqual([]);
      // The attempt did reach the destination: the F3 `stat_dir` gate passed
      // (the directory probe is not what refused) and the LAUNCH refusal is
      // the destination's own answer - exactly two framed commands crossed.
      expect(sim.countOf("ssh_session_send")).toBe(2);
    } finally {
      sim.detach();
      pumpTarget = undefined;
      refuseFrames = new Map();
    }
  });
});
