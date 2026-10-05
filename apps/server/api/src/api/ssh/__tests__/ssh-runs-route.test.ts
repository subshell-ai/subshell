import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { hashPassword } from "better-auth/crypto";
import { Elysia } from "elysia";
import { sql } from "kysely";

/**
 * `/api/ssh/runs` + `/api/ssh/terminals` + the revocation/reconcile
 * orchestration, on the route-boot pattern with the scripted node as the
 * connecting machine. The rules this suite pins:
 *
 * - Start allocates the run id SERVER-side, binds the digest, writes the
 *   mirror BEFORE the frame, and answers promptly; the frame the node sees is
 *   the frozen command body (id, snapshot, digest).
 * - A named node refusal on start (`run_conflict`, `quota_runs`) rolls the
 *   never-accepted mirror back and answers the named code; a transport
 *   failure leaves the row `accepted` for reconciliation (no automatic
 *   replay is asserted by the reconcile test below).
 * - Output reads RELAY the node's window (the plane stores metadata only),
 *   fold the facts into the mirror, and never cancel on close or wait-out;
 *   an offset past retention answers `cursorExpired`.
 * - Cancel records locally, relays best-effort; offline the request stays
 *   pending and `reconcileSshNode` dispatches it BEFORE new work.
 * - Revocation cancels the runs initiated under THAT grant only - never a
 *   human's, never another grant's (spec §2 by name).
 * - Terminals: quota 4 per owner per node, refused while the connecting node
 *   is offline, and the pane row + ssh_panes marker land together.
 * - Command text and output stay out of audit metadata.
 */
import { sshRoutes } from "@/api/ssh/index.js";
import { db } from "@/db/index.js";
import { NodesRepository } from "@/db/repositories/nodes.repository.js";
import { SubshellsRepository } from "@/db/repositories/subshells.repository.js";
import { UsersRepository } from "@/db/repositories/users.repository.js";
import { errorHandlerPlugin } from "@/plugins/error-handler.plugin.js";
import { getLive, resetNodeRegistryForTests } from "@/services/nodes/node-registry.js";
import { ensureLocalNode } from "@/services/nodes/seed-local.js";
import { SshConnectionsRepository } from "@/services/ssh/ssh-connections.repository.js";
import { SshGrantsRepository } from "@/services/ssh/ssh-grants.repository.js";
import { sshRevoke } from "@/services/ssh/ssh-grants.service.js";
import { SshPanesRepository } from "@/services/ssh/ssh-panes.repository.js";
import type { SshCaller } from "@/services/ssh/ssh-policy.js";
import { getSshPolicy } from "@/services/ssh/ssh-policy-impl.js";
import { reconcileSshNode } from "@/services/ssh/ssh-reconcile.js";
import { SshRunsRepository } from "@/services/ssh/ssh-runs.repository.js";
import { sshRunStart } from "@/services/ssh/ssh-runs.service.js";
import { sshControlTransition } from "@/services/ssh/ssh-terminals.service.js";
import { attachScriptedNode, ok, type ScriptedNode } from "@/test-helpers/scripted-node.js";
import { facts, readResult, SNAPSHOT } from "@/test-helpers/ssh-fixtures.js";
import { deleteUserByEmailOrId, setupAuthTables, signIn } from "../../__tests__/helpers/auth-tables.js";

const app = new Elysia().use(errorHandlerPlugin).use(sshRoutes);

const nodes = new NodesRepository(db);
const subshells = new SubshellsRepository(db);
const connections = new SshConnectionsRepository(db);
const grants = new SshGrantsRepository(db);
const panes = new SshPanesRepository(db);
const runs = new SshRunsRepository(db);

const ownerEmail = `ssh-run-${crypto.randomUUID()}@subshell.local`;
const pw = "sshrun-pass-1";
let ownerId: string;
let ownerCookie: string;
let node: string;

/** Mutable node-side answers the tests bend per case. */
const behavior = {
  startRefusal: null as string | null,
  readRefusal: null as string | null,
  statusRefusal: null as string | null,
};
let scripted: ScriptedNode;

async function sshFetch(path: string, init: RequestInit, opts: { cookie?: string } = {}) {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json");
  headers.set("origin", "http://localhost:3080");
  if (opts.cookie) headers.set("cookie", `better-auth.session_token=${opts.cookie}`);
  return app.fetch(new Request(`http://localhost:3080${path}`, { ...init, headers }));
}

function humanCaller(): SshCaller {
  return {
    actor: "cookie",
    userId: ownerId,
    principal: `user:${ownerId}`,
    apiKeyId: null,
    subshellId: null,
    isAdmin: false,
  };
}

async function makeConnection(displayName = "Staging") {
  return await connections.create({
    id: crypto.randomUUID(),
    userId: ownerId,
    nodeId: node,
    displayName,
    configSnapshot: JSON.stringify(SNAPSHOT),
    remoteDir: null,
  });
}

/** Direct mirror rows (the REST arm would have to survive real dispatch). */
async function seedRun(over: {
  id: string;
  connectionId: string;
  initiatedBy: "human" | "agent";
  grantId: string | null;
  apiKeyId: string | null;
  status?: "accepted" | "running" | "completed";
}) {
  await runs.create({
    id: over.id,
    userId: ownerId,
    nodeId: node,
    connectionId: over.connectionId,
    connectionRevision: 1,
    configSnapshot: JSON.stringify(SNAPSHOT),
    initiatedBy: over.initiatedBy,
    grantId: over.grantId,
    apiKeyId: over.apiKeyId,
    command: `echo marker-${over.id}`,
    remoteDir: null,
    requestDigest: `dig-${over.id}`,
    deadlineMs: 60_000,
    status: over.status ?? "running",
    cancelRequested: 0,
    cancelLocalConfirmed: 0,
    deadlineHit: 0,
    remoteStatus: null,
    remoteStatusConfirmed: 0,
    localExitCode: null,
    localExitSignal: null,
    startedAt: null,
    finishedAt: null,
  });
}

describe("/api/ssh runs + terminals + revocation (spec 2026-10-04 §3)", () => {
  beforeAll(async () => {
    await setupAuthTables();
    resetNodeRegistryForTests();
    await ensureLocalNode(db);
    const users = new UsersRepository(db);
    ownerId = await users.createUser({
      email: ownerEmail,
      name: ownerEmail,
      passwordHash: await hashPassword(pw),
      role: "user",
    });
    ownerCookie = await signIn(ownerEmail, pw);
    node = crypto.randomUUID();
    await nodes.create({
      id: node,
      ownerUserId: ownerId,
      name: `r-${node.slice(0, 8)}`,
      kind: "agent",
      status: "online",
    });
    scripted = attachScriptedNode(node, {
      ssh_run_start: (cmd) => {
        if (cmd.type !== "ssh_run_start") return new Error("wrong cmd");
        if (behavior.startRefusal) throw new Error(behavior.startRefusal);
        return facts({ runId: cmd.runId, lifecycle: "accepted" });
      },
      ssh_run_status: (cmd) => {
        if (cmd.type !== "ssh_run_status") return new Error("wrong cmd");
        if (behavior.statusRefusal) throw new Error(behavior.statusRefusal);
        return facts({
          runId: cmd.runId,
          lifecycle: "completed",
          remoteStatus: 0,
          remoteStatusConfirmed: true,
          localExitCode: 0,
        });
      },
      ssh_run_read: (cmd) => {
        if (cmd.type !== "ssh_run_read") return new Error("wrong cmd");
        if (behavior.readRefusal) throw new Error(behavior.readRefusal);
        return readResult(cmd.runId, {
          stdoutB64: Buffer.from("remote says hi\n").toString("base64"),
          stdoutTotal: 15,
          lifecycle: "completed",
          remoteStatus: 0,
          remoteStatusConfirmed: true,
          localExitCode: 0,
        });
      },
      ssh_run_cancel: (cmd) =>
        cmd.type === "ssh_run_cancel"
          ? facts({
              runId: cmd.runId,
              cancelRequested: true,
              cancelLocalConfirmed: true,
              lifecycle: "completed",
              remoteStatus: null,
            })
          : new Error("wrong cmd"),
      ssh_terminal_launch: ok,
      ssh_input_control: (cmd) =>
        cmd.type === "ssh_input_control"
          ? { subshellId: cmd.subshellId, mode: cmd.mode, generation: cmd.generation }
          : new Error("wrong cmd"),
    });
  });

  afterAll(() => {
    scripted.detach();
    resetNodeRegistryForTests();
    void deleteUserByEmailOrId(ownerEmail);
  });

  describe("start", () => {
    it("allocates the id server-side, binds the digest, and answers the accepted mirror", async () => {
      const conn = await makeConnection();
      const res = await sshFetch(
        "/api/ssh/runs",
        { method: "POST", body: JSON.stringify({ connectionId: conn.id, command: "uptime" }) },
        { cookie: ownerCookie },
      );
      expect(res.status).toBe(200);
      const view = (await res.json()) as { id: string; status: string; initiatedBy: string; command: string };
      expect(view.status).toBe("accepted"); // facts said accepted; the mirror mirrors it
      expect(view.initiatedBy).toBe("human");
      const frame = scripted.cmdsOf("ssh_run_start").at(-1);
      expect(frame).toBeDefined();
      expect(frame?.runId).toBe(view.id);
      expect(frame?.requestDigest).toMatch(/^[0-9a-f]{64}$/);
      expect(frame?.command).toBe("uptime");
      const row = await runs.findById(view.id);
      expect(row?.configSnapshot).toBe(JSON.stringify(SNAPSHOT));
    });

    it("rolls the mirror back and names the code when the node refuses the start", async () => {
      const conn = await makeConnection();
      behavior.startRefusal = "run_conflict";
      const res = await sshFetch(
        "/api/ssh/runs",
        { method: "POST", body: JSON.stringify({ connectionId: conn.id, command: "true" }) },
        { cookie: ownerCookie },
      );
      behavior.startRefusal = null;
      expect(res.status).toBe(409);
      expect(await res.text()).toContain("run_conflict");
      const left = await runs.listRecentByOwner(ownerId, 50);
      expect(left.filter((r) => r.connectionId === conn.id && r.status === "accepted")).toHaveLength(0);
    });

    it("refuses at the frozen quotas before a frame moves", async () => {
      const conn = await makeConnection();
      for (let i = 0; i < 4; i += 1) {
        await seedRun({
          id: `q-${conn.id}-${i}`,
          connectionId: conn.id,
          initiatedBy: "human",
          grantId: null,
          apiKeyId: null,
        });
      }
      const res = await sshFetch(
        "/api/ssh/runs",
        { method: "POST", body: JSON.stringify({ connectionId: conn.id, command: "true" }) },
        { cookie: ownerCookie },
      );
      expect(res.status).toBe(409);
      expect(await res.text()).toContain("quota_runs");
      // Clear the quota block for the suites that follow (they need their own
      // dispatches; these rows exist only to hold the count at the ceiling).
      await db
        .updateTable("sshRuns")
        .set({ status: "completed", finishedAt: new Date().toISOString() })
        .where("id", "like", `q-${conn.id}%`)
        .execute();
    });
  });

  describe("read + cancel", () => {
    it("relays the window, folds the facts, and answers cursorExpired for dead cursors", async () => {
      const conn = await makeConnection();
      const run = await sshRunStart(humanCaller(), { connectionId: conn.id, command: "hello" });
      const out = await sshFetch(`/api/ssh/runs/${run.id}/output`, { method: "GET" }, { cookie: ownerCookie });
      expect(out.status).toBe(200);
      const body = (await out.json()) as {
        stdout: string;
        stdoutTotal: number;
        cursorExpired: boolean;
        run: { status: string; remoteStatusConfirmed: boolean };
      };
      expect(body.stdout).toBe("remote says hi\n");
      expect(body.cursorExpired).toBe(false);
      expect(body.run.status).toBe("completed"); // the folded facts are current at answer time
      expect(body.run.remoteStatusConfirmed).toBe(true);
      const stale = await sshFetch(
        `/api/ssh/runs/${run.id}/output?stdoutFromByte=999`,
        { method: "GET" },
        { cookie: ownerCookie },
      );
      expect(((await stale.json()) as { cursorExpired: boolean }).cursorExpired).toBe(true);
    });

    it("settles a run the node no longer knows to unknown - never failed, never completed", async () => {
      const conn = await makeConnection();
      await seedRun({
        id: `lost-${conn.id}`,
        connectionId: conn.id,
        initiatedBy: "human",
        grantId: null,
        apiKeyId: null,
        status: "running",
      });
      behavior.readRefusal = "run_unknown";
      const out = await sshFetch(`/api/ssh/runs/lost-${conn.id}/output`, { method: "GET" }, { cookie: ownerCookie });
      behavior.readRefusal = null;
      expect(out.status).toBe(200);
      const body = (await out.json()) as { run: { status: string }; cursorExpired: boolean };
      expect(body.run.status).toBe("unknown");
      expect(body.cursorExpired).toBe(true);
    });

    it("records the cancel locally, relays it, and keeps it PENDING while the node is offline", async () => {
      const conn = await makeConnection();
      await seedRun({
        id: `cx-${conn.id}`,
        connectionId: conn.id,
        initiatedBy: "human",
        grantId: null,
        apiKeyId: null,
      });
      const res = await sshFetch(
        `/api/ssh/runs/cx-${conn.id}/cancel`,
        { method: "POST", body: "{}" },
        { cookie: ownerCookie },
      );
      expect(res.status).toBe(200);
      expect(
        ((await res.json()) as { cancelRequested: boolean; cancelLocalConfirmed: boolean }).cancelLocalConfirmed,
      ).toBe(true);
      expect(scripted.cmdsOf("ssh_run_cancel").some((c) => c.runId === `cx-${conn.id}`)).toBe(true);

      // Offline: the request stands, nothing dispatches, the reconnect pass sends it FIRST.
      const conn2 = await makeConnection("Offline target");
      await seedRun({
        id: `cx-${conn2.id}`,
        connectionId: conn2.id,
        initiatedBy: "human",
        grantId: null,
        apiKeyId: null,
      });
      scripted.detach();
      expect(getLive(node)).toBeUndefined();
      const pending = await sshFetch(
        `/api/ssh/runs/cx-${conn2.id}/cancel`,
        { method: "POST", body: "{}" },
        { cookie: ownerCookie },
      );
      expect(pending.status).toBe(200);
      const pendBody = (await pending.json()) as { cancelRequested: boolean; cancelLocalConfirmed: boolean };
      expect(pendBody).toMatchObject({ cancelRequested: true, cancelLocalConfirmed: false });

      const back = attachScriptedNode(node, {
        ssh_run_cancel: (cmd) =>
          cmd.type === "ssh_run_cancel"
            ? facts({ runId: cmd.runId, cancelRequested: true, cancelLocalConfirmed: true })
            : new Error("wrong cmd"),
      });
      await reconcileSshNode(node);
      expect(back.cmdsOf("ssh_run_cancel").map((c) => c.runId)).toContain(`cx-${conn2.id}`);
      const row = await runs.findById(`cx-${conn2.id}`);
      expect(row?.cancelLocalConfirmed).toBe(1);
      back.detach();
      scripted = attachScriptedNode(node, {
        ssh_run_start: () => facts({ runId: "unused" }),
        ssh_run_status: () => facts({ runId: "unused" }),
        ssh_run_cancel: () => facts({ runId: "unused" }),
      });
    });

    it("reconcile settles unknown ids to unknown and re-asserts live pane control", async () => {
      const conn = await makeConnection("Reconcile");
      await seedRun({
        id: `rec-${conn.id}`,
        connectionId: conn.id,
        initiatedBy: "human",
        grantId: null,
        apiKeyId: null,
      });
      behavior.statusRefusal = "run_unknown";
      scripted.detach();
      scripted = attachScriptedNode(node, {
        ssh_run_status: (cmd) => {
          if (cmd.type === "ssh_run_status" && cmd.runId === `rec-${conn.id}`) throw new Error("run_unknown");
          return facts({ runId: cmd.type === "ssh_run_status" ? cmd.runId : "x" });
        },
        ssh_input_control: (cmd) =>
          cmd.type === "ssh_input_control"
            ? { subshellId: cmd.subshellId, mode: cmd.mode, generation: cmd.generation }
            : new Error("wrong cmd"),
      });
      const managed = "rec-pane";
      await subshells.create({
        id: managed,
        userId: ownerId,
        harnessId: "terminal",
        name: "SSH Rec",
        workingDir: "/home/x",
        nodeId: node,
        status: "running",
        alive: 1,
        tmuxSocket: `sock-${crypto.randomUUID()}`,
        presetId: null,
      });
      await panes.create({
        subshellId: managed,
        connectionId: conn.id,
        connectionRevision: 1,
        initiatedBy: "agent",
        grantId: null,
        apiKeyId: "k-rec",
        controlOwner: "human",
        controlGeneration: 5,
        logGeneration: 1,
      });
      await reconcileSshNode(node);
      const row = await runs.findById(`rec-${conn.id}`);
      expect(row?.status).toBe("unknown");
      expect(row?.finishedAt).not.toBeNull();
      expect(
        scripted
          .cmdsOf("ssh_input_control")
          .some((c) => c.subshellId === managed && c.generation === 5 && c.mode === "human"),
      ).toBe(true);
      behavior.statusRefusal = null;
    });
  });

  describe("terminals + control", () => {
    it("creates the pane row + ssh_panes marker in agent control for an agent opener and human control for a human", async () => {
      scripted.detach();
      scripted = attachScriptedNode(node, {
        ssh_terminal_launch: ok,
        ssh_input_control: (cmd) =>
          cmd.type === "ssh_input_control"
            ? { subshellId: cmd.subshellId, mode: cmd.mode, generation: cmd.generation }
            : new Error("wrong cmd"),
      });
      const conn = await makeConnection("Term");
      const res = await sshFetch(
        "/api/ssh/terminals",
        { method: "POST", body: JSON.stringify({ connectionId: conn.id, cols: 100, rows: 30 }) },
        { cookie: ownerCookie },
      );
      expect(res.status).toBe(200);
      const view = (await res.json()) as { subshellId: string; initiatedBy: string; controlOwner: string };
      expect(view).toMatchObject({ initiatedBy: "human", controlOwner: "human" });
      const paneRow = await panes.findBySubshell(view.subshellId);
      expect(paneRow?.connectionId).toBe(conn.id);
      const shell = await subshells.findById(view.subshellId);
      expect(shell?.harnessId).toBe("terminal");
      expect(shell?.status).toBe("running");

      const take = await sshControlTransition(humanCaller(), view.subshellId, { mode: "agent" });
      expect(take.controlGeneration).toBe(2);
      expect(scripted.cmdsOf("ssh_input_control").length).toBe(1);
      // A human never rides the agent arm, but the transition itself moved the
      // state; the gate then refuses agent reads until a human returns it:
      await panes.setControl(view.subshellId, "human");
      const gated = await getSshPolicy().gatePaneSurface({
        caller: {
          actor: "subshell-key",
          userId: ownerId,
          principal: "sess:x",
          apiKeyId: "k",
          subshellId: "x",
          isAdmin: false,
        },
        subshellId: view.subshellId,
        surface: "log",
      });
      expect(gated).toEqual({ allow: false, code: "not_found" }); // no key match - invisible before control
    });

    it("refuses terminal opens while the connecting node is offline and never leaves a row behind", async () => {
      const conn = await makeConnection("Offline term");
      scripted.detach();
      const res = await sshFetch(
        "/api/ssh/terminals",
        { method: "POST", body: JSON.stringify({ connectionId: conn.id }) },
        { cookie: ownerCookie },
      );
      expect(res.status).toBe(403);
      expect(await res.text()).toContain("node_ineligible");
      const list = await panes.listByConnection(conn.id);
      expect(list).toHaveLength(0);
      scripted = attachScriptedNode(node, { ssh_terminal_launch: ok });
      // Quota: four live managed panes refuse the fifth (403 named code).
      for (let i = 0; i < 4; i += 1) {
        const paneId = `tq-${i}`;
        await subshells.create({
          id: paneId,
          userId: ownerId,
          harnessId: "terminal",
          name: "T",
          workingDir: "/home/t",
          nodeId: node,
          status: "running",
          alive: 1,
          tmuxSocket: `sock-${crypto.randomUUID()}`,
          presetId: null,
        });
        await panes.create({
          subshellId: paneId,
          connectionId: conn.id,
          connectionRevision: 1,
          initiatedBy: "human",
          grantId: null,
          apiKeyId: null,
          controlOwner: "human",
          controlGeneration: 1,
          logGeneration: 1,
        });
      }
      const over = await sshFetch(
        "/api/ssh/terminals",
        { method: "POST", body: JSON.stringify({ connectionId: conn.id }) },
        { cookie: ownerCookie },
      );
      expect(over.status).toBe(409);
      expect(await over.text()).toContain("quota_terminals");
    });
  });

  describe("revocation orchestration", () => {
    it("cancels the runs initiated under THAT grant and credential, nothing else", async () => {
      const conn = await makeConnection("Revoke scope");
      const paneA = crypto.randomUUID();
      const paneB = crypto.randomUUID();
      for (const [id, _key] of [
        [paneA, "kA"],
        [paneB, "kB"],
      ] as const) {
        await subshells.create({
          id,
          userId: ownerId,
          harnessId: "claude-code",
          name: id,
          workingDir: "/srv",
          nodeId: node,
          status: "running",
          alive: 1,
          tmuxSocket: `sock-${crypto.randomUUID()}`,
          presetId: null,
        });
      }
      const grantA = await grants.create({
        id: `gA-${conn.id}`,
        connectionId: conn.id,
        connectionRevision: 1,
        subshellId: paneA,
        apiKeyId: "kA",
        grantedByUserId: ownerId,
        revokedAt: null,
      });
      await grants.create({
        id: `gB-${conn.id}`,
        connectionId: conn.id,
        connectionRevision: 1,
        subshellId: paneB,
        apiKeyId: "kB",
        grantedByUserId: ownerId,
        revokedAt: null,
      });
      await seedRun({
        id: `hum-${conn.id}`,
        connectionId: conn.id,
        initiatedBy: "human",
        grantId: null,
        apiKeyId: null,
      });
      await seedRun({
        id: `un-A-${conn.id}`,
        connectionId: conn.id,
        initiatedBy: "agent",
        grantId: grantA.id,
        apiKeyId: "kA",
      });
      await seedRun({
        id: `un-B-${conn.id}`,
        connectionId: conn.id,
        initiatedBy: "agent",
        grantId: `gB-${conn.id}`,
        apiKeyId: "kB",
      });

      const paneCaller: SshCaller = {
        actor: "cookie",
        userId: ownerId,
        principal: `user:${ownerId}`,
        apiKeyId: null,
        subshellId: null,
        isAdmin: false,
      };
      const revoked = await sshRevoke(paneCaller, conn.id, paneA);
      expect(revoked.revoked).toBe(true);

      const cancels = scripted.cmdsOf("ssh_run_cancel").map((c) => c.runId);
      expect(cancels).toContain(`un-A-${conn.id}`);
      expect(cancels).not.toContain(`hum-${conn.id}`);
      expect(cancels).not.toContain(`un-B-${conn.id}`);
      const rowA = await runs.findById(`un-A-${conn.id}`);
      expect(rowA?.cancelRequested).toBe(1);
      const rowB = await runs.findById(`un-B-${conn.id}`);
      expect(rowB?.cancelRequested).toBe(0);
      const grantRow = await grants.findById(grantA.id);
      expect(grantRow?.revokedAt).not.toBeNull(); // history stays
    });

    it("keeps command text out of every audit row written by these flows", async () => {
      const rows = await sql<{
        action: string;
        metadata: string | null;
      }>`SELECT action, metadata_json FROM audit_events WHERE action LIKE 'ssh.%'`.execute(db);
      expect(rows.rows.length).toBeGreaterThan(0);
      const corpus = rows.rows.map((r) => `${r.action} ${r.metadata ?? ""}`).join("\n");
      for (const banned of ["uptime", "echo marker-", "remote says hi"]) {
        expect(corpus.includes(banned)).toBe(false);
      }
    });
  });
});
