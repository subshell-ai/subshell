import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { BackendErrorCodes } from "@internal/backend-errors";
import type { NodeSshAgentIdentitiesResult } from "@internal/subshell-protocol";
import { hashPassword } from "better-auth/crypto";
import { ensureMigratedTestDb } from "@/__tests__/helpers/test-database.js";
import { deleteUserByEmailOrId, setupAuthTables } from "@/api/__tests__/helpers/auth-tables.js";
import { db } from "@/db/index.js";
import { NodesRepository } from "@/db/repositories/nodes.repository.js";
import { SshGrantsRepository } from "@/db/repositories/ssh-grants.repository.js";
import { UsersRepository } from "@/db/repositories/users.repository.js";
import { SshRpcError } from "@/services/nodes/ssh-rpc.js";
import {
  approveGrant,
  listRequestAgentIdentities,
  requestFirstUse,
  setSshGrantsDepsForTests,
} from "@/services/ssh-grants.service.js";
import type { RelayBroker } from "@/services/ssh-relay.service.js";

/**
 * The roster fetch behind the approvals screen (spec 2026-10-08 §5.4, Task
 * 11): `listRequestAgentIdentities` sends A the signed `ssh_agent_identities`
 * command over the existing node-link RPC and hands the operator's screen
 * the WHOLE public roster - fingerprints plus comments, blobs withheld (the
 * protocol validator makes them unrepresentable; this suite pins the pass-
 * through adds nothing). What the approval screen must never lose:
 *
 * - NOTHING rides a roster read: no audit row, no row change, no grant. The
 *   fetch is a question to the machine, and the durable record of an answer
 *   stays the approve/deny pair.
 * - A is offline / refused / too old / silent: the named refusal answers and
 *   the grant request STAYS PENDING. Never an empty fabricated roster, which
 *   is exactly the fiction §5.4 forbids - a real empty roster from a live
 *   agent is data (last case), the offline case is an error.
 * - Ownership: a foreign request is the 404 the grants tier already answers;
 *   an answered request never reaches the machine (no roster read after the
 *   operator has said yes or no); expiry sweeps lazily first, like every
 *   other read on this table.
 *
 * The roster RPC is the service's injected seam (the clock/broker/notify
 * trio's fourth member, the `??` at the call site is the production wiring);
 * nothing here dials a socket.
 */

const repo = new SshGrantsRepository(db);
const emails: string[] = [];

async function mkUser(tag: string): Promise<string> {
  const email = `roster-svc-${tag}-${crypto.randomUUID()}@subshell.local`;
  emails.push(email);
  return await new UsersRepository(db).createUser({
    email,
    name: email,
    passwordHash: await hashPassword("roster-svc-1"),
    role: "user",
  });
}

let owner: string;
let stranger: string;
const NODE_A = "roster-node-a";
const NODE_B = "roster-node-b";

const HOST = "git.example.test";
const PANE = "11111111-2222-4333-8444-555555555555";

let clockMs = Date.parse("2026-10-08T00:00:00.000Z");
const nowIso = () => new Date(clockMs).toISOString();

/** The scripted roster RPC: a canned answer, or a canned transport failure. */
let rosterResult: NodeSshAgentIdentitiesResult = { identities: [] };
let rosterFailure: (() => Error) | null = null;
let rosterCalls: string[] = [];

function installRosterDeps(): void {
  rosterResult = {
    identities: [{ fingerprint: `SHA256:${"A".repeat(43)}`, comment: "laptop key" }],
  };
  rosterFailure = null;
  rosterCalls = [];
  setSshGrantsDepsForTests({
    nowIso,
    broker: () =>
      ({
        openRelay: async () => {
          throw new Error("the roster fetch opens no relay");
        },
        closeForGrant: async () => 0,
      }) as unknown as RelayBroker,
    notifyGrantApproval: () => {},
    fetchAgentIdentities: async (nodeId: string): Promise<NodeSshAgentIdentitiesResult> => {
      rosterCalls.push(nodeId);
      if (rosterFailure) throw rosterFailure();
      return rosterResult;
    },
  });
}

async function mkPendingRequest(): Promise<string> {
  const answer = await requestFirstUse({
    ownerUserId: owner,
    aNodeId: NODE_A,
    bNodeId: NODE_B,
    resolvedSelector: HOST,
    paneId: PANE,
  });
  if (!answer.ok) throw new Error("the pending row was not created");
  return answer.value.requestId;
}

async function auditCount(): Promise<number> {
  return (await db.selectFrom("auditEvents").select("id").execute()).length;
}

async function requestStatus(requestId: string): Promise<string | undefined> {
  return (await repo.getRequest(owner, requestId))?.status;
}

beforeAll(async () => {
  await setupAuthTables();
  await ensureMigratedTestDb();
  owner = await mkUser("owner");
  stranger = await mkUser("stranger");
  const nodes = new NodesRepository(db);
  await nodes.create({ id: NODE_A, ownerUserId: owner, name: "key home", kind: "agent", status: "offline" });
  await nodes.setSshEnabled(NODE_A, { on: true, changedAt: nowIso() });
  await nodes.create({ id: NODE_B, ownerUserId: owner, name: "connector", kind: "agent", status: "offline" });
  await nodes.setSshEnabled(NODE_B, { on: true, changedAt: nowIso() });
});

afterAll(async () => {
  setSshGrantsDepsForTests(null);
  await db.deleteFrom("sshGrantRequests").execute();
  await db.deleteFrom("sshKeyGrants").execute();
  await db.deleteFrom("auditEvents").execute();
  for (const id of [NODE_A, NODE_B]) await new NodesRepository(db).deleteById(id).catch(() => {});
  for (const mail of emails) await deleteUserByEmailOrId(mail);
});

beforeEach(async () => {
  clockMs = Date.parse("2026-10-08T00:00:00.000Z");
  await db.deleteFrom("sshGrantRequests").execute();
  await db.deleteFrom("sshKeyGrants").execute();
  await db.deleteFrom("auditEvents").execute();
  installRosterDeps();
});

describe("listRequestAgentIdentities", () => {
  it("hands the screen the roster verbatim, asked the KEY HOME once, and writes nothing", async () => {
    const requestId = await mkPendingRequest();
    const auditsBefore = await auditCount(); // the request itself audited the ask
    const answer = await listRequestAgentIdentities({ ownerUserId: owner, requestId });
    expect(answer.ok).toBe(true);
    if (!answer.ok) return;
    expect(answer.value.identities).toEqual(rosterResult.identities);
    // The entry shape is EXACTLY fingerprint + comment: no blob, no extra field,
    // nowhere for key material to ride (the protocol grammar refuses one, and
    // this is the pass-through that must not re-add it).
    for (const entry of answer.value.identities) {
      expect(Object.keys(entry).sort()).toEqual(["comment", "fingerprint"]);
    }
    expect(JSON.stringify(answer.value)).not.toContain("blob");
    expect(rosterCalls).toEqual([NODE_A]);
    // No audit row, no row change: the fetch is a question, not an answer.
    expect(await auditCount()).toBe(auditsBefore);
    expect(await requestStatus(requestId)).toBe("pending");
  });

  it("an offline A is the named 409 NODE_OFFLINE and the request STAYS PENDING", async () => {
    const requestId = await mkPendingRequest();
    const auditsBefore = await auditCount();
    rosterFailure = () => new SshRpcError("offline", "node has no live connection", NODE_A);
    const answer = await listRequestAgentIdentities({ ownerUserId: owner, requestId });
    expect(answer.ok).toBe(false);
    if (answer.ok) return;
    expect(answer.refusal.status).toBe(409);
    expect(answer.refusal.code).toBe(BackendErrorCodes.NODE_OFFLINE);
    expect(rosterCalls).toEqual([NODE_A]);
    expect(await auditCount()).toBe(auditsBefore);
    expect(await requestStatus(requestId)).toBe("pending");
  });

  it("the failure families: unsupported is the update remedy, timeout the retry, refusal the 502, and none fabricates a roster", async () => {
    for (const [kind, status, code] of [
      ["unsupported", 409, BackendErrorCodes.NODE_OUTDATED],
      ["timeout", 409, BackendErrorCodes.NODE_UNREACHABLE],
      ["refused", 502, BackendErrorCodes.SSH_NODE_REFUSED],
      ["malformed", 502, BackendErrorCodes.SSH_NODE_REFUSED],
    ] as const) {
      await db.deleteFrom("sshGrantRequests").execute();
      await db.deleteFrom("auditEvents").execute();
      const requestId = await mkPendingRequest();
      rosterFailure = () => new SshRpcError(kind, `machine said no (${kind})`, NODE_A, "ssh disabled on this node");
      const answer = await listRequestAgentIdentities({ ownerUserId: owner, requestId });
      expect(answer.ok).toBe(false);
      if (answer.ok) return;
      expect(answer.refusal.status).toBe(status);
      expect(answer.refusal.code).toBe(code);
      // The agent's own text is never echoed into a response body.
      expect(answer.refusal.message).not.toContain("ssh disabled");
      expect(await requestStatus(requestId)).toBe("pending");
      expect(await auditCount()).toBe(1); // the request's own ask row, and nothing from the fetch
    }
  });

  it("an already-approved request is the named 409 and the machine is never asked again", async () => {
    const requestId = await mkPendingRequest();
    const approved = await approveGrant({ ownerUserId: owner, requestId, fingerprints: [`SHA256:${"C".repeat(43)}`] });
    expect(approved.ok).toBe(true);
    rosterCalls = [];
    const answer = await listRequestAgentIdentities({ ownerUserId: owner, requestId });
    expect(answer.ok).toBe(false);
    if (answer.ok) return;
    expect(answer.refusal.code).toBe(BackendErrorCodes.SSH_GRANT_ALREADY_ANSWERED);
    expect(rosterCalls).toEqual([]);
  });

  it("a foreign or absent request id is the same 404 the grants tier answers, and no machine is asked", async () => {
    const requestId = await mkPendingRequest();
    const foreign = await listRequestAgentIdentities({ ownerUserId: stranger, requestId });
    expect(foreign.ok).toBe(false);
    if (foreign.ok) return;
    expect(foreign.refusal.status).toBe(404);
    const absent = await listRequestAgentIdentities({ ownerUserId: owner, requestId: crypto.randomUUID() });
    expect(absent.ok).toBe(false);
    expect(rosterCalls).toEqual([]);
  });

  it("a past-deadline pending row is swept before the read: the question is expired, the roster never fetched", async () => {
    const requestId = await mkPendingRequest();
    clockMs += 24 * 60 * 60 * 1000 + 1; // past the 24 h answer window
    const answer = await listRequestAgentIdentities({ ownerUserId: owner, requestId });
    expect(answer.ok).toBe(false);
    if (answer.ok) return;
    expect(answer.refusal.code).toBe(BackendErrorCodes.SSH_GRANT_ALREADY_ANSWERED);
    expect(await requestStatus(requestId)).toBe("expired");
    expect(rosterCalls).toEqual([]);
  });

  it("an empty roster from a live agent is an honest answer, not an error", async () => {
    const requestId = await mkPendingRequest();
    rosterResult = { identities: [] };
    const answer = await listRequestAgentIdentities({ ownerUserId: owner, requestId });
    expect(answer.ok).toBe(true);
    if (!answer.ok) return;
    expect(answer.value.identities).toEqual([]);
    expect(rosterCalls).toEqual([NODE_A]);
  });
});
