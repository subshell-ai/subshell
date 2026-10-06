import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  encodeSshSessionFrame,
  SSH_RUNTIME_PROTOCOL,
  type SshRuntimeHelloWire,
  type SshRuntimeReportRow,
  SshSessionFrameDecoder,
  type SshSessionTargetWire,
} from "@internal/subshell-protocol";
import { hashPassword } from "better-auth/crypto";
import { ensureMigratedTestDb } from "@/__tests__/helpers/test-database.js";
import { deleteUserByEmailOrId, setupAuthTables } from "@/api/__tests__/helpers/auth-tables.js";
import { authDatabase } from "@/auth/database.js";
import { db } from "@/db/index.js";
import { NodesRepository } from "@/db/repositories/nodes.repository.js";
import { SubshellsRepository } from "@/db/repositories/subshells.repository.js";
import { UsersRepository } from "@/db/repositories/users.repository.js";
import { NODE_KIND_RUNTIME } from "@/db/types/nodes.db-types.js";
import { SshRuntimeSession } from "@/services/ssh-runtime/session.js";
import { type AdoptSummary, adoptReconciledPanes } from "@/services/ssh-runtime/session-adopt.js";
import {
  registerSession,
  resetSessionRegistryForTests,
  sessionHooks,
} from "@/services/ssh-runtime/session-registry.js";
import { SshRuntimeSessionsRepository } from "@/services/ssh-runtime/sessions.repository.js";
import { sessionLaunchTerminal } from "@/services/ssh-runtime/sessions-lifecycle.js";
import { issueSubshellToken, revokeSubshellToken } from "@/services/subshell-tokens.js";
import { attachScriptedNode, ok, type ScriptedNode } from "@/test-helpers/scripted-node.js";

/**
 * F2: the reopen RE-ADOPT (design 2026-10-05 §6 "plane matches reported pane
 * ids to existing rows (idempotent restore)"), pinned at the service seam.
 *
 * The scenario the acceptance run measured as F2: a session dies (ssh child
 * killed), its panes keep running on the destination's deterministic tmux
 * socket, and the plane has today no path from "the fresh runtime reports the
 * id" to "the ordinary row reads alive again on the NEW session". The pump is
 * the scripted connecting node (the real RPC chain; the runtime half answered
 * per-frame, like `runtime-pane-refusals`): the census is destination truth
 * fed back frame-for-frame.
 *
 * The decisions pinned here, each stated in `session-adopt.ts`:
 * - survivor: SAME id, row repointed to the new runtime node, `alive`
 *   restored, token ROTATED on the same row (key id changes, the old mint
 *   dies, the new plaintext reaches the new session's registry).
 * - dead/absent in the census: settled dead (the boot-sweep leftover that
 *   still says alive gets flipped and revoked).
 * - reported-but-unknown: recorded, no row invented.
 * - the old hidden runtime node: kept, offline, as history.
 * - a refused census: every row stays as the settle wrote it (skipped).
 * - a different destination's rows are never touched (host/port/user match).
 * - a session that DIES mid-walk (MINOR-1, both re-check seams): the row the
 *   walk had just claimed ends `alive: 0` with its token revoked and no
 *   registration - never a live row on a settled session.
 * - two CONCURRENT reopens of one survivor (MINOR-2): exactly one walk wins
 *   the conditional flip; the loser touches nothing, and the winner's
 *   rotation stays live.
 */

const email = `adopt-${crypto.randomUUID()}@subshell.local`;
let userId: string;
const cleanupNodes: string[] = [];
const cleanupSessions: string[] = [];
const cleanupPanes: string[] = [];
const sims: ScriptedNode[] = [];

const sessionsRepo = new SshRuntimeSessionsRepository(db);
const nodesRepo = new NodesRepository(db);
const subshellsRepo = new SubshellsRepository(db);

const target: SshSessionTargetWire = { alias: "ad", host: "127.0.0.1", port: 22, user: null, identityFile: null };

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
    tmuxSocket: "subshell-ssh-ad0000000000",
    paneCount: 0,
  };
}

/** The census the scripted runtime answers the NEXT `subshells_report` with. */
let censusRows: SshRuntimeReportRow[] = [];
/** When set, the census frame is REFUSED with this error instead of answered. */
let censusRefusal: string | null = null;

/** One session: rows, registry registration, scripted connecting node. */
async function mkSession(tag: string, overTarget: Partial<SshSessionTargetWire> = {}): Promise<SshRuntimeSession> {
  const t = { ...target, ...overTarget };
  const connectingNodeId = crypto.randomUUID();
  const runtimeNodeId = crypto.randomUUID();
  const sessionId = crypto.randomUUID();
  cleanupNodes.push(runtimeNodeId, connectingNodeId);
  cleanupSessions.push(sessionId);
  const now = new Date().toISOString();
  await nodesRepo.create({ id: connectingNodeId, ownerUserId: userId, name: `ad-${tag}`, kind: "agent" });
  await nodesRepo.create({
    id: runtimeNodeId,
    ownerUserId: userId,
    name: `ad-rt-${tag}`,
    kind: NODE_KIND_RUNTIME,
    status: "online",
    lastSeenAt: now,
  });
  await sessionsRepo.create({
    id: sessionId,
    ownerUserId: userId,
    connectingNodeId,
    runtimeNodeId,
    alias: t.alias,
    host: t.host,
    port: t.port,
    user: t.user,
    status: "active",
  });
  await sessionsRepo.settle(sessionId, "active", JSON.stringify(hello()));
  const session = new SshRuntimeSession({
    id: sessionId,
    ownerId: userId,
    connectingNodeId,
    runtimeNodeId,
    target: t,
    hello: hello(),
  });
  session.hooks = sessionHooks(); // the REAL settling: markLost below must write like production
  registerSession(session);
  sims.push(
    attachScriptedNode(connectingNodeId, {
      ssh_session_close: ok,
      ssh_session_send: (cmd) => {
        if (cmd.type !== "ssh_session_send") throw new Error("wrong cmd");
        for (const frame of new SshSessionFrameDecoder().push(new Uint8Array(Buffer.from(cmd.data_b64, "base64")))) {
          const inner = frame as { type?: string; ref?: string; path?: string };
          if (inner.ref === undefined) continue;
          if (inner.type === "subshells_report") {
            session.ingestBytes(
              encodeSshSessionFrame(
                censusRefusal !== null
                  ? { type: "result", ref: inner.ref, ok: false, error: censusRefusal }
                  : { type: "result", ref: inner.ref, ok: true, data: censusRows },
              ),
            );
            continue;
          }
          if (inner.type === "stat_dir") {
            session.ingestBytes(
              encodeSshSessionFrame({
                type: "result",
                ref: inner.ref,
                ok: true,
                data: { path: inner.path ?? "/home/dst/work", isDirectory: true },
              }),
            );
            continue;
          }
          session.ingestBytes(encodeSshSessionFrame({ type: "result", ref: inner.ref, ok: true }));
        }
        return undefined;
      },
    }),
  );
  return session;
}

/** A row + minted token OUTSIDE the launch verbs (the boot-sweep leftover shape). */
async function seedRowOnNode(nodeId: string, opts: { alive: 0 | 1; withToken: boolean }): Promise<string> {
  const id = crypto.randomUUID();
  cleanupPanes.push(id);
  await subshellsRepo.create({
    id,
    userId,
    harnessId: "terminal",
    name: `ad-pane-${id.slice(0, 8)}`,
    workingDir: "/home/dst/work",
    presetId: null,
    nodeId,
    tmuxSocket: `sock-${id}`,
    status: "running",
    alive: opts.alive,
    startedAt: new Date().toISOString(),
    notify: 1,
    crossAgent: 0,
  });
  if (opts.withToken) await issueSubshellToken(id, userId);
  return id;
}

/** Whether the apikey row behind a token is live (1) or revoked (0). */
function keyEnabled(apiKeyId: string): number | undefined {
  const row = authDatabase()
    .prepare<{ enabled: number }, [string]>(`SELECT enabled FROM apikey WHERE id = ?`)
    .get(apiKeyId);
  return row?.enabled;
}

/** Poll a condition (settle writes are async `void`s off the hooks). */
async function waitUntil(cond: () => Promise<boolean>, what: string): Promise<void> {
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
    passwordHash: await hashPassword("ad-pass-1"),
    role: "user",
  });
});

afterAll(async () => {
  for (const sim of sims) sim.detach();
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

describe("re-adopt: the reopen restores what the destination still has", () => {
  test("survivor repoints with a rotated token; dead settles; unknown is recorded, never a row", async () => {
    const a = await mkSession(`a-${crypto.randomUUID().slice(0, 8)}`);
    // A real launched pane (the ordinary row+token+frame order), then the
    // child dies: the lost settle is the F2 starting state (alive 0, token
    // revoked, node offline, row still pinned to the dead session's node).
    const { subshellId } = await sessionLaunchTerminal(a.id, userId, { cwd: "/home/dst/work" });
    cleanupPanes.push(subshellId);
    const keyBefore = (await subshellsRepo.findById(subshellId))?.apiKeyId;
    // A boot-sweep leftover on the SAME settled node: alive 1, token live,
    // never registered with the session (what `reconcileAtBoot` can leave).
    const leftoverId = await seedRowOnNode(a.runtimeNodeId, { alive: 1, withToken: true });
    // A dead row too (the census will confirm it dead).
    const deadId = await seedRowOnNode(a.runtimeNodeId, { alive: 1, withToken: true });

    a.markLost("child-lost");
    await waitUntil(async () => (await subshellsRepo.findById(subshellId))?.alive === 0, "lost settle alive: 0");

    // Reopen the same destination; the fresh runtime's census says: survivor
    // alive, dead dead, and a GHOST the plane never created.
    const b = await mkSession(`b-${crypto.randomUUID().slice(0, 8)}`);
    const ghostId = crypto.randomUUID();
    censusRows = [
      { subshellId, alive: true, exitCode: null },
      { subshellId: deadId, alive: false, exitCode: 3 },
      { subshellId: ghostId, alive: true, exitCode: null },
    ];
    censusRefusal = null;

    const summary = await adoptReconciledPanes(b);

    expect(summary.adopted).toEqual([subshellId]);
    expect(summary.settledDead).toContain(deadId);
    expect(summary.settledDead).toContain(leftoverId); // not reported alive -> settled dead
    expect(summary.unknown).toEqual([ghostId]);
    expect(summary.skipped).toBeNull();

    // The survivor: same id, NEW runtime node, alive restored.
    const row = await subshellsRepo.findById(subshellId);
    expect(row?.nodeId).toBe(b.runtimeNodeId);
    expect(row?.alive).toBe(1);
    expect(row?.status).toBe("running");
    // Token rotated on the same row: a new key id, the new plaintext in the
    // NEW session's registry (what lets the re-created destination door's
    // callbacks attribute again), and the old mint is not the live one.
    expect(row?.apiKeyId).not.toBeNull();
    expect(row?.apiKeyId).not.toBe(keyBefore);
    expect(b.paneToken(subshellId)).toBeTypeOf("string");
    expect(a.paneToken(subshellId)).toBeUndefined();

    // The dead/absent rows: settled, and never re-adopted.
    expect((await subshellsRepo.findById(deadId))?.alive).toBe(0);
    expect((await subshellsRepo.findById(leftoverId))?.alive).toBe(0);
    // The ghost: no row was invented.
    expect(await subshellsRepo.findById(ghostId)).toBeUndefined();
    // No duplicates: one row per id across the whole owner.
    const all = await subshellsRepo.listByUser(userId);
    expect(all.filter((r) => r.id === subshellId).length).toBe(1);

    // The retired runtime node stays as history (documented decision): the
    // old row is still there, offline, and never adopted anything back.
    expect(await nodesRepo.findById(a.runtimeNodeId)).toBeDefined();
    expect((await nodesRepo.findById(a.runtimeNodeId))?.status).toBe("offline");
  });

  test("idempotent across generations: die, reopen, adopt the same id again with a fresh rotation", async () => {
    const a = await mkSession(`i-a-${crypto.randomUUID().slice(0, 8)}`);
    const { subshellId } = await sessionLaunchTerminal(a.id, userId, { cwd: "/home/dst/work" });
    cleanupPanes.push(subshellId);
    a.markLost("child-lost");
    await waitUntil(async () => (await subshellsRepo.findById(subshellId))?.alive === 0, "first settle");

    const b = await mkSession(`i-b-${crypto.randomUUID().slice(0, 8)}`);
    censusRows = [{ subshellId, alive: true, exitCode: null }];
    censusRefusal = null;
    const s1 = await adoptReconciledPanes(b);
    expect(s1.adopted).toEqual([subshellId]);
    const keyOnB = (await subshellsRepo.findById(subshellId))?.apiKeyId;

    // B dies too (mid-life loss after a successful adopt): the row returns to
    // the settled reading through the REAL hooks.
    b.markLost("child-lost");
    await waitUntil(async () => (await subshellsRepo.findById(subshellId))?.alive === 0, "second settle");
    expect((await subshellsRepo.findById(subshellId))?.nodeId).toBe(b.runtimeNodeId); // history says B

    const c = await mkSession(`i-c-${crypto.randomUUID().slice(0, 8)}`);
    const s2 = await adoptReconciledPanes(c);
    expect(s2.adopted, "C's candidate set spans BOTH dead generations").toEqual([subshellId]);
    expect((await subshellsRepo.findById(subshellId))?.nodeId).toBe(c.runtimeNodeId);
    expect((await subshellsRepo.findById(subshellId))?.apiKeyId).not.toBe(keyOnB); // rotated again
    expect(c.paneToken(subshellId)).toBeTypeOf("string");

    // Running the same census once more on the LIVE C adopts nothing (the row
    // now lives on C's own active node - never a candidate) and cannot
    // duplicate: the id's row count stays one.
    const s3 = await adoptReconciledPanes(c);
    expect(s3.adopted).toEqual([]);
    const all = await subshellsRepo.listByUser(userId);
    expect(all.filter((r) => r.id === subshellId).length).toBe(1);
  });

  test("a refused census changes nothing; a foreign destination is never touched", async () => {
    const a = await mkSession(`r-a-${crypto.randomUUID().slice(0, 8)}`);
    const { subshellId } = await sessionLaunchTerminal(a.id, userId, { cwd: "/home/dst/work" });
    cleanupPanes.push(subshellId);
    a.markLost("child-lost");
    await waitUntil(async () => (await subshellsRepo.findById(subshellId))?.alive === 0, "settle");
    const rowBefore = await subshellsRepo.findById(subshellId);

    // Census refused (an unreachable/dumb runtime): honest skip, rows stay
    // exactly as the settle wrote them.
    const b = await mkSession(`r-b-${crypto.randomUUID().slice(0, 8)}`);
    censusRefusal = "unsupported";
    const summary = await adoptReconciledPanes(b);
    expect(summary.skipped).toBe("census-failed");
    expect(summary.adopted).toEqual([]);
    const afterRefusal = await subshellsRepo.findById(subshellId);
    expect(afterRefusal?.nodeId).toBe(rowBefore?.nodeId);
    expect(afterRefusal?.alive).toBe(0);

    // A different destination (same owner, other host) keeps its own dead
    // rows out of this reconcile: candidate matching is on host/port/user.
    const foreign = await mkSession(`r-f-${crypto.randomUUID().slice(0, 8)}`, { host: "10.0.0.9" });
    const foreignPane = await seedRowOnNode(foreign.runtimeNodeId, { alive: 1, withToken: true });
    censusRefusal = null;
    censusRows = [{ subshellId, alive: true, exitCode: null }];
    const c = await mkSession(`r-c-${crypto.randomUUID().slice(0, 8)}`);
    const s = await adoptReconciledPanes(c);
    expect(s.adopted, "only THIS destination's rows are candidates").toEqual([subshellId]);
    expect((await subshellsRepo.findById(foreignPane))?.nodeId).toBe(foreign.runtimeNodeId);
  });
});

describe("re-adopt: the race seams (MINOR-1 death mid-walk, MINOR-2 concurrent reopens)", () => {
  /**
   * MINOR-1, seam one: the session dies WHILE the walk's conditional flip is
   * in flight. The fixture flips `markLost` the moment the walk issues its
   * first `updateTable("subshells")` (the flip's builder) - the acceptance
   * review's shape, where `settleLost` takes its pane snapshot AFTER its DB
   * awaits and here races past a row that was never registered. Without the
   * post-flip re-check the walk would mint onto the dead session and leave
   * `alive: 1` + a live token behind; with it, the flipped row settles down.
   */
  test("death during the flip: the claimed row ends alive:0, token revoked, unregistered", async () => {
    // A destination of its OWN: the candidate set must hold exactly this
    // scenario's rows, not the shared-destination leftovers of the tests above.
    const host = { host: "10.77.1.1" };
    const a = await mkSession(`m1-a-${crypto.randomUUID().slice(0, 8)}`, host);
    // A boot-sweep-shaped leftover: alive:1, token LIVE, never registered
    // with any session - exactly the row `settleLost` can never see.
    const rowId = await seedRowOnNode(a.runtimeNodeId, { alive: 1, withToken: true });
    a.markLost("child-lost");
    await waitUntil(async () => (await sessionsRepo.findById(a.id))?.status === "lost", "A settles lost");

    const b = await mkSession(`m1-b-${crypto.randomUUID().slice(0, 8)}`, host);
    censusRows = [{ subshellId: rowId, alive: true, exitCode: null }];
    censusRefusal = null;

    const dbHandle = db as unknown as { updateTable: (table: string) => unknown };
    const realUpdateTable = dbHandle.updateTable;
    let armed = true;
    dbHandle.updateTable = (table: string) => {
      if (armed && table === "subshells") {
        armed = false;
        b.markLost("child-lost"); // the SSH child dies mid-reconcile
      }
      return realUpdateTable.call(db, table);
    };
    let summary: AdoptSummary;
    try {
      summary = await adoptReconciledPanes(b);
    } finally {
      delete (db as unknown as Record<string, unknown>).updateTable; // restore the prototype method
    }

    expect(summary.adopted, "a flipped-then-dead row is not an adoption").toEqual([]);
    expect(summary.settledDead).toEqual([rowId]);
    expect(summary.skipped).toBe("session-inactive");
    const row = await subshellsRepo.findById(rowId);
    expect(row?.alive).toBe(0); // never: alive:1 on a settled session
    expect(row?.nodeId).toBe(b.runtimeNodeId); // the flip landed; the next open's candidate set sees it
    expect(row?.apiKeyId, "the seed's live token is revoked by the walk").toBeTruthy();
    expect(keyEnabled(row?.apiKeyId as string)).toBe(0);
    expect(b.paneToken(rowId)).toBeUndefined();
  });

  /**
   * MINOR-1, seam two: the session dies WHILE the token rotation is in
   * flight (after the flip, after registration is due). The fixture flips
   * `markLost` inside the walk's first `findById` of the row - the read
   * `revokeSubshellToken` performs before the re-mint - so the rotation
   * completes against a session that is already lost: the just-minted token
   * is the one that must die, and the registration must not survive.
   */
  test("death during the rotation: the row ends alive:0 with the ROTATED token revoked", async () => {
    const host = { host: "10.77.2.1" };
    const a = await mkSession(`m2-a-${crypto.randomUUID().slice(0, 8)}`, host);
    const rowId = await seedRowOnNode(a.runtimeNodeId, { alive: 1, withToken: true });
    a.markLost("child-lost");
    await waitUntil(async () => (await sessionsRepo.findById(a.id))?.status === "lost", "A settles lost");

    const b = await mkSession(`m2-b-${crypto.randomUUID().slice(0, 8)}`, host);
    censusRows = [{ subshellId: rowId, alive: true, exitCode: null }];
    censusRefusal = null;

    const realFindById = SubshellsRepository.prototype.findById;
    let armed = true;
    SubshellsRepository.prototype.findById = async function (this: SubshellsRepository, id: string) {
      if (armed && id === rowId) {
        armed = false;
        b.markLost("child-lost"); // dies between the flip and the re-mint
      }
      return realFindById.call(this, id);
    };
    let summary: AdoptSummary;
    try {
      summary = await adoptReconciledPanes(b);
    } finally {
      SubshellsRepository.prototype.findById = realFindById;
    }

    expect(summary.adopted, "a rotated-then-dead row is not an adoption").toEqual([]);
    expect(summary.settledDead).toEqual([rowId]);
    expect(summary.skipped).toBe("session-inactive");
    const row = await subshellsRepo.findById(rowId);
    expect(row?.alive).toBe(0);
    expect(row?.nodeId).toBe(b.runtimeNodeId);
    // The rotation DID land on the row (a fresh key id, not the seed's) - and
    // it is exactly that key the walk's re-check revoked, because the pane
    // registered with a session that had just died.
    expect(row?.apiKeyId).toBeTruthy();
    expect(keyEnabled(row?.apiKeyId as string)).toBe(0);
    expect(b.paneToken(rowId)).toBeUndefined();
  });

  /**
   * MINOR-2: two reopens of one destination run their reconcile concurrently
   * over the same survivor. The flip is conditional on the settled node the
   * walker snapshotted from, so exactly one walk moves the row; the loser
   * stands down BEFORE touching the token (a revoke-first loser would kill
   * the winner's just-rotated key) and registers nothing.
   */
  test("concurrent reopens claim one survivor exactly once", async () => {
    const host = { host: "10.77.3.1" };
    const a = await mkSession(`c-a-${crypto.randomUUID().slice(0, 8)}`, host);
    const { subshellId } = await sessionLaunchTerminal(a.id, userId, { cwd: "/home/dst/work" });
    cleanupPanes.push(subshellId);
    const keyBefore = (await subshellsRepo.findById(subshellId))?.apiKeyId;
    a.markLost("child-lost");
    await waitUntil(async () => (await subshellsRepo.findById(subshellId))?.alive === 0, "A settles");

    const b = await mkSession(`c-b-${crypto.randomUUID().slice(0, 8)}`, host);
    const c = await mkSession(`c-c-${crypto.randomUUID().slice(0, 8)}`, host);
    censusRows = [{ subshellId, alive: true, exitCode: null }];
    censusRefusal = null;

    const [sB, sC] = await Promise.all([adoptReconciledPanes(b), adoptReconciledPanes(c)]);

    const bWon = sB.adopted.includes(subshellId);
    const cWon = sC.adopted.includes(subshellId);
    expect(Number(bWon) + Number(cWon), "exactly one reopen adopts the survivor").toBe(1);
    const winner = bWon ? b : c;
    const loser = bWon ? c : b;
    const loserSummary = bWon ? sC : sB;
    // The loser stands down without recording or touching anything (or its
    // candidate snapshot simply never included the row - both are silence).
    expect(loserSummary.adopted).toEqual([]);
    expect(loserSummary.settledDead).toEqual([]);

    const row = await subshellsRepo.findById(subshellId);
    expect(row?.nodeId, "single-parented").toBe(winner.runtimeNodeId);
    expect(row?.alive).toBe(1);
    expect(row?.apiKeyId).not.toBe(keyBefore); // the winner rotated on the same row
    expect(keyEnabled(row?.apiKeyId as string), "the loser revoked nothing").toBe(1);
    expect(winner.paneToken(subshellId)).toBeTypeOf("string");
    expect(loser.paneToken(subshellId), "the loser registered nothing").toBeUndefined();
    // No duplicates: one row per id across the whole owner.
    const all = await subshellsRepo.listByUser(userId);
    expect(all.filter((r) => r.id === subshellId).length).toBe(1);
  });
});
