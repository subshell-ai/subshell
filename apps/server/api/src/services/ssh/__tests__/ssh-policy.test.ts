import { beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { ensureMigratedTestDb } from "@/__tests__/helpers/test-database.js";
import { db } from "@/db/index.js";
import { NodesRepository } from "@/db/repositories/nodes.repository.js";
import { SubshellsRepository } from "@/db/repositories/subshells.repository.js";
import { resetNodeRegistryForTests } from "@/services/nodes/node-registry.js";
import { SshConnectionsRepository } from "@/services/ssh/ssh-connections.repository.js";
import { SshGrantsRepository } from "@/services/ssh/ssh-grants.repository.js";
import { SshPanesRepository } from "@/services/ssh/ssh-panes.repository.js";
import type { SshCaller } from "@/services/ssh/ssh-policy.js";
import { DefaultSshPolicy } from "@/services/ssh/ssh-policy-impl.js";
import { SshRunsRepository } from "@/services/ssh/ssh-runs.repository.js";
import { attachScriptedNode, type ScriptedNode } from "@/test-helpers/scripted-node.js";

/**
 * The SSH policy matrix - the deny-by-default law in test form (Gate A's
 * "refusals are the default until the full policy is installed" is only true
 * if every ALLOW here names a row that confirms it). The pane arms are
 * exercised through the service seam directly because the coarse `ssh` token
 * permission does not exist until Gate B: until the coordinator adds it, a
 * bearer cannot reach `/api/ssh` at all (pinned by the route suite), and the
 * gate's OWN decisions must still be proven for the shape it will serve.
 */

const OWNER = "p-owner";
const FOREIGN = "p-foreign";
const NODE = "p-node";
const OFFLINE_NODE = "p-node-off";

const snapshot = {
  alias: "staging",
  host: "app-02.example.net",
  user: "deploy",
  port: 22,
  identityFiles: ["/home/deploy/.ssh/id_ed25519"],
  certificateFiles: [],
  authAgentSocket: null,
  knownHostsFiles: ["/home/deploy/.ssh/known_hosts"],
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
};

const connections = new SshConnectionsRepository(db);
const grants = new SshGrantsRepository(db);
const panes = new SshPanesRepository(db);
const runs = new SshRunsRepository(db);
const subshells = new SubshellsRepository(db);
const nodes = new NodesRepository(db);

const policy = new DefaultSshPolicy();

function cookieCaller(userId = OWNER, isAdmin = false): SshCaller {
  return { actor: "cookie", userId, principal: `user:${userId}`, apiKeyId: null, subshellId: null, isAdmin };
}

function paneCaller(subshellId: string, apiKeyId: string, userId = OWNER): SshCaller {
  return { actor: "subshell-key", userId, principal: `sess:${subshellId}`, apiKeyId, subshellId, isAdmin: false };
}

let connId = 0;
async function makeConnection(over: { userId?: string; nodeId?: string; revision?: number } = {}) {
  const row = await connections.create({
    id: `c-${++connId}`,
    userId: over.userId ?? OWNER,
    nodeId: over.nodeId ?? NODE,
    displayName: "Staging",
    configSnapshot: JSON.stringify(snapshot),
    remoteDir: null,
    revision: over.revision,
  });
  return row;
}

async function makePane(over: {
  id: string;
  userId?: string;
  apiKeyId?: string | null;
  status?: "running" | "terminated";
  alive?: number;
}) {
  await subshells.create({
    id: over.id,
    userId: over.userId ?? OWNER,
    harnessId: "claude-code",
    name: over.id,
    workingDir: "/srv",
    nodeId: NODE,
    status: over.status ?? "running",
    alive: over.alive ?? 1,
    tmuxSocket: `sock-${crypto.randomUUID()}`,
    presetId: null,
  });
  // The issued-key column is written by the token mint (and here, by the
  // repository update) - the insert shape cannot carry it.
  await subshells.update(over.id, { apiKeyId: over.apiKeyId === undefined ? "k-1" : over.apiKeyId });
  return over.id;
}

async function makeGrant(connectionId: string, subshellId: string, apiKeyId: string, revision: number) {
  return grants.create({
    id: `g-${connectionId}-${subshellId}-${apiKeyId}`,
    connectionId,
    connectionRevision: revision,
    subshellId,
    apiKeyId,
    grantedByUserId: OWNER,
    revokedAt: null,
  });
}

describe("DefaultSshPolicy (SSH-SUPPORT.md §2, Gate A interface)", () => {
  let scripted: ScriptedNode;

  beforeAll(async () => {
    await ensureMigratedTestDb();
    await nodes.create({ id: NODE, ownerUserId: OWNER, name: "policy node", kind: "agent", status: "online" });
    await nodes.create({ id: OFFLINE_NODE, ownerUserId: OWNER, name: "offline node", kind: "agent" });
  });

  beforeEach(() => {
    resetNodeRegistryForTests();
    scripted = attachScriptedNode(NODE, {});
  });

  describe("gateHumanConfig", () => {
    it("refuses every machine credential with cookie_required", async () => {
      const pane = await makePane({ id: "h-pane-1" });
      const d = await policy.gateHumanConfig({
        caller: paneCaller(pane, "k-1"),
        action: "save",
      });
      expect(d).toEqual({ allow: false, code: "cookie_required" });
      const sys = await policy.gateHumanConfig({
        caller: {
          actor: "system-key",
          userId: OWNER,
          principal: `user:${OWNER}`,
          apiKeyId: "sk",
          subshellId: null,
          isAdmin: false,
        },
        action: "grant",
        connectionId: "whatever",
      });
      expect(sys).toMatchObject({ allow: false, code: "cookie_required" });
    });

    it("404s a foreign connection for its EDIT, even from an admin (admin is never an SSH override)", async () => {
      const foreignConn = await makeConnection({ userId: FOREIGN });
      const d = await policy.gateHumanConfig({
        caller: cookieCaller(OWNER, true),
        action: "edit",
        connectionId: foreignConn.id,
      });
      expect(d).toEqual({ allow: false, code: "not_found" });
    });

    it("refuses edits while the connection has active runs or live managed panes", async () => {
      const conn = await makeConnection();
      const d0 = await policy.gateHumanConfig({ caller: cookieCaller(), action: "edit", connectionId: conn.id });
      expect(d0.allow).toBe(true);
      await runs.create({
        id: "r-active-1",
        userId: OWNER,
        nodeId: NODE,
        connectionId: conn.id,
        connectionRevision: 1,
        configSnapshot: JSON.stringify(snapshot),
        initiatedBy: "human",
        grantId: null,
        apiKeyId: null,
        command: "true",
        remoteDir: null,
        requestDigest: "d",
        deadlineMs: 60_000,
        status: "running",
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
      const d1 = await policy.gateHumanConfig({
        caller: cookieCaller(),
        action: "delete_connection",
        connectionId: conn.id,
      });
      expect(d1).toEqual({ allow: false, code: "active_work" });
    });

    it("refuses human new-work acts on an offline node (eligibility is the other half of ownership)", async () => {
      const conn = await makeConnection({ nodeId: OFFLINE_NODE });
      const d = await policy.gateHumanConfig({ caller: cookieCaller(), action: "run_start", connectionId: conn.id });
      expect(d).toEqual({ allow: false, code: "node_ineligible" });
    });
  });

  describe("gateGrantedUse", () => {
    it("allows a pane with an active grant for the CURRENT revision on a live node", async () => {
      const conn = await makeConnection();
      const pane = await makePane({ id: "g-pane-ok", apiKeyId: "k-ok" });
      await makeGrant(conn.id, pane, "k-ok", conn.revision);
      const d = await policy.gateGrantedUse({
        caller: paneCaller(pane, "k-ok"),
        kind: "run_start",
        connectionId: conn.id,
      });
      expect(d.allow).toBe(true);
    });

    it("refuses the SAME-OWNER ungranted pane (sibling status grants nothing)", async () => {
      const conn = await makeConnection();
      const pane = await makePane({ id: "g-pane-none", apiKeyId: "k-x" });
      const d = await policy.gateGrantedUse({
        caller: paneCaller(pane, "k-x"),
        kind: "run_start",
        connectionId: conn.id,
      });
      expect(d).toEqual({ allow: false, code: "not_granted" });
    });

    it("refuses a wrong-owner pane as invisible, never as forbidden", async () => {
      const conn = await makeConnection(); // owned by OWNER
      const pane = await makePane({ id: "g-pane-foreign", userId: FOREIGN, apiKeyId: "k-f" });
      const d = await policy.gateGrantedUse({
        caller: paneCaller(pane, "k-f", FOREIGN),
        kind: "run_start",
        connectionId: conn.id,
      });
      expect(d).toEqual({ allow: false, code: "not_found" });
    });

    it("refuses the OLD key of a restarted pane with token_stale (no grandfathering)", async () => {
      const conn = await makeConnection();
      const pane = await makePane({ id: "g-pane-old", apiKeyId: "k-new" }); // row carries the NEW key
      await makeGrant(conn.id, pane, "k-old", conn.revision); // grant binds the OLD key
      const presentingOld = await policy.gateGrantedUse({
        caller: paneCaller(pane, "k-old"),
        kind: "run_start",
        connectionId: conn.id,
      });
      expect(presentingOld).toEqual({ allow: false, code: "token_stale" });
      // ...and the new key inherits nothing from the old grant:
      const presentingNew = await policy.gateGrantedUse({
        caller: paneCaller(pane, "k-new"),
        kind: "run_start",
        connectionId: conn.id,
      });
      expect(presentingNew).toEqual({ allow: false, code: "not_granted" });
    });

    it("names grant_revoked when the tuple's row exists but is stamped", async () => {
      const conn = await makeConnection();
      const pane = await makePane({ id: "g-pane-rev", apiKeyId: "k-r" });
      const grant = await makeGrant(conn.id, pane, "k-r", conn.revision);
      await grants.revokeById(grant.id);
      const d = await policy.gateGrantedUse({
        caller: paneCaller(pane, "k-r"),
        kind: "connection_view",
        connectionId: conn.id,
      });
      expect(d).toEqual({ allow: false, code: "grant_revoked" });
    });

    it("refuses revision-mismatched grants (the edit-invalidates-grants rule)", async () => {
      const conn = await makeConnection();
      const pane = await makePane({ id: "g-pane-rev-mis", apiKeyId: "k-m" });
      await makeGrant(conn.id, pane, "k-m", conn.revision);
      await connections.updateSnapshot(conn.id, {
        configSnapshot: JSON.stringify({ ...snapshot, host: "other.example.net" }),
      });
      const d = await policy.gateGrantedUse({
        caller: paneCaller(pane, "k-m"),
        kind: "run_start",
        connectionId: conn.id,
      });
      expect(d).toEqual({ allow: false, code: "revision_mismatch" });
    });

    it("refuses dispatch acts for a dead pane (the two liveness facts)", async () => {
      const conn = await makeConnection();
      const pane = await makePane({ id: "g-pane-dead", apiKeyId: "k-d", status: "running", alive: 0 });
      await makeGrant(conn.id, pane, "k-d", conn.revision);
      const d = await policy.gateGrantedUse({
        caller: paneCaller(pane, "k-d"),
        kind: "terminal_open",
        connectionId: conn.id,
      });
      expect(d).toEqual({ allow: false, code: "pane_lifecycle" });
    });

    it("refuses run_start when the connecting node drops (re-asked live at decision time)", async () => {
      const conn = await makeConnection();
      const pane = await makePane({ id: "g-pane-off", apiKeyId: "k-o" });
      await makeGrant(conn.id, pane, "k-o", conn.revision);
      scripted.detach();
      const d = await policy.gateGrantedUse({
        caller: paneCaller(pane, "k-o"),
        kind: "run_start",
        connectionId: conn.id,
      });
      expect(d).toEqual({ allow: false, code: "node_ineligible" });
    });

    it("resolves run-scoped kinds through the row: foreign, human-initiated, and credential-mismatched runs are invisible or stale", async () => {
      const conn = await makeConnection();
      const paneA = await makePane({ id: "g-run-a", apiKeyId: "ka" });
      const grantA = await makeGrant(conn.id, paneA, "ka", conn.revision);
      const runRow = {
        connectionId: conn.id,
        connectionRevision: 1,
        configSnapshot: JSON.stringify(snapshot),
        nodeId: NODE,
        deadlineMs: 60_000,
        requestDigest: "x",
        command: "true",
        remoteDir: null,
        startedAt: null,
        finishedAt: null,
      } as const;
      await runs.create({
        id: "r-agent",
        userId: OWNER,
        initiatedBy: "agent",
        grantId: grantA.id,
        apiKeyId: "ka",
        status: "running",
        cancelRequested: 0,
        cancelLocalConfirmed: 0,
        deadlineHit: 0,
        remoteStatus: null,
        remoteStatusConfirmed: 0,
        localExitCode: null,
        localExitSignal: null,
        ...runRow,
      });
      await runs.create({
        id: "r-human",
        userId: OWNER,
        initiatedBy: "human",
        grantId: null,
        apiKeyId: null,
        status: "running",
        cancelRequested: 0,
        cancelLocalConfirmed: 0,
        deadlineHit: 0,
        remoteStatus: null,
        remoteStatusConfirmed: 0,
        localExitCode: null,
        localExitSignal: null,
        ...runRow,
      });
      const ok = await policy.gateGrantedUse({ caller: paneCaller(paneA, "ka"), kind: "run_cancel", runId: "r-agent" });
      expect(ok.allow).toBe(true);
      const humanRun = await policy.gateGrantedUse({
        caller: paneCaller(paneA, "ka"),
        kind: "run_read",
        runId: "r-human",
      });
      expect(humanRun).toEqual({ allow: false, code: "not_found" });
      const foreignRun = await policy.gateGrantedUse({
        caller: paneCaller("g-run-b", "kb", FOREIGN),
        kind: "run_read",
        runId: "r-agent",
      });
      expect(foreignRun).toEqual({ allow: false, code: "not_found" });
      const afterRevoke = await grants.revokeById(grantA.id);
      void afterRevoke;
      const revokedRun = await policy.gateGrantedUse({
        caller: paneCaller(paneA, "ka"),
        kind: "run_cancel",
        runId: "r-agent",
      });
      expect(revokedRun).toEqual({ allow: false, code: "grant_revoked" });
    });

    it("refuses granted use on a node that entered maintenance after the grant (live re-ask)", async () => {
      const conn = await makeConnection();
      const pane = await makePane({ id: "g-pane-maint", apiKeyId: "k-w" });
      await makeGrant(conn.id, pane, "k-w", conn.revision);
      await nodes.setMaintenance(NODE, { on: true, changedAt: new Date().toISOString(), source: "plane" });
      const d = await policy.gateGrantedUse({
        caller: paneCaller(pane, "k-w"),
        kind: "run_start",
        connectionId: conn.id,
      });
      expect(d).toEqual({ allow: false, code: "node_ineligible" });
      await nodes.setMaintenance(NODE, { on: false, changedAt: new Date().toISOString(), source: "plane" });
    });
  });

  describe("gatePaneSurface", () => {
    it("allows unmanaged panes - 'the policy does not apply', which is why this is the only pass-through", async () => {
      const d = await policy.gatePaneSurface({ caller: cookieCaller(), subshellId: "no-row", surface: "log" });
      expect(d.allow).toBe(true);
    });

    it("lets the owning human through every surface and refuses everyone else as invisible", async () => {
      const conn = await makeConnection();
      const pane = await makePane({ id: "s-pane", apiKeyId: null });
      await panes.create({
        subshellId: pane,
        connectionId: conn.id,
        connectionRevision: 1,
        initiatedBy: "human",
        grantId: null,
        apiKeyId: null,
        controlOwner: "human",
        controlGeneration: 1,
        logGeneration: 1,
      });
      const owner = await policy.gatePaneSurface({ caller: cookieCaller(OWNER), subshellId: pane, surface: "log" });
      expect(owner.allow).toBe(true);
      // While a HUMAN holds input, the OWNER still reads (control blocks agents only):
      const foreign = await policy.gatePaneSurface({ caller: cookieCaller(FOREIGN), subshellId: pane, surface: "log" });
      expect(foreign).toEqual({ allow: false, code: "not_found" });
      // No bearer ever reaches a human-opened pane (no credential to match):
      const sibling = await makePane({ id: "s-sibling", apiKeyId: "kk" });
      const bearer = await policy.gatePaneSurface({
        caller: paneCaller(sibling, "kk"),
        subshellId: pane,
        surface: "input",
      });
      expect(bearer).toEqual({ allow: false, code: "not_found" });
    });

    it("fences the opening agent by CONTROL and GRANT state, and lets lifecycle acts past control", async () => {
      const conn = await makeConnection();
      const opener = await makePane({ id: "s-opener", apiKeyId: "ko" });
      const managed = "s-managed";
      await makePane({ id: managed, apiKeyId: "ko" });
      await grants.create({
        id: "g-s-managed",
        connectionId: conn.id,
        connectionRevision: 1,
        subshellId: managed,
        apiKeyId: "ko",
        grantedByUserId: OWNER,
        revokedAt: null,
      });
      await panes.create({
        subshellId: managed,
        connectionId: conn.id,
        connectionRevision: 1,
        initiatedBy: "agent",
        grantId: "g-s-managed",
        apiKeyId: "ko",
        controlOwner: "agent",
        controlGeneration: 1,
        logGeneration: 1,
      });
      const read = await policy.gatePaneSurface({
        caller: paneCaller(opener, "ko"),
        subshellId: managed,
        surface: "log",
      });
      expect(read.allow).toBe(true);
      // Takeover fences reads AND writes:
      await panes.setControl(managed, "human");
      const blocked = await policy.gatePaneSurface({
        caller: paneCaller(opener, "ko"),
        subshellId: managed,
        surface: "log",
      });
      expect(blocked).toEqual({ allow: false, code: "human_control" });
      const term = await policy.gatePaneSurface({
        caller: paneCaller(opener, "ko"),
        subshellId: managed,
        surface: "terminate",
      });
      expect(term.allow).toBe(true); // lifecycle is not an input stream
      // Revocation re-fences everything:
      await grants.revokeById("g-s-managed");
      const revoked = await policy.gatePaneSurface({
        caller: paneCaller(opener, "ko"),
        subshellId: managed,
        surface: "log",
      });
      expect(revoked).toEqual({ allow: false, code: "grant_revoked" });
    });

    it("refuses attach REDEEM for a bearer whose key no longer matches (machine tokens are re-checked at redemption, §2)", async () => {
      const conn = await makeConnection();
      const managed = "s-attach";
      await makePane({ id: "s-old", apiKeyId: "k-old" });
      await makePane({ id: managed, apiKeyId: "k-old" });
      await panes.create({
        subshellId: managed,
        connectionId: conn.id,
        connectionRevision: 1,
        initiatedBy: "agent",
        grantId: null,
        apiKeyId: "k-old",
        controlOwner: "agent",
        controlGeneration: 1,
        logGeneration: 1,
      });
      const d = await policy.gatePaneSurface({
        caller: paneCaller("s-old", "k-new"),
        subshellId: managed,
        surface: "attach_redeem",
      });
      expect(d).toEqual({ allow: false, code: "not_found" });
    });
  });

  describe("gateSharing and gateControl", () => {
    it("refuses sharing a managed pane to EVERYONE including the owner, and passes unmanaged panes", async () => {
      const conn = await makeConnection();
      await makePane({ id: "sh-pane", apiKeyId: null });
      await panes.create({
        subshellId: "sh-pane",
        connectionId: conn.id,
        connectionRevision: 1,
        initiatedBy: "human",
        grantId: null,
        apiKeyId: null,
        controlOwner: "human",
        controlGeneration: 1,
        logGeneration: 1,
      });
      const owner = await policy.gateSharing({ caller: cookieCaller(OWNER), subshellId: "sh-pane" });
      expect(owner).toEqual({ allow: false, code: "sharing_unsupported" });
      const unmanaged = await policy.gateSharing({ caller: cookieCaller(OWNER), subshellId: "plain-pane" });
      expect(unmanaged.allow).toBe(true);
    });

    it("gateControl blocks agent reads and writes under human control and never the human arm", async () => {
      const conn = await makeConnection();
      await makePane({ id: "ct-pane", apiKeyId: "kc" });
      await panes.create({
        subshellId: "ct-pane",
        connectionId: conn.id,
        connectionRevision: 1,
        initiatedBy: "agent",
        grantId: null,
        apiKeyId: "kc",
        controlOwner: "human",
        controlGeneration: 1,
        logGeneration: 1,
      });
      const write = await policy.gateControl({
        caller: paneCaller("opener-x", "kc"),
        subshellId: "ct-pane",
        intent: "agent_write",
      });
      expect(write).toEqual({ allow: false, code: "human_control" });
      // Review fix M-1: the cookie arm reads ownership first. A foreign human
      // gets the standard invisible-row posture, never a control transition.
      const foreign = await policy.gateControl({
        caller: cookieCaller(FOREIGN),
        subshellId: "ct-pane",
        intent: "agent_read",
      });
      expect(foreign).toEqual({ allow: false, code: "not_found" });
      const human = await policy.gateControl({
        caller: cookieCaller(OWNER),
        subshellId: "ct-pane",
        intent: "agent_read",
      });
      expect(human.allow).toBe(true);
    });
  });
});
