import { beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { ensureMigratedTestDb } from "@/__tests__/helpers/test-database.js";
import { db } from "@/db/index.js";
import { NodesRepository } from "@/db/repositories/nodes.repository.js";
import { SubshellsRepository } from "@/db/repositories/subshells.repository.js";
import { resetNodeRegistryForTests } from "@/services/nodes/node-registry.js";
import { SshConnectionsRepository } from "@/services/ssh/ssh-connections.repository.js";
import { sshListConnections } from "@/services/ssh/ssh-connections.service.js";
import { SshGrantsRepository } from "@/services/ssh/ssh-grants.repository.js";
import type { SshCaller } from "@/services/ssh/ssh-policy.js";
import { sshRetentionWindowMs, sweepExpiredSshRuns } from "@/services/ssh/ssh-retention.js";
import { SshRunsRepository } from "@/services/ssh/ssh-runs.repository.js";
import { sshRunStart } from "@/services/ssh/ssh-runs.service.js";
import { attachScriptedNode, type ScriptedNode } from "@/test-helpers/scripted-node.js";
import { facts } from "@/test-helpers/ssh-fixtures.js";

/**
 * Retention + the pane-arm service projections (the granted-pane flows the
 * REST doors cannot reach until Gate B adds the `ssh` scope to the mint map:
 * these call the SAME service functions behind those routes with a synthetic
 * caller, which is what the Gate-B integration will exercise end to end).
 *
 * Retention posture pinned here: only TERMINAL rows past the window go;
 * active rows are never swept (the pane-log hygiene invariant moved to rows);
 * a run whose NODE was deleted settles to `unknown` rather than staying
 * `accepted` forever against a machine that no longer exists; and the env
 * window treats junk as the frozen default, never as "delete now".
 */

const OWNER = "ret-owner";
const NODE = "ret-node";
const snapshotJson = JSON.stringify({
  alias: "a",
  host: "h.example.net",
  user: null,
  port: 22,
  identityFiles: [],
  certificateFiles: [],
  authAgentSocket: null,
  knownHostsFiles: [],
  hostKeyAlias: null,
  proxyJumps: [],
  proxyCommand: null,
  forwards: null,
  tunnels: null,
  localCommands: null,
  remoteCommand: null,
  sendEnv: null,
  setEnv: null,
  escapes: null,
});

const runs = new SshRunsRepository(db);
const connections = new SshConnectionsRepository(db);
const grants = new SshGrantsRepository(db);
const subshells = new SubshellsRepository(db);
const nodes = new NodesRepository(db);

function paneCaller(id: string, key: string, userId = OWNER): SshCaller {
  return { actor: "subshell-key", userId, principal: `sess:${id}`, apiKeyId: key, subshellId: id, isAdmin: false };
}

async function seedRun(over: {
  id: string;
  nodeId?: string | null;
  status?: "accepted" | "running" | "completed" | "unknown";
  finishedDaysAgo?: number;
  connectionId?: string | null;
}) {
  const finished =
    over.finishedDaysAgo !== undefined ? new Date(Date.now() - over.finishedDaysAgo * 86_400_000).toISOString() : null;
  await runs.create({
    id: over.id,
    userId: OWNER,
    nodeId: over.nodeId === undefined ? NODE : over.nodeId,
    connectionId: over.connectionId === undefined ? null : over.connectionId,
    connectionRevision: 1,
    configSnapshot: snapshotJson,
    initiatedBy: "human",
    grantId: null,
    apiKeyId: null,
    command: "true",
    remoteDir: null,
    requestDigest: "d",
    deadlineMs: 60_000,
    status: over.status ?? "completed",
    cancelRequested: 0,
    cancelLocalConfirmed: 0,
    deadlineHit: 0,
    remoteStatus: null,
    remoteStatusConfirmed: 0,
    localExitCode: null,
    localExitSignal: null,
    startedAt: null,
    finishedAt: finished,
  });
}

describe("ssh retention + granted-pane projections", () => {
  let scripted: ScriptedNode;

  beforeAll(async () => {
    await ensureMigratedTestDb();
    await nodes.create({ id: NODE, ownerUserId: OWNER, name: "ret", kind: "agent", status: "online" });
  });

  beforeEach(() => {
    resetNodeRegistryForTests();
    scripted = attachScriptedNode(NODE, {
      ssh_run_start: (cmd) =>
        cmd.type === "ssh_run_start" ? facts({ runId: cmd.runId, lifecycle: "accepted" }) : new Error("nope"),
    });
  });

  it("defaults the window to the frozen 7 days and reads SSH_RUN_RETENTION_DAYS (0 = keep forever, junk = default)", () => {
    expect(sshRetentionWindowMs("")).toBe(7 * 86_400_000);
    expect(sshRetentionWindowMs("14")).toBe(14 * 86_400_000);
    expect(Number.isFinite(sshRetentionWindowMs("0"))).toBe(false);
    expect(sshRetentionWindowMs("-3")).toBe(7 * 86_400_000);
    expect(sshRetentionWindowMs("nonsense")).toBe(7 * 86_400_000);
  });

  it("sweeps only terminal rows past the window; active rows and fresh history stay", async () => {
    await seedRun({ id: "old-done", status: "completed", finishedDaysAgo: 8 });
    await seedRun({ id: "fresh-done", status: "completed", finishedDaysAgo: 1 });
    await seedRun({ id: "still-running", status: "running", finishedDaysAgo: 30 });
    const swept = await sweepExpiredSshRuns(new Date(), 7 * 86_400_000);
    expect(swept.deleted).toBe(1);
    expect(await runs.findById("old-done")).toBeUndefined();
    expect(await runs.findById("fresh-done")).toBeDefined();
    expect(await runs.findById("still-running")).toBeDefined();
  });

  it("folds resolved terminal-exec rows into the same pass; outstanding rows never age out (I6)", async () => {
    // Every exec_in_terminal inserts a durable row with up to a 256 KiB output
    // tail; before I6 nothing deleted it except the pane's own cascade, so the
    // table grew without bound. The resolved half now shares the run window.
    const paneId = crypto.randomUUID();
    await subshells.create({
      id: paneId,
      userId: OWNER,
      harnessId: "terminal",
      name: paneId,
      workingDir: "/srv",
      nodeId: NODE,
      status: "running",
      alive: 1,
      tmuxSocket: `sock-${crypto.randomUUID()}`,
      presetId: null,
    });
    const daysAgo = (n: number): string => new Date(Date.now() - n * 86_400_000).toISOString();
    const seedExec = (
      id: string,
      state: "completed" | "unknown" | "outstanding",
      created: string,
      resolved: string | null,
    ) =>
      db
        .insertInto("sshTerminalExecs")
        .values({
          id,
          subshellId: paneId,
          paneIncarnation: "2026-01-01T00:00:00.000Z",
          initiatedBy: "human",
          grantId: null,
          apiKeyId: null,
          inputGeneration: 1,
          markerToken: id.replace(/-/g, "").slice(0, 16),
          state,
          exitCode: state === "completed" ? 0 : null,
          output: state === "outstanding" ? null : "tail",
          outputTruncated: 0,
          nextByte: null,
          createdAt: created,
          resolvedAt: resolved,
        })
        .execute();
    await seedExec("exec-old-done", "completed", daysAgo(9), daysAgo(9));
    await seedExec("exec-old-unknown", "unknown", daysAgo(9), daysAgo(8));
    await seedExec("exec-old-no-stamp", "completed", daysAgo(9), null); // predates resolved_at stamping -> ages on created_at
    await seedExec("exec-fresh-done", "completed", daysAgo(1), daysAgo(1));
    await seedExec("exec-still-outstanding", "outstanding", daysAgo(60), null); // NEVER swept

    const swept = await sweepExpiredSshRuns(new Date(), 7 * 86_400_000);
    expect(swept.execsSwept).toBe(3);
    const remaining = await db.selectFrom("sshTerminalExecs").select("id").where("subshellId", "=", paneId).execute();
    expect(remaining.map((r) => r.id).sort()).toEqual(["exec-fresh-done", "exec-still-outstanding"]);

    // `keep forever` (window Infinity) sweeps NOTHING, resolved included:
    await sweepExpiredSshRuns(new Date(), Number.POSITIVE_INFINITY);
    const afterForever = await db
      .selectFrom("sshTerminalExecs")
      .select("id")
      .where("subshellId", "=", paneId)
      .execute();
    expect(afterForever).toHaveLength(2);

    await db.deleteFrom("subshells").where("id", "=", paneId).execute(); // cascades the rest
  });

  it("settles runs whose node was deleted to unknown (the orphan can never be asked again)", async () => {
    await seedRun({ id: "orphan", status: "accepted", nodeId: null });
    const swept = await sweepExpiredSshRuns(new Date(), Number.POSITIVE_INFINITY);
    expect(swept.orphaned).toBe(1);
    const row = await runs.findById("orphan");
    expect(row?.status).toBe("unknown");
    expect(row?.finishedAt).not.toBeNull();
  });

  describe("granted-pane service projections", () => {
    async function makePaneConn(
      over: { key: string; grantRevision?: number; connRevision?: number; revoked?: boolean } = { key: "k" },
    ) {
      const conn = await connections.create({
        id: crypto.randomUUID(),
        userId: OWNER,
        nodeId: NODE,
        displayName: "P",
        configSnapshot: snapshotJson,
        remoteDir: null,
        revision: over.connRevision,
      });
      const paneId = crypto.randomUUID();
      await subshells.create({
        id: paneId,
        userId: OWNER,
        harnessId: "claude-code",
        name: paneId,
        workingDir: "/srv",
        nodeId: NODE,
        status: "running",
        alive: 1,
        tmuxSocket: `sock-${crypto.randomUUID()}`,
        presetId: null,
      });
      await subshells.update(paneId, { apiKeyId: over.key });
      const grant = await grants.create({
        id: crypto.randomUUID(),
        connectionId: conn.id,
        connectionRevision: over.grantRevision ?? over.connRevision ?? 1,
        subshellId: paneId,
        apiKeyId: over.key,
        grantedByUserId: OWNER,
        revokedAt: null,
      });
      if (over.revoked) await grants.revokeById(grant.id);
      return { conn, paneId };
    }

    it("lists ONLY active-grant, current-key, current-revision connections for a pane", async () => {
      const good = await makePaneConn({ key: "kg" });
      const mismatched = await makePaneConn({ key: "km", connRevision: 2, grantRevision: 1 });
      const revoked = await makePaneConn({ key: "kr", revoked: true });
      const view = await sshListConnections(paneCaller(good.paneId, "kg"));
      expect(view.connections.map((c) => c.id)).toEqual([good.conn.id]);
      // A pane whose key moved sees NOTHING (the grants pinned the old key):
      const stale = await sshListConnections(paneCaller(good.paneId, "kg-rotated"));
      expect(stale.connections).toHaveLength(0);
      void mismatched;
      void revoked;
    });

    it("starts a run through the granted arm, then stops it when the key rotates mid-life", async () => {
      const { conn, paneId } = await makePaneConn({ key: "ks" });
      const view = await sshRunStart(paneCaller(paneId, "ks"), { connectionId: conn.id, command: "uptime" });
      expect(view.initiatedBy).toBe("agent");
      const frame = scripted.cmdsOf("ssh_run_start").at(-1);
      expect(frame?.runId).toBe(view.id);
      // Rotate the pane's key (the restart fact): the new credential inherits
      // nothing, the old credential's presenting use is `token_stale`.
      await subshells.update(paneId, { apiKeyId: "ks-new" });
      const refusal = async (fn: () => Promise<unknown>) =>
        (
          (await fn().catch((err: { metadataSafe?: { sshCode?: string } }) => err)) as {
            metadataSafe?: { sshCode?: string };
          }
        ).metadataSafe?.sshCode;
      expect(
        await refusal(() => sshRunStart(paneCaller(paneId, "ks"), { connectionId: conn.id, command: "uptime" })),
      ).toBe("token_stale");
      expect(
        await refusal(() => sshRunStart(paneCaller(paneId, "ks-new"), { connectionId: conn.id, command: "uptime" })),
      ).toBe("not_granted");
    });
  });
});
