import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { BackendErrorCodes } from "@internal/backend-errors";
import { buildAgentSocketPath, buildSshConfigPath } from "@internal/pane-runtime";
import type { SshConnectionSnapshotWire, SshExecCommand } from "@internal/subshell-protocol";
import { hashPassword } from "better-auth/crypto";
import { ensureMigratedTestDb } from "@/__tests__/helpers/test-database.js";
import { deleteUserByEmailOrId, setupAuthTables } from "@/api/__tests__/helpers/auth-tables.js";
import { APP_BASE_URL } from "@/constants.js";
import { db } from "@/db/index.js";
import { IdentitiesRepository } from "@/db/repositories/identities.repository.js";
import { NodeSetupKeysRepository } from "@/db/repositories/node-setup-keys.repository.js";
import { NodesRepository } from "@/db/repositories/nodes.repository.js";
import { SshGrantsRepository } from "@/db/repositories/ssh-grants.repository.js";
import { SubshellsRepository } from "@/db/repositories/subshells.repository.js";
import { UsersRepository } from "@/db/repositories/users.repository.js";
import type { NodeTable } from "@/db/types/nodes.db-types.js";
import { sshCanonicalDestination } from "@/db/types/ssh-saved-hosts.db-types.js";
import { resetNodeRegistryForTests } from "@/services/nodes/node-registry.js";
import type { SshRefusal } from "@/services/ssh-launch.service.js";
import { type RelayBroker, setRelayBrokerForTests } from "@/services/ssh-relay.service.js";
import { setSshSetupHereDepsForTests, setupHere } from "@/services/ssh-setup-here.service.js";
import { attachScriptedNode, SCRIPTED_DATA_DIR, type ScriptedNode } from "@/test-helpers/scripted-node.js";

/**
 * The "Set up Subshell here" service (spec 2026-10-08 §7, Task 14). What
 * this suite exists to pin, the brief's five arms first:
 *
 * (b) a non-egressing D answers the NAMED egress cause (its own code) and
 *     the working pane row is untouched - this act never writes one;
 * (c) relay mode RE-OPENS the relay (the broker sees a fresh pairing keyed
 *     to the exec's ephemeral id, not the pane's), and an A that is offline
 *     refuses naming the key home's online-ness before any key or session
 *     exists;
 * (d) success is the new node's `ready` (the registry fact) observed inside
 *     the bounded wait, not the installer's cheer line;
 * (e) a captured line containing `nsk_` never reaches the returned answer,
 *     any refusal copy, or the `node.ssh_upgrade.run` audit row.
 *
 * B answers over the REAL sendCommand chain through the scripted node (the
 * emitted frames pass the real wire grammar); the relay broker is the fake
 * the grants suite uses; every wait runs on injected seams. The key the test
 * recovers from the exec command string is the mint's plaintext - which is
 * what makes the leak assertions mean something.
 */

const HOST = "d.example.test";
const PIN_LINE = "d.example.test ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI00000000000000000000000000000000000000000";
const DEST = sshCanonicalDestination({ host: HOST, port: 22, user: null });
const SNAP = (over: Partial<SshConnectionSnapshotWire> = {}): SshConnectionSnapshotWire => ({
  alias: HOST,
  host: HOST,
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
  ...over,
});

const emails: string[] = [];
const createdPanes: string[] = [];
const createdNodes: string[] = [];
const nodes = new NodesRepository(db);
const keys = new NodeSetupKeysRepository(db);
let owner = "";
let stranger = "";
const NODE_A = "setup-node-a";
const NODE_B = "setup-node-b";

/** The relay broker fake: opens recorded, closes recorded, socket answer derived. */
let openCalls: { paneId: string; aNode: string; bNode: string; grantId: string; hostPin: string }[] = [];
let closeCalls: { paneId: string; reason: string }[] = [];
let fakeBroker: RelayBroker;

function makeFakeBroker(): RelayBroker {
  return {
    openRelay: async (input: { paneId: string; aNode: string; bNode: string; grantId: string; hostPin: string }) => {
      openCalls.push(input);
      return {
        relayId: `relay-${openCalls.length}`,
        ref: `ref-${openCalls.length}`,
        expiresAt: new Date(Date.now() + 30_000).toISOString(),
        // In-contract answer: the plane byte-checks this against the same
        // derivation the node's relay-open bound.
        socketPath: buildAgentSocketPath(SCRIPTED_DATA_DIR, input.paneId),
      };
    },
    closeForPane: async (paneId: string, reason: string) => {
      closeCalls.push({ paneId, reason });
      return 1;
    },
  } as unknown as RelayBroker;
}

function installDeps(): void {
  setSshSetupHereDepsForTests({
    nowMs: () => Date.now(),
    sleepMs: () => new Promise((r) => setTimeout(r, 1)),
    execTimeoutMs: 600_000,
    execPollMarginMs: 50,
    readyBudgetMs: 1_000,
    pollMs: 1,
    broker: () => fakeBroker,
  });
}

async function mkNode(id: string): Promise<NodeTable> {
  await nodes.create({ id, ownerUserId: owner, name: id, kind: "agent", status: "offline" });
  createdNodes.push(id);
  await nodes.setSshEnabled(id, { on: true, changedAt: "2026-10-08T09:00:00.000Z" });
  await db
    .updateTable("nodes")
    .set({
      inventoryJson: JSON.stringify([{ harnessId: "ssh", installed: true, binaryPath: "/usr/bin/ssh", version: "1" }]),
      inventoryAt: new Date().toISOString(),
    } as never)
    .where("id", "=", id)
    .execute();
  return (await nodes.findById(id)) as NodeTable;
}

async function mkPane(opts: { keyHome: boolean; ssh?: string | null }): Promise<string> {
  const id = crypto.randomUUID();
  await new SubshellsRepository(db).create({
    id,
    userId: owner,
    harnessId: "ssh",
    name: `pane-${id.slice(0, 8)}`,
    workingDir: "/home/scripted",
    tmuxSocket: null,
    nodeId: NODE_B,
    // `??` would read a deliberate null as absent; the test's null IS the value.
    ssh: opts.ssh === undefined ? JSON.stringify(SNAP()) : opts.ssh,
    keyHomeNodeId: opts.keyHome ? NODE_A : null,
  });
  createdPanes.push(id);
  return id;
}

/** The standing grant + pin + identities every relay leg reads (fixture, once). */
async function authorizeRelay(): Promise<void> {
  const now = new Date().toISOString();
  await new SshGrantsRepository(db).insertGrant({
    id: crypto.randomUUID(),
    ownerUserId: owner,
    name: HOST,
    keyHomeNodeId: NODE_A,
    resolvedSelector: HOST,
    fingerprints: JSON.stringify(["SHA256:AAAA"]),
    createdVia: "manual",
    createdAt: now,
    updatedAt: now,
  });
  await db
    .insertInto("sshHostPins")
    .values({
      id: crypto.randomUUID(),
      ownerUserId: owner,
      destination: DEST,
      hostKey: PIN_LINE,
      createdAt: now,
      updatedAt: now,
    })
    .execute();
  const identities = new IdentitiesRepository(db);
  for (const [n, half] of [
    [NODE_A, "AAA"],
    [NODE_B, "EEE"],
  ] as const) {
    await identities.register({
      principalId: `node:${n}`,
      publicKey: `{"kty":"EC","crv":"P-256","x":"${half}","y":"${half}"}`,
      signingPublicKey: `{"kty":"EC","crv":"P-256","x":"${half}","y":"${half}"}`,
      displayName: n,
    });
  }
}

/** The key the act minted, recovered from the exec command the scripted machine saw. */
function mintedKey(cmd: SshExecCommand | undefined): string {
  const m = cmd?.command.match(/setup_key=(nsk_[A-Za-z0-9_-]{32})/);
  if (!m) throw new Error("the exec command carried no minted key");
  return m[1];
}

/** The refusal's coded facts; the 422 outcome arm is not an answer this act ever gives. */
function coded(refusal: SshRefusal): { status: number; code: BackendErrorCodes; message: string } {
  if (refusal.status === 422) throw new Error(`unexpected outcome refusal: ${JSON.stringify(refusal)}`);
  return refusal;
}

async function upgradeRows(): Promise<{ action: string; metadataJson: string | null }[]> {
  return await db
    .selectFrom("auditEvents")
    .select(["action", "metadataJson"])
    .where("action", "=", "node.ssh_upgrade.run")
    .execute();
}

/**
 * Attach the scripted machines: B answers the two exec arms from the caller's
 * controller (kick recorded for the status arm to read back). A is attached
 * silently ONLY when the test wants a live key home.
 */
function attachPair(impl: {
  onKick?: (cmd: SshExecCommand) => void | Promise<void>;
  status: (kick: SshExecCommand | undefined) => unknown;
  withA: boolean;
}): { b: ScriptedNode; a: ScriptedNode | null; kick: () => SshExecCommand | undefined } {
  let seen: SshExecCommand | undefined;
  const a = impl.withA ? attachScriptedNode(NODE_A, {}) : null;
  const b = attachScriptedNode(NODE_B, {
    ssh_exec: async (cmd) => {
      if (cmd.type !== "ssh_exec") throw new Error("wrong arm");
      seen = cmd;
      await impl.onKick?.(cmd);
      return { started: true, execId: cmd.execId };
    },
    ssh_exec_status: (cmd) => {
      if (cmd.type !== "ssh_exec_status") throw new Error("wrong arm");
      return impl.status(seen);
    },
  });
  return { b, a, kick: () => seen };
}

/** The install's success answer as the scripted machine states it. */
const DONE_OK = { state: "done", code: 0, timedOut: false, stdout: "==> done.\n", stderr: "" } as const;

/** Stand-in for D's enrollment completing: spend the minted key, bring D's `ready` up. */
async function enrollD(key: string): Promise<{ id: string; handle: ScriptedNode }> {
  const id = crypto.randomUUID();
  await nodes.create({ id, ownerUserId: owner, name: `d-${id.slice(0, 8)}`, kind: "agent", status: "offline" });
  const spent = await keys.consume(key, id);
  if (!spent) throw new Error("the fixture could not consume the minted key");
  return { id, handle: attachScriptedNode(id, {}) };
}

beforeAll(async () => {
  await ensureMigratedTestDb();
  await setupAuthTables();
  const mk = async (email: string): Promise<string> => {
    emails.push(email);
    return await new UsersRepository(db).createUser({
      email,
      name: email,
      passwordHash: await hashPassword("setup-here-1"),
      role: "user",
    });
  };
  owner = await mk(`setup-owner-${crypto.randomUUID()}@subshell.local`);
  stranger = await mk(`setup-other-${crypto.randomUUID()}@subshell.local`);
  await mkNode(NODE_A);
  await mkNode(NODE_B);
  await authorizeRelay();
});

afterAll(async () => {
  setSshSetupHereDepsForTests(null);
  setRelayBrokerForTests(null);
  resetNodeRegistryForTests();
  for (const id of createdPanes) await new SubshellsRepository(db).delete(id).catch(() => {});
  await db.deleteFrom("sshHostPins").execute();
  await db.deleteFrom("sshKeyGrants").execute();
  await db.deleteFrom("sshGrantRequests").execute();
  await db.deleteFrom("identities").execute();
  await db.deleteFrom("nodeSetupKeys").execute();
  await db.deleteFrom("auditEvents").where("action", "=", "node.ssh_upgrade.run").execute();
  for (const id of createdNodes) await nodes.deleteById(id).catch(() => {});
  for (const e of emails) await deleteUserByEmailOrId(e).catch(() => {});
});

beforeEach(() => {
  openCalls = [];
  closeCalls = [];
  fakeBroker = makeFakeBroker();
  setRelayBrokerForTests(fakeBroker);
  installDeps();
});

/** Each act's trail row is consumed by the test that wrote it; start clean. */
async function clearUpgradeRows(): Promise<void> {
  await db.deleteFrom("auditEvents").where("action", "=", "node.ssh_upgrade.run").execute();
}

describe("setupHere door order (pane first, gates before any key)", () => {
  it("a foreign or absent pane is the 404 the ownership axis demands", async () => {
    const paneId = await mkPane({ keyHome: true });
    const foreign = await setupHere({ viewerId: stranger, paneId });
    expect(foreign.ok).toBe(false);
    if (foreign.ok) return;
    expect(foreign.refusal.status).toBe(404);
    const absent = await setupHere({ viewerId: owner, paneId: crypto.randomUUID() });
    expect(absent.ok).toBe(false);
    if (absent.ok) return;
    expect(absent.refusal.status).toBe(404);
  });

  it("a non-ssh pane refuses by name", async () => {
    const paneId = await mkPane({ keyHome: false, ssh: null });
    const res = await setupHere({ viewerId: owner, paneId });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(coded(res.refusal).message).toContain("SSH-terminal pane");
  });
});

describe("setupHere relay mode", () => {
  it("refuses jump or aliased host trust before creating a relay or setup key", async () => {
    const pair = attachPair({ withA: true, status: () => DONE_OK });
    const keysBefore = (await keys.listByUser(owner)).length;
    try {
      for (const snapshot of [
        SNAP({ hostKeyAlias: "host-trust-alias" }),
        SNAP({ proxyJumps: [{ host: "jump.example.test", user: null, port: 22 }] }),
      ]) {
        const paneId = await mkPane({ keyHome: true, ssh: JSON.stringify(snapshot) });
        const answer = await setupHere({ viewerId: owner, paneId });
        expect(answer.ok).toBe(false);
        if (!answer.ok) expect(coded(answer.refusal).code).toBe(BackendErrorCodes.SSH_RELAY_OPEN_FAILED);
      }
      expect(openCalls).toHaveLength(0);
      expect(pair.b.cmdTypes()).toEqual([]);
      expect((await keys.listByUser(owner)).length).toBe(keysBefore);
    } finally {
      pair.a?.detach();
      pair.b.detach();
    }
  });

  it("a non-egressing D answers the NAMED egress cause and leaves the pane untouched", async () => {
    await clearUpgradeRows();
    const paneId = await mkPane({ keyHome: true });
    const keysBefore = (await keys.listByUser(owner)).length;
    const pair = attachPair({
      withA: true,
      status: () => ({
        state: "done",
        code: 1,
        timedOut: false,
        stdout: "",
        stderr:
          "subshell: could not reach http://plane.invalid; nothing was installed (/home/u/.local/bin/subshell untouched).",
      }),
    });
    try {
      const res = await setupHere({ viewerId: owner, paneId });
      expect(res.ok).toBe(false);
      if (res.ok) return;
      const refusal = coded(res.refusal);
      expect(refusal.status).toBe(409);
      expect(refusal.code).toBe(BackendErrorCodes.SSH_UPGRADE_EGRESS);
      expect(refusal.message).toContain("could not reach");
      expect(refusal.message).toContain("untouched");
      // The working pane: the row is unchanged, and B saw ONLY the exec arms
      // - no input, no terminate, no launch, no touch of any kind.
      const row = await new SubshellsRepository(db).findById(paneId);
      expect(row?.alive).toBe(1);
      expect(row?.status).toBe("running");
      expect(pair.b.cmdTypes()).toEqual(["ssh_exec", "ssh_exec_status"]);
      // The relay was opened once and closed with the named child-exit word.
      const exec = pair.kick();
      if (!exec) throw new Error("the act never kicked an exec");
      expect(openCalls).toHaveLength(1);
      expect(closeCalls).toEqual([{ paneId: exec.execId, reason: "child-exit" }]);
      // The unspent key is revoked on the way out; the trail names the cause.
      expect((await keys.listByUser(owner)).length).toBe(keysBefore);
      const audits = await upgradeRows();
      expect(audits).toHaveLength(1);
      expect(audits[0]?.metadataJson).toContain('"cause":"egress"');
      expect(audits[0]?.metadataJson).not.toContain("nsk_");
    } finally {
      pair.a?.detach();
      pair.b.detach();
    }
  });

  it("an offline A refuses naming the key home online, before any key or relay exists", async () => {
    await clearUpgradeRows();
    const paneId = await mkPane({ keyHome: true });
    const keysBefore = (await keys.listByUser(owner)).length;
    // A has NO scripted connection: getLive(A) is null, the offline class.
    const pair = attachPair({ withA: false, status: () => DONE_OK });
    try {
      const res = await setupHere({ viewerId: owner, paneId });
      expect(res.ok).toBe(false);
      if (res.ok) return;
      const refusal = coded(res.refusal);
      expect(refusal.code).toBe(BackendErrorCodes.SSH_RELAY_OPEN_FAILED);
      expect(refusal.message).toContain(NODE_A);
      expect(refusal.message).toMatch(/online/i);
      expect(openCalls).toHaveLength(0); // never re-opened
      expect(pair.b.cmdTypes()).toEqual([]); // B was never even asked to exec
      expect((await keys.listByUser(owner)).length).toBe(keysBefore); // no key minted
    } finally {
      pair.b.detach();
    }
  });

  it("success is the new node's ready: the relay re-opens under the exec id, the bounded wait observes the fact", async () => {
    await clearUpgradeRows();
    const paneId = await mkPane({ keyHome: true });
    let polls = 0;
    let d: { id: string; handle: ScriptedNode } | null = null;
    const pair = attachPair({
      withA: true,
      onKick: (cmd) => {
        // D's enrollment lands a beat AFTER the kick, while the act is
        // already polling: the wait observes it, no test-side sleep races.
        void enrollD(mintedKey(cmd)).then((r) => {
          d = r;
        });
      },
      status: () => {
        polls += 1;
        // Keep the exec "running" for two polls; the ready wait then finds
        // the spend + the live `ready` facts through the service's own loop.
        if (polls <= 2) return { state: "running" };
        return DONE_OK;
      },
    });
    // `d` is filled by the onKick closure; the accessor re-widens what flow
    // analysis narrows at the declaration.
    const seenD = () => d as { id: string; handle: ScriptedNode } | null;
    try {
      const res = await setupHere({ viewerId: owner, paneId });
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      const machine = seenD();
      const nodeId = machine?.id ?? "";
      expect(nodeId).not.toBe("");
      expect(res.value).toEqual({ nodeId });
      // The relay was RE-OPENED for this act, keyed to the exec's ephemeral
      // id (never the pane's), carrying the destination's pin; closed with
      // the named word once the exec's child was gone.
      const kick = pair.kick();
      if (!kick) throw new Error("the act never kicked an exec");
      const execId = kick.execId;
      expect(execId).not.toBe(paneId);
      expect(openCalls).toHaveLength(1);
      expect(openCalls[0]?.paneId).toBe(execId);
      expect(openCalls[0]?.aNode).toBe(NODE_A);
      expect(openCalls[0]?.bNode).toBe(NODE_B);
      expect(openCalls[0]?.hostPin).toBe(PIN_LINE);
      expect(closeCalls).toEqual([{ paneId: execId, reason: "child-exit" }]);
      // The composed run: the exec's OWN config dir, BatchMode first, the
      // installer one-liner with the destination host as the scripted name.
      expect(kick.configPath).toBe(buildSshConfigPath(SCRIPTED_DATA_DIR, execId));
      expect(kick.presetFlags.slice(0, 2)).toEqual(["-o", "BatchMode=yes"]);
      expect(kick.presetFlags).toContain("--");
      expect(kick.relay).toBe(true);
      expect(kick.agentSocketPath).toBeNull();
      expect(kick.command).toContain(`install.sh?setup_key=${mintedKey(kick)}`);
      expect(kick.command).toContain("SUBSHELL_NODE_NAME=");
      expect(kick.command).toContain(HOST);
      expect(polls).toBeGreaterThanOrEqual(3);
      // Audit: exactly one enrolled row naming ids, never the key.
      const audits = await upgradeRows();
      expect(audits).toHaveLength(1);
      const meta = JSON.parse(audits[0]?.metadataJson ?? "{}") as Record<string, unknown>;
      expect(meta).toMatchObject({
        paneId,
        bNodeId: NODE_B,
        aNodeId: NODE_A,
        destination: DEST,
        outcome: "enrolled",
        cause: "ready",
        newNodeId: nodeId,
      });
      expect(audits[0]?.metadataJson).not.toContain("nsk_");
      expect(JSON.stringify(res)).not.toContain("nsk_");
      seenD()?.handle.detach();
      await nodes.deleteById(nodeId).catch(() => {});
    } finally {
      seenD()?.handle.detach();
      pair.a?.detach();
      pair.b.detach();
    }
  });

  it("a status answer carrying the minted key leaks NOTHING: belt redaction covers refusal, response, and trail", async () => {
    await clearUpgradeRows();
    const paneId = await mkPane({ keyHome: true });
    const pair = attachPair({
      withA: true,
      status: (kick) => ({
        state: "done",
        code: 1,
        timedOut: false,
        // The machine ANSWERS with its own hygiene failing: the plane's belt
        // must hold anyway - no `nsk_` byte is kept, returned, or repeated.
        stdout: `KEY="${mintedKey(kick)}" here it is\nsubshell: the install exploded`,
        stderr: "",
      }),
    });
    try {
      const res = await setupHere({ viewerId: owner, paneId });
      expect(res.ok).toBe(false);
      if (res.ok) return;
      const key = mintedKey(pair.kick());
      const serialized = JSON.stringify(res);
      expect(serialized).not.toContain("nsk_");
      expect(serialized).not.toContain(key);
      const audits = await upgradeRows();
      expect(audits).toHaveLength(1);
      expect(audits[0]?.metadataJson).not.toContain("nsk_");
      expect(audits[0]?.metadataJson).not.toContain(key);
      expect(audits[0]?.metadataJson).toContain("install-exit-1");
    } finally {
      pair.a?.detach();
      pair.b.detach();
    }
  });

  it("install finished but the key never enrolled: named failure, key revoked", async () => {
    await clearUpgradeRows();
    const paneId = await mkPane({ keyHome: true });
    const keysBefore = (await keys.listByUser(owner)).length;
    const pair = attachPair({ withA: true, status: () => DONE_OK });
    try {
      const res = await setupHere({ viewerId: owner, paneId });
      expect(res.ok).toBe(false);
      if (res.ok) return;
      const refusal = coded(res.refusal);
      expect(refusal.code).toBe(BackendErrorCodes.SSH_UPGRADE_FAILED);
      expect(refusal.message).toContain("without enrolling");
      expect((await keys.listByUser(owner)).length).toBe(keysBefore);
    } finally {
      await clearUpgradeRows();
      pair.a?.detach();
      pair.b.detach();
    }
  });
});

describe("setupHere direct mode (B's own keys, no relay)", () => {
  it("a direct pane's exec carries no relay, and the snapshot's socket is the one scoped key", async () => {
    await clearUpgradeRows();
    const paneId = await mkPane({
      keyHome: false,
      ssh: JSON.stringify(SNAP({ authAgentSocket: "/run/user/700/agent.sock" })),
    });
    let d: { id: string; handle: ScriptedNode } | null = null;
    const pair = attachPair({
      withA: false, // direct: A must NEVER be part of this act
      onKick: (cmd) => {
        void enrollD(mintedKey(cmd)).then((r) => {
          d = r;
        });
      },
      status: () => DONE_OK,
    });
    // Same closure-filled `d`: the accessor re-widens the declaration's flow type.
    const seenD = () => d as { id: string; handle: ScriptedNode } | null;
    try {
      const res = await setupHere({ viewerId: owner, paneId });
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      const kick = pair.kick();
      if (!kick) throw new Error("the act never kicked an exec");
      expect(kick.relay).toBe(false);
      expect(kick.agentSocketPath).toBe("/run/user/700/agent.sock");
      expect(kick.configPath).toBe(buildSshConfigPath(SCRIPTED_DATA_DIR, kick.execId));
      // The direct pane's exec never touched the relay broker, and A's live
      // absence was irrelevant to it (no key-home gate was walked).
      expect(openCalls).toHaveLength(0);
      expect(closeCalls).toHaveLength(0);
      seenD()?.handle.detach();
      await nodes.deleteById(seenD()?.id ?? "").catch(() => {});
    } finally {
      await clearUpgradeRows();
      pair.b.detach();
    }
  });

  // The dominant no-egress shape (spec §7/§13): a DARK destination never
  // runs install.sh, so none of the script's sentences exist in the answer;
  // the act's FIRST curl is what fails, and the named cause must come from
  // curl's own words/exit codes, not the generic install-exit stage.
  const darkD = (code: number, stderr: string) => ({
    state: "done" as const,
    code,
    timedOut: false,
    stdout: "",
    stderr,
  });

  it("a dark destination (DNS failure on the first fetch) answers the NAMED egress cause, not install-exit", async () => {
    await clearUpgradeRows();
    const paneId = await mkPane({ keyHome: false });
    const keysBefore = (await keys.listByUser(owner)).length;
    const pair = attachPair({
      withA: false,
      status: () => darkD(6, "curl: (6) Could not resolve host: plane.invalid\n"),
    });
    try {
      const res = await setupHere({ viewerId: owner, paneId });
      expect(res.ok).toBe(false);
      if (res.ok) return;
      const refusal = coded(res.refusal);
      expect(refusal.code).toBe(BackendErrorCodes.SSH_UPGRADE_EGRESS);
      expect(refusal.message).toContain("could not reach");
      expect(refusal.message).toContain(APP_BASE_URL);
      const audits = await upgradeRows();
      expect(audits).toHaveLength(1);
      expect(audits[0]?.metadataJson).toContain('"cause":"egress"');
      expect(audits[0]?.metadataJson).not.toContain("install-exit");
      expect((await keys.listByUser(owner)).length).toBe(keysBefore);
      expect(pair.b.cmdTypes()).toEqual(["ssh_exec", "ssh_exec_status"]);
    } finally {
      await clearUpgradeRows();
      pair.b.detach();
    }
  });

  it("a dark destination (refused TCP connect) answers the egress cause", async () => {
    await clearUpgradeRows();
    const paneId = await mkPane({ keyHome: false });
    const pair = attachPair({
      withA: false,
      status: () => darkD(7, "curl: (7) Failed to connect to 10.9.9.9 port 80 after 3004 ms: Connection refused\n"),
    });
    try {
      const res = await setupHere({ viewerId: owner, paneId });
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(coded(res.refusal).code).toBe(BackendErrorCodes.SSH_UPGRADE_EGRESS);
      const audits = await upgradeRows();
      expect(audits[0]?.metadataJson).toContain('"cause":"egress"');
      expect(audits[0]?.metadataJson).not.toContain("install-exit");
    } finally {
      await clearUpgradeRows();
      pair.b.detach();
    }
  });

  it("curl's connect-failure exit codes classify without curl's sentence (belt: no installer banner)", async () => {
    await clearUpgradeRows();
    const paneId = await mkPane({ keyHome: false });
    // The belt arm: an older or stripped curl that exits 6/7 but words
    // nothing. No `==>` banner means install.sh never ran, so the only
    // network actor that failed is the act's first curl.
    const pair = attachPair({ withA: false, status: () => darkD(7, "") });
    try {
      const res = await setupHere({ viewerId: owner, paneId });
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(coded(res.refusal).code).toBe(BackendErrorCodes.SSH_UPGRADE_EGRESS);
    } finally {
      await clearUpgradeRows();
      pair.b.detach();
    }
  });
});

describe("setupHere preserves completed enrollment after later failures", () => {
  for (const failure of [
    "kick",
    "lost-status",
    "deadline",
    "installer",
    "installer-timeout",
    "ready-timeout",
  ] as const) {
    it(`returns the enrolled machine when ${failure} happens after the key was consumed`, async () => {
      await clearUpgradeRows();
      const paneId = await mkPane({ keyHome: false });
      let enrolled: Awaited<ReturnType<typeof enrollD>> | undefined;
      let clock = 0;
      setSshSetupHereDepsForTests({
        nowMs: () => clock++,
        sleepMs: async () => {},
        execTimeoutMs: 1,
        execPollMarginMs: 0,
        readyBudgetMs: 1,
        pollMs: 1,
        broker: () => fakeBroker,
      });
      const pair = attachPair({
        withA: false,
        onKick: async (kick) => {
          enrolled = await enrollD(mintedKey(kick));
          enrolled.handle.detach();
          if (failure === "kick") throw new Error("reply lost after installation");
        },
        status: () => {
          if (failure === "lost-status") return new Error("connection lost");
          if (failure === "deadline") return { state: "running" };
          if (failure === "ready-timeout") return DONE_OK;
          return {
            ...DONE_OK,
            code: 1,
            timedOut: failure === "installer-timeout",
            stderr: "service installation failed",
          };
        },
      });
      try {
        const answer = await setupHere({ viewerId: owner, paneId });
        if (!enrolled) throw new Error("the installer did not consume its key");
        expect(answer).toEqual({ ok: true, value: { nodeId: enrolled.id, connected: false } });
        const key = await keys.peekByKey(mintedKey(pair.kick()));
        expect(typeof key?.usedAt).toBe("string");
        const events = await upgradeRows();
        expect(events).toHaveLength(1);
        expect(events[0]?.metadataJson).toContain('"outcome":"enrolled"');
        expect(events[0]?.metadataJson).toContain(enrolled?.id ?? "missing");
        expect(events[0]?.metadataJson).not.toContain("nsk_");
      } finally {
        pair.b.detach();
        if (enrolled) await nodes.deleteById(enrolled.id);
        installDeps();
      }
    });
  }
});
