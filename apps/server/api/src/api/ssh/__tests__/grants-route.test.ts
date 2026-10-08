import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { BackendErrorCodes } from "@internal/backend-errors";
import { type NodeSshAgentIdentitiesResult, SSH_MAX_GRANT_FINGERPRINTS } from "@internal/subshell-protocol";
import { hashPassword } from "better-auth/crypto";
import { Elysia } from "elysia";
import { ensureMigratedTestDb } from "@/__tests__/helpers/test-database.js";
import { deleteUserByEmailOrId, setupAuthTables, signIn } from "@/api/__tests__/helpers/auth-tables.js";
import { sshRoutes } from "@/api/ssh/index.js";
import { db } from "@/db/index.js";
import { IdentitiesRepository } from "@/db/repositories/identities.repository.js";
import { NodesRepository } from "@/db/repositories/nodes.repository.js";
import { SubshellsRepository } from "@/db/repositories/subshells.repository.js";
import { UsersRepository } from "@/db/repositories/users.repository.js";
import { LOCAL_NODE_ID } from "@/db/types/nodes.db-types.js";
import { errorHandlerPlugin } from "@/plugins/error-handler.plugin.js";
import { resetNodeRegistryForTests } from "@/services/nodes/node-registry.js";
import { SshRpcError } from "@/services/nodes/ssh-rpc.js";
import { createGrant, requestFirstUse, setSshGrantsDepsForTests } from "@/services/ssh-grants.service.js";
import { setSshHostPinsDepsForTests } from "@/services/ssh-host-pins.service.js";
import { type RelayBroker, SshRelayRefusal } from "@/services/ssh-relay.service.js";
import { issueSubshellToken } from "@/services/subshell-tokens.js";
import { attachScriptedNode, ok, statDirEcho } from "@/test-helpers/scripted-node.js";

/**
 * The grant tier's HTTP surface (spec 2026-10-08 §6/§8; Task 10 routes +
 * the relay launch leg). The properties pinned here:
 *
 * - The COOKIE doctrine verbatim from the siblings: empty cookie 401, a real
 *   subshell token 403 on every grants/approvals/relay-launch door (decision
 *   5: these routes match `launch`/`resolve`/`saved-hosts`, which refuse
 *   machine credentials at the door).
 * - Owner scoping: lists never carry another owner's rows; a foreign id is
 *   the SAME 404 an absent one gets (grants, requests, and their answers).
 * - The named refusals: over-cap selection and off-grammar fingerprints are
 *   the 400 codes, an already-answered request is the named 409, a key home
 *   the caller may not SSH through is the gate's own 403/404.
 * - REVOKE reaches live relays over HTTP too: the delete answers 204 with no
 *   body and the broker's closeForGrant has seen exactly this grant id with
 *   reason "grant-revoked".
 * - The RELAY LAUNCH: no standing grant -> the pane is NOT created, the
 *   broker never opens, a durable pending row + notification stand, and the
 *   answer is 409 SSH_GRANT_APPROVAL_REQUIRED. A standing grant -> 201, the
 *   broker opened for (grant, A, B, pane) with the grant's fingerprints, and
 *   the launch frame carries the BROKER's socket as the scoped SSH_AUTH_SOCK,
 *   overriding the snapshot's own agent socket.
 *
 * The clock/broker/notify trio is the service's injected seam: every case
 * drives the REAL route stack (real gate, real resolve over a scripted node,
 * real create path) while the relay itself is a recorder.
 */

const app = new Elysia().use(errorHandlerPlugin).use(sshRoutes);

const pw = "grants-api-1";
const ownerEmail = `grantsapi-owner-${crypto.randomUUID()}@subshell.local`;
const otherEmail = `grantsapi-other-${crypto.randomUUID()}@subshell.local`;
let ownerId: string;
let ownerCookie: string;
let otherCookie: string;

const NODE_A = `n-grants-a-${crypto.randomUUID()}`;
const NODE_B = `n-grants-b-${crypto.randomUUID()}`;
/** SSH switched OFF on this one: the key-home gate's negative fixture. */
const NODE_OFF = `n-grants-off-${crypto.randomUUID()}`;
const nodes = new NodesRepository(db);
const createdSubshellIds: string[] = [];
const emails: string[] = [];

/** The broker's stand-in: it records the pairing and answers a fixed socket. */
const FAKE_SOCK = "/home/scripted/.subshell/ssh/fake-pane/agent.sock";
let openCalls: {
  grantId: string;
  fingerprints: string[];
  paneId: string;
  aNode: string;
  bNode: string;
  hostPin?: string;
}[] = [];
let closeGrantCalls: { grantId: string; reason: string }[] = [];
let notifyCalls: string[] = [];
let openRelayThrows: ((input: unknown) => never) | null = null;
/** Scripted roster RPC (Task 11): a canned answer or a canned failure, plus the call log. */
let rosterAnswer: () => NodeSshAgentIdentitiesResult = () => ({
  identities: [{ fingerprint: `SHA256:${"D".repeat(43)}`, comment: "work laptop" }],
});
let rosterCalls: string[] = [];

/** Task 12: the key home's canned host-key answer (the approval + launch captures). */
const PIN_LINE = "git.example.test ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI00000000000000000000000000000000000000000";
const pinAnswer: () => { lines: string[] } = () => ({ lines: [PIN_LINE] });
let pinFetch: { nodeId: string; destination: string }[] = [];

function installFakeDeps() {
  pinFetch = [];
  setSshHostPinsDepsForTests({
    nowIso: () => new Date().toISOString(),
    fetchHostKey: async (nodeId, triple) => {
      pinFetch.push({ nodeId, destination: `${triple.host}:${triple.port}` });
      return pinAnswer();
    },
  });
  const broker = {
    async openRelay(input: { grantId: string; fingerprints: string[]; paneId: string; aNode: string; bNode: string }) {
      if (openRelayThrows) openRelayThrows(input);
      openCalls.push(input);
      return { relayId: "relay-x", ref: "ref-x", expiresAt: "2026-10-08T00:00:30.000Z", socketPath: FAKE_SOCK };
    },
    async closeForGrant(grantId: string, reason: string) {
      closeGrantCalls.push({ grantId, reason });
      return 0;
    },
  } as unknown as RelayBroker;
  setSshGrantsDepsForTests({
    nowIso: () => new Date().toISOString(),
    broker: () => broker,
    notifyGrantApproval: (_owner, requestId) => notifyCalls.push(requestId),
    fetchAgentIdentities: async (nodeId: string) => {
      rosterCalls.push(nodeId);
      return rosterAnswer();
    },
  });
}

async function mkNode(id: string, sshEnabled: boolean): Promise<void> {
  await nodes.create({ id, ownerUserId: ownerId, name: `grantsapi-${id.slice(-8)}`, kind: "agent", status: "offline" });
  if (sshEnabled) await nodes.setSshEnabled(id, { on: true, changedAt: "2026-10-08T09:00:00.000Z" });
  // The ssh-launch usability gate reads the machine's own detection (the
  // sibling suite's mkNode does the same): no inventory, no ssh pane.
  await db
    .updateTable("nodes")
    .set({
      inventoryJson: JSON.stringify([{ harnessId: "ssh", installed: true, binaryPath: "/usr/bin/ssh", version: "1" }]),
      inventoryAt: new Date().toISOString(),
    } as never)
    .where("id", "=", id)
    .execute();
}

/** An approved snapshot whose OWN agent socket must never ride a relay launch. */
function snapshot(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    alias: "git",
    host: "git.example.test",
    user: null,
    port: 22,
    identityFiles: [],
    certificateFiles: [],
    authAgentSocket: "/run/user/501/ssh-agent.sock",
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
  };
}
const ACCEPTED = snapshot();

function sshFetch(path: string, init: { method?: string; body?: unknown; cookie?: string; bearer?: string } = {}) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (init.cookie) headers.cookie = `better-auth.session_token=${init.cookie}`;
  if (init.bearer) headers.authorization = `Bearer ${init.bearer}`;
  return app.fetch(
    new Request(`http://localhost:3099${path}`, {
      method: init.method ?? "GET",
      headers,
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    }),
  );
}

const FP = (n: number) => `SHA256:${("b".repeat(43) + n).slice(-42)}${n % 10}`;

beforeAll(async () => {
  await setupAuthTables();
  await ensureMigratedTestDb();
  const mk = async (email: string) =>
    await new UsersRepository(db).createUser({
      email,
      name: email,
      passwordHash: await hashPassword(pw),
      role: "user",
    });
  ownerId = await mk(ownerEmail);
  await mk(otherEmail);
  emails.push(ownerEmail, otherEmail);
  ownerCookie = await signIn(ownerEmail, pw);
  otherCookie = await signIn(otherEmail, pw);
  await mkNode(NODE_A, true);
  await mkNode(NODE_B, true);
  await mkNode(NODE_OFF, false);
  const identities = new IdentitiesRepository(db);
  await identities.register({
    principalId: `node:${NODE_A}`,
    publicKey: '{"kty":"EC","crv":"P-256","x":"A1","y":"A2"}',
    signingPublicKey: '{"kty":"EC","crv":"P-256","x":"A3","y":"A4"}',
    displayName: "A",
  });
  await identities.register({
    principalId: `node:${NODE_B}`,
    publicKey: '{"kty":"EC","crv":"P-256","x":"B1","y":"B2"}',
    signingPublicKey: '{"kty":"EC","crv":"P-256","x":"B3","y":"B4"}',
    displayName: "B",
  });
  installFakeDeps();
});

afterAll(async () => {
  setSshGrantsDepsForTests(null);
  setSshHostPinsDepsForTests(null);
  await db.deleteFrom("sshHostPins").execute();
  resetNodeRegistryForTests();
  for (const id of createdSubshellIds) await new SubshellsRepository(db).delete(id).catch(() => {});
  await db.deleteFrom("sshGrantRequests").execute();
  await db.deleteFrom("sshKeyGrants").execute();
  await db.deleteFrom("sshSavedHosts").execute();
  await db.deleteFrom("auditEvents").execute();
  await db.deleteFrom("identities").execute();
  for (const id of [NODE_A, NODE_B, NODE_OFF]) await nodes.deleteById(id).catch(() => {});
  for (const mail of emails) await deleteUserByEmailOrId(mail);
});

describe("POST /api/ssh/grants + the list", () => {
  it("a bare agent node with SSH off is the gate's 403; a vanished node is the 404; an invalid selector is the named 400", async () => {
    const off = await sshFetch("/api/ssh/grants", {
      method: "POST",
      cookie: ownerCookie,
      body: { node: NODE_OFF, name: "no", selector: "git.example.test", fingerprints: [FP(1)] },
    });
    expect(off.status).toBe(403);
    expect(((await off.json()) as { code: string }).code).toBe(BackendErrorCodes.SSH_GATE_OFF);

    const ghost = await sshFetch("/api/ssh/grants", {
      method: "POST",
      cookie: ownerCookie,
      body: { node: "node-does-not-exist", name: "no", selector: "git.example.test", fingerprints: [FP(1)] },
    });
    expect(ghost.status).toBe(404);

    const bad = await sshFetch("/api/ssh/grants", {
      method: "POST",
      cookie: ownerCookie,
      body: { node: NODE_A, name: "no", selector: "bad host", fingerprints: [FP(1)] },
    });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { code: string }).code).toBe(BackendErrorCodes.SSH_GRANT_SELECTOR_INVALID);
  });

  it("create stores the grant and the owner's list reads it back (fingerprints as an array); a foreign list never shows it", async () => {
    const created = await sshFetch("/api/ssh/grants", {
      method: "POST",
      cookie: ownerCookie,
      body: { node: NODE_A, name: "git push", selector: "*.example.test", fingerprints: [FP(1), FP(2)] },
    });
    expect(created.status).toBe(201);
    const { grant } = (await created.json()) as { grant: Record<string, unknown> };
    expect(grant.createdVia).toBe("manual");
    expect(grant.fingerprints).toEqual([FP(1), FP(2)]);

    const mine = (await (await sshFetch("/api/ssh/grants", { cookie: ownerCookie })).json()) as {
      grants: { id: string }[];
    };
    expect(mine.grants.map((g) => g.id)).toContain(grant.id as string);
    const theirs = (await (await sshFetch("/api/ssh/grants", { cookie: otherCookie })).json()) as {
      grants: unknown[];
    };
    expect(theirs.grants).toHaveLength(0);

    // An over-cap selection is the hard named error, never a truncation.
    const over = await sshFetch("/api/ssh/grants", {
      method: "POST",
      cookie: ownerCookie,
      body: {
        node: NODE_A,
        name: "too many",
        selector: "git.example.test",
        fingerprints: Array.from({ length: SSH_MAX_GRANT_FINGERPRINTS + 1 }, (_, i) => FP(i + 50)),
      },
    });
    expect(over.status).toBe(400);
    expect(((await over.json()) as { code: string }).code).toBe(BackendErrorCodes.SSH_GRANT_KEYS_OVER_LIMIT);
    const afterOver = (await (await sshFetch("/api/ssh/grants", { cookie: ownerCookie })).json()) as {
      grants: unknown[];
    };
    expect(afterOver.grants).toHaveLength(mine.grants.length); // nothing stored, nothing truncated
  });

  it("PATCH edits the selector, a foreign id is the 404, and DELETE revokes through the broker's grant hook", async () => {
    const created = await createGrant({
      ownerUserId: ownerId,
      aNodeId: NODE_A,
      name: "ed",
      selector: "git.example.test",
      fingerprints: [FP(3)],
    });
    if (!created.ok) throw new Error("fixture grant refused");
    const id = created.value.grant.id;

    const foreign = await sshFetch(`/api/ssh/grants/${id}`, {
      method: "PATCH",
      cookie: otherCookie,
      body: { name: "hijack" },
    });
    expect(foreign.status).toBe(404);

    const patched = await sshFetch(`/api/ssh/grants/${id}`, {
      method: "PATCH",
      cookie: ownerCookie,
      body: { selector: "*.example.test" },
    });
    expect(patched.status).toBe(200);
    expect(((await patched.json()) as { grant: { resolvedSelector: string } }).grant.resolvedSelector).toBe(
      "*.example.test",
    );

    closeGrantCalls = [];
    const gone = await sshFetch(`/api/ssh/grants/${id}`, { method: "DELETE", cookie: ownerCookie });
    expect(gone.status).toBe(204);
    expect(await gone.text()).toBe(""); // 204 carries NO body
    expect(closeGrantCalls).toEqual([{ grantId: id, reason: "grant-revoked" }]);
    const again = await sshFetch(`/api/ssh/grants/${id}`, { method: "DELETE", cookie: ownerCookie });
    expect(again.status).toBe(404);
  });
});

describe("GET/POST /api/ssh/grant-requests", () => {
  let requestId = "";

  beforeAll(async () => {
    const asked = await requestFirstUse({
      ownerUserId: ownerId,
      aNodeId: NODE_A,
      bNodeId: NODE_B,
      resolvedSelector: "git.example.test",
      destination: "git.example.test:22",
      paneId: "pane-queue-probe",
    });
    if (!asked.ok) throw new Error("fixture ask refused");
    requestId = asked.value.requestId;
  });

  it("the owner's queue names the requester facts; a foreign queue is empty", async () => {
    const mine = (await (await sshFetch("/api/ssh/grant-requests", { cookie: ownerCookie })).json()) as {
      requests: { id: string; status: string; paneId: string; bNodeId: string; resolvedSelector: string }[];
    };
    const row = mine.requests.find((r) => r.id === requestId);
    expect(row).toBeDefined();
    expect(row?.status).toBe("pending");
    expect(row?.paneId).toBe("pane-queue-probe");
    expect(row?.bNodeId).toBe(NODE_B);
    expect(row?.resolvedSelector).toBe("git.example.test");
    const theirs = (await (await sshFetch("/api/ssh/grant-requests", { cookie: otherCookie })).json()) as {
      requests: unknown[];
    };
    expect(theirs.requests).toHaveLength(0);
  });

  it("approve refuses an off-grammar fingerprint with the named 400, then answers: grant row + approved request; a second answer is the named 409", async () => {
    const badShape = await sshFetch(`/api/ssh/grant-requests/${requestId}/approve`, {
      method: "POST",
      cookie: ownerCookie,
      body: { fingerprints: ["fingerprint-not-in-SHA256-form"] },
    });
    expect(badShape.status).toBe(400);
    expect(((await badShape.json()) as { code: string }).code).toBe(BackendErrorCodes.SSH_GRANT_KEYS_INVALID);

    const foreign = await sshFetch(`/api/ssh/grant-requests/${requestId}/approve`, {
      method: "POST",
      cookie: otherCookie,
      body: { fingerprints: [FP(7)] },
    });
    expect(foreign.status).toBe(404);

    const approved = await sshFetch(`/api/ssh/grant-requests/${requestId}/approve`, {
      method: "POST",
      cookie: ownerCookie,
      body: { fingerprints: [FP(7)], name: "by queue" },
    });
    expect(approved.status).toBe(200);
    const grant = (await approved.json()) as { grant: { id: string; createdVia: string } };
    expect(grant.grant.createdVia).toBe("first-use");

    const twice = await sshFetch(`/api/ssh/grant-requests/${requestId}/approve`, {
      method: "POST",
      cookie: ownerCookie,
      body: { fingerprints: [FP(7)] },
    });
    expect(twice.status).toBe(409);
    expect(((await twice.json()) as { code: string }).code).toBe(BackendErrorCodes.SSH_GRANT_ALREADY_ANSWERED);

    await db.deleteFrom("sshKeyGrants").where("id", "=", grant.grant.id).execute();
  });

  it("deny answers the row (audit-only, no grant); a second answer is the named 409", async () => {
    await db.deleteFrom("sshKeyGrants").execute(); // "no grant exists for a denial" reads off a clean tier
    const second = await requestFirstUse({
      ownerUserId: ownerId,
      aNodeId: NODE_A,
      bNodeId: NODE_B,
      resolvedSelector: "second.example.test",
      destination: "second.example.test:22",
      paneId: "pane-deny-probe",
    });
    if (!second.ok) throw new Error("fixture ask refused");
    const denied = await sshFetch(`/api/ssh/grant-requests/${second.value.requestId}/deny`, {
      method: "POST",
      cookie: ownerCookie,
      body: {},
    });
    expect(denied.status).toBe(200);
    expect((await denied.json()) as { requestId: string }).toEqual({ requestId: second.value.requestId });
    expect(await db.selectFrom("sshKeyGrants").selectAll().execute()).toHaveLength(0);
    const twice = await sshFetch(`/api/ssh/grant-requests/${second.value.requestId}/deny`, {
      method: "POST",
      cookie: ownerCookie,
      body: {},
    });
    expect(twice.status).toBe(409);
    await db.deleteFrom("sshGrantRequests").where("id", "=", second.value.requestId).execute();
  });
});

describe("the cookie doctrine over the grant doors", () => {
  it("an empty cookie is a 401 and a real subshell token is a 403 on grants, approvals, and launch", async () => {
    const subshellId = crypto.randomUUID();
    await new SubshellsRepository(db).create({
      id: subshellId,
      userId: ownerId,
      harnessId: "terminal",
      name: "bearer-probe",
      workingDir: mkdtempSync(`${tmpdir()}/grants-bearer-`),
      tmuxSocket: null,
      nodeId: LOCAL_NODE_ID,
    });
    createdSubshellIds.push(subshellId);
    const key = await issueSubshellToken(subshellId, ownerId);
    for (const res of [
      await sshFetch("/api/ssh/grants", { cookie: "" }),
      await sshFetch("/api/ssh/grant-requests", { cookie: "" }),
      await sshFetch("/api/ssh/grants", { bearer: key }),
      await sshFetch("/api/ssh/grant-requests", { bearer: key }),
      await sshFetch("/api/ssh/launch", {
        method: "POST",
        bearer: key,
        body: { node: NODE_B, destination: "git", keyHome: NODE_A },
      }),
    ]) {
      expect(res.status).toBeLessThanOrEqual(403);
    }
    const grantBearer = await sshFetch("/api/ssh/grants", { bearer: key });
    expect(((await grantBearer.json()) as { message: string }).message).toContain("browser sessions");
    const launchBearer = await sshFetch("/api/ssh/launch", {
      method: "POST",
      bearer: key,
      body: { node: NODE_B, destination: "git", keyHome: NODE_A },
    });
    expect(launchBearer.status).toBe(403);
  });
});

describe("POST /api/ssh/launch in relay mode (the grant-gated relay leg)", () => {
  function bScript() {
    return attachScriptedNode(NODE_B, {
      ssh_resolve_config: () => ({ accepted: true, snapshot: ACCEPTED }),
      launch: ok,
      stat_dir: statDirEcho,
    });
  }

  /** Panes currently on B - negative launch assertions read against THIS baseline. */
  async function bPaneCount(): Promise<number> {
    return (await db.selectFrom("subshells").select("id").where("nodeId", "=", NODE_B).execute()).length;
  }

  it("no standing grant: a pending row stands, the pane is NOT created, and the answer is the named 409", async () => {
    await db.deleteFrom("sshGrantRequests").execute();
    await db.deleteFrom("sshKeyGrants").execute();
    const scripted = bScript();
    notifyCalls = [];
    openCalls = [];
    const panesBefore = await bPaneCount();
    try {
      const res = await sshFetch("/api/ssh/launch", {
        method: "POST",
        cookie: ownerCookie,
        body: { node: NODE_B, destination: "git", keyHome: NODE_A },
      });
      expect(res.status).toBe(409);
      const body = (await res.json()) as { code: string; message: string };
      expect(body.code).toBe(BackendErrorCodes.SSH_GRANT_APPROVAL_REQUIRED);
      // The copy names the key home (row name) and the remedy; two sentences, no secrets.
      expect(body.message).toContain(`grantsapi-${NODE_A.slice(-8)}`);
      expect(body.message.toLowerCase()).toContain("approve");
      expect(openCalls).toHaveLength(0);
      expect(notifyCalls).toHaveLength(1);
      expect(await bPaneCount()).toBe(panesBefore);
      expect(scripted.cmdsOf("launch")).toHaveLength(0);
      // The ask went through exactly once, durable, pending.
      const rows = await db.selectFrom("sshGrantRequests").selectAll().execute();
      expect(rows).toHaveLength(1);
      expect(rows[0]?.status).toBe("pending");
    } finally {
      scripted.detach();
      await db.deleteFrom("sshGrantRequests").execute();
    }
  });

  it("a standing grant: the broker opens for (grant, A, B, pane) and the pane's SSH_AUTH_SOCK is the BROKER's socket, not the snapshot's", async () => {
    await db.deleteFrom("sshKeyGrants").execute();
    const grant = await createGrant({
      ownerUserId: ownerId,
      aNodeId: NODE_A,
      name: "launch leg",
      selector: "git.example.test",
      fingerprints: [FP(11), FP(12)],
    });
    if (!grant.ok) throw new Error("fixture grant refused");
    const scripted = bScript();
    openCalls = [];
    try {
      const res = await sshFetch("/api/ssh/launch", {
        method: "POST",
        cookie: ownerCookie,
        body: { node: NODE_B, destination: "git", keyHome: NODE_A },
      });
      expect(res.status).toBe(201);
      const { subshell } = (await res.json()) as { subshell: { id: string } };
      createdSubshellIds.push(subshell.id);

      expect(openCalls).toHaveLength(1);
      expect(openCalls[0]).toMatchObject({
        grantId: grant.value.grant.id,
        fingerprints: [FP(11), FP(12)],
        paneId: subshell.id, // the PRE-MINTED id: the broker byte-checks B's socket against it
        aNode: NODE_A,
        bNode: NODE_B,
      });
      const cmd = scripted.cmdsOf("launch")[0] as { subshellEnv?: Record<string, string> };
      // The relay override: the snapshot names /run/user/501/ssh-agent.sock;
      // the pane gets the proxy socket the broker verified (spec §5.2).
      expect(cmd.subshellEnv?.SSH_AUTH_SOCK).toBe(FAKE_SOCK);
      // Task 12 end to end at the door: the broker received the captured pin,
      // and the launch's OWN rendered config is the relay one - yes against
      // the pinned file the B open writes beside the socket, never accept-new
      // against B's ambient known_hosts.
      expect(openCalls[0]?.hostPin).toBe(PIN_LINE);
      const launch = scripted.cmdsOf("launch")[0] as unknown as {
        ssh?: { configPath: string; fileContent: string };
      };
      const dir = launch.ssh?.configPath?.slice(0, launch.ssh.configPath.lastIndexOf("/")) ?? "";
      expect(launch.ssh?.fileContent).toContain("StrictHostKeyChecking yes");
      expect(launch.ssh?.fileContent).not.toContain("accept-new");
      expect(launch.ssh?.fileContent).toContain(`UserKnownHostsFile ${dir}/known_hosts`);
    } finally {
      scripted.detach();
    }
  });

  it("a broker refusal (quota) comes back as the named 409 and no pane is created", async () => {
    await db.deleteFrom("sshKeyGrants").execute();
    const grant = await createGrant({
      ownerUserId: ownerId,
      aNodeId: NODE_A,
      name: "quota leg",
      selector: "git.example.test",
      fingerprints: [FP(11)],
    });
    if (!grant.ok) throw new Error("fixture grant refused");
    const scripted = bScript();
    openRelayThrows = () => {
      throw new SshRelayRefusal("quota", "node already holds 8 live relay sessions (max 8)", NODE_B);
    };
    const panesBefore = await bPaneCount();
    try {
      const res = await sshFetch("/api/ssh/launch", {
        method: "POST",
        cookie: ownerCookie,
        body: { node: NODE_B, destination: "git", keyHome: NODE_A },
      });
      expect(res.status).toBe(409);
      expect(((await res.json()) as { code: string }).code).toBe(BackendErrorCodes.SSH_RELAY_OPEN_FAILED);
      expect(await bPaneCount()).toBe(panesBefore);
      expect(scripted.cmdsOf("launch")).toHaveLength(0);
    } finally {
      openRelayThrows = null;
      scripted.detach();
    }
  });

  it("direct mode is untouched: no keyHome means no grant read, no relay, and the snapshot socket still rides", async () => {
    const scripted = bScript();
    openCalls = [];
    try {
      const res = await sshFetch("/api/ssh/launch", {
        method: "POST",
        cookie: ownerCookie,
        body: { node: NODE_B, destination: "git" },
      });
      expect(res.status).toBe(201);
      const { subshell } = (await res.json()) as { subshell: { id: string } };
      createdSubshellIds.push(subshell.id);
      expect(openCalls).toHaveLength(0);
      const cmd = scripted.cmdsOf("launch")[0] as { subshellEnv?: Record<string, string> };
      expect(cmd.subshellEnv?.SSH_AUTH_SOCK).toBe("/run/user/501/ssh-agent.sock");
    } finally {
      scripted.detach();
    }
  });
});

/* ------------------------------------------------------------------ */
/* GET /api/ssh/grant-requests/:id/identities (Task 11 roster fetch)   */
/* ------------------------------------------------------------------ */

describe("GET /api/ssh/grant-requests/:id/identities (the roster behind the approval screen)", () => {
  async function mkAsk(paneId: string): Promise<string> {
    const asked = await requestFirstUse({
      ownerUserId: ownerId,
      aNodeId: NODE_A,
      bNodeId: NODE_B,
      resolvedSelector: "git.example.test",
      destination: "git.example.test:22",
      paneId,
    });
    if (!asked.ok) throw new Error("fixture ask refused");
    return asked.value.requestId;
  }
  async function queueStatus(id: string): Promise<string | undefined> {
    const body = (await (await sshFetch("/api/ssh/grant-requests", { cookie: ownerCookie })).json()) as {
      requests: { id: string; status: string }[];
    };
    return body.requests.find((r) => r.id === id)?.status;
  }

  beforeEach(() => {
    installFakeDeps(); // reset the scripted roster RPC and its call log between cases
    rosterCalls = [];
  });

  it("answers the key home's public roster, blobs withheld, and the queue row is untouched", async () => {
    const requestId = await mkAsk("pane-roster-1");
    rosterAnswer = () => ({
      identities: [
        { fingerprint: `SHA256:${"D".repeat(43)}`, comment: "work laptop" },
        { fingerprint: `SHA256:${"E".repeat(43)}`, comment: "" },
      ],
    });
    const res = await sshFetch(`/api/ssh/grant-requests/${requestId}/identities`, { cookie: ownerCookie });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { identities: Record<string, string>[] };
    expect(body.identities.map((e) => e.fingerprint)).toEqual([`SHA256:${"D".repeat(43)}`, `SHA256:${"E".repeat(43)}`]);
    expect(body.identities[0]?.comment).toBe("work laptop");
    expect(body.identities[1]?.comment).toBe(""); // the agent's empty comment is data, not a gap
    // The entry shape is exactly the two public fields: nowhere for a blob to ride.
    for (const entry of body.identities) expect(Object.keys(entry).sort()).toEqual(["comment", "fingerprint"]);
    expect(JSON.stringify(body)).not.toContain("blob");
    expect(rosterCalls).toEqual([NODE_A]); // asked the KEY HOME, exactly once
    expect(await queueStatus(requestId)).toBe("pending"); // the read changed nothing
  });

  it("the roster rides the REAL signed RPC: scripted A answers over the link and the command that left was its type alone", async () => {
    // Deps WITHOUT the roster seam: production wiring is under test, so the
    // command passes through signing, the RPC correlator, and the frozen
    // result parser exactly as it does between the shipped processes.
    const scripted = attachScriptedNode(NODE_A, {
      ssh_agent_identities: () => ({
        identities: [{ fingerprint: `SHA256:${"F".repeat(43)}`, comment: "real path key" }],
      }),
    });
    setSshGrantsDepsForTests({
      nowIso: () => new Date().toISOString(),
      broker: () =>
        ({
          openRelay: async () => {
            throw new Error("the roster fetch opens no relay");
          },
          closeForGrant: async () => 0,
        }) as unknown as RelayBroker,
      notifyGrantApproval: () => {},
    });
    const requestId = await mkAsk("pane-roster-e2e");
    try {
      const res = await sshFetch(`/api/ssh/grant-requests/${requestId}/identities`, { cookie: ownerCookie });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { identities: { fingerprint: string; comment: string }[] };
      expect(body.identities).toEqual([{ fingerprint: `SHA256:${"F".repeat(43)}`, comment: "real path key" }]);
      // Its type ALONE travelled the link: the roster command asks the whole
      // roster, and no plane-side selection field reached the machine.
      expect(scripted.cmdsOf("ssh_agent_identities")).toEqual([{ type: "ssh_agent_identities" }]);
    } finally {
      scripted.detach();
      installFakeDeps();
    }
  });

  it("an unreachable key home answers the named refusal with the request PENDING; an answered one is never re-asked", async () => {
    const requestId = await mkAsk("pane-roster-offline");
    rosterAnswer = () => {
      throw new SshRpcError("offline", "node has no live connection", NODE_A);
    };
    const offline = await sshFetch(`/api/ssh/grant-requests/${requestId}/identities`, { cookie: ownerCookie });
    expect(offline.status).toBe(409);
    expect(((await offline.json()) as { code: string }).code).toBe(BackendErrorCodes.NODE_OFFLINE);
    expect(await queueStatus(requestId)).toBe("pending"); // §5.4: stays pending until A is reachable
    const approved = await sshFetch(`/api/ssh/grant-requests/${requestId}/approve`, {
      method: "POST",
      cookie: ownerCookie,
      body: { fingerprints: [`SHA256:${"D".repeat(43)}`] },
    });
    expect(approved.status).toBe(200);
    rosterCalls = [];
    rosterAnswer = () => {
      throw new Error("the machine must not be asked after the answer");
    };
    const after = await sshFetch(`/api/ssh/grant-requests/${requestId}/identities`, { cookie: ownerCookie });
    expect(after.status).toBe(409);
    expect(((await after.json()) as { code: string }).code).toBe(BackendErrorCodes.SSH_GRANT_ALREADY_ANSWERED);
    expect(rosterCalls).toEqual([]);
  });

  it("cookie doctrine and ownership: an empty cookie is a 401, a stranger's cookie sees the absent-row 404, and no machine is asked", async () => {
    const requestId = await mkAsk("pane-roster-stranger");
    rosterCalls = [];
    expect((await sshFetch(`/api/ssh/grant-requests/${requestId}/identities`, { cookie: "" })).status).toBe(401);
    const foreign = await sshFetch(`/api/ssh/grant-requests/${requestId}/identities`, { cookie: otherCookie });
    expect(foreign.status).toBe(404);
    expect(rosterCalls).toEqual([]);
  });
});
