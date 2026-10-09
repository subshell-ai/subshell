import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { MachinePinStore } from "@internal/pane-runtime";
import { fingerprintJwk } from "@internal/subshell-protocol";
import { hashPassword } from "better-auth/crypto";
import { nodesRoutes } from "@/api/nodes/index.js";
import { db } from "@/db/index.js";
import { IdentitiesRepository } from "@/db/repositories/identities.repository.js";
import { NodeSharesRepository } from "@/db/repositories/node-shares.repository.js";
import { UsersRepository } from "@/db/repositories/users.repository.js";
import { LOCAL_NODE_ID } from "@/db/types/nodes.db-types.js";
import { ensureLocalNode } from "@/services/nodes/seed-local.js";
import { SshRpcError } from "@/services/nodes/ssh-rpc.js";
import {
  ensureLocalRelayIdentity,
  localRelayIdentityDir,
  resetLocalRelayIdentity,
} from "@/services/ssh-local-identity.js";
import { setSshMachinePinsDepsForTests } from "@/services/ssh-machine-pins.service.js";
import { issueSubshellToken } from "@/services/subshell-tokens.js";
import { deleteUserByEmailOrId, setupAuthTables, signIn } from "../../__tests__/helpers/auth-tables.js";

/**
 * `POST /api/nodes/:id/machine-pins/:peerNodeId/repair` (spec 2026-10-08
 * §4.5, Task 17) - the §4.5 machine trust re-pair's HTTP door. The
 * posture this file pins is the ONE the design makes load-bearing:
 *
 * - EXACT owner only, on BOTH machines' facts: `gate.row.ownerUserId ===
 *   user.id`. An `edit` grantee is 403 (re-authorizing a peer's key on
 *   someone else's machine is not a share level confers); the ADMIN is 403
 *   on a foreign agent (the instance-wide boost stops at a trust act, and
 *   the `canManage` local exception must not leak here); `local` never
 *   repairs (its owner is the system service user, so every human hits the
 *   owner door); a stranger is 404 (an invisible node stays invisible);
 *   a bearer is refused (cookie-only like every node write).
 * - The success path names the acting human in exactly one
 *   `node.ssh_machine_pin.repair` row carrying `{nodeIdOfA, peerNodeId}` -
 *   the serialized row asserts free of the key sentinels.
 * - A offline answers 409 NODE_OFFLINE and writes NO audit row (the service
 *   audited nothing, which is the no-success-audit rule at the HTTP edge).
 *
 * The command delivery is the service seam; nothing here touches a socket.
 */

const pw = "repair-1";
const ownerEmail = `rp-owner-${crypto.randomUUID()}@subshell.local`;
const editorEmail = `rp-editor-${crypto.randomUUID()}@subshell.local`;
const otherEmail = `rp-other-${crypto.randomUUID()}@subshell.local`;
const adminEmail = `rp-admin-${crypto.randomUUID()}@subshell.local`;
let ownerId: string;
let editorId: string;
let ownerCookie: string;
let editorCookie: string;
let otherCookie: string;
let adminCookie: string;
let subshellKey = "";

const NODE_A = `n-rp-a-${crypto.randomUUID()}`;
const PEER_B = `n-rp-b-${crypto.randomUUID()}`;
const PEER_NAKED = `n-rp-k-${crypto.randomUUID()}`;

const PEER_SIGNING = '{"kty":"EC","crv":"P-256","x":"RPSIGN-SENTINEL","y":"RPSIGN-SENTINEL2"}';
const PEER_ENCRYPT = '{"kty":"EC","crv":"P-256","x":"RPENC-SENTINEL","y":"RPENC-SENTINEL2"}';
const PEER_ENCRYPT_B64 = Buffer.from(PEER_ENCRYPT, "utf8").toString("base64");

let sentCmds: unknown[] = [];
let sendBehavior: (nodeId: string, cmd: unknown) => Promise<{ repaired: true; peerNodeId: string }> = async (
  _n,
  cmd,
) => ({
  repaired: true,
  peerNodeId: (cmd as { peerNodeId: string }).peerNodeId,
});

async function repairRows(): Promise<{ actorUserId: string | null; metadataJson: string | null }[]> {
  return await db
    .selectFrom("auditEvents")
    .select(["actorUserId", "metadataJson"])
    .where("action", "=", "node.ssh_machine_pin.repair")
    .where("targetId", "=", NODE_A)
    .execute();
}

function post(nodeId: string, peerId: string, cookie: string | null, bearer?: string) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (cookie) headers.cookie = `better-auth.session_token=${cookie}`;
  if (bearer) headers.authorization = `Bearer ${bearer}`;
  return nodesRoutes.fetch(
    new Request(`http://localhost:3080/api/nodes/${nodeId}/machine-pins/${peerId}/repair`, { method: "POST", headers }),
  );
}

beforeAll(async () => {
  await setupAuthTables();
  ownerId = await new UsersRepository(db).createUser({
    email: ownerEmail,
    name: ownerEmail,
    passwordHash: await hashPassword(pw),
    role: "user",
  });
  editorId = await new UsersRepository(db).createUser({
    email: editorEmail,
    name: editorEmail,
    passwordHash: await hashPassword(pw),
    role: "user",
  });
  await new UsersRepository(db).createUser({
    email: otherEmail,
    name: otherEmail,
    passwordHash: await hashPassword(pw),
    role: "user",
  });
  await new UsersRepository(db).createUser({
    email: adminEmail,
    name: adminEmail,
    passwordHash: await hashPassword(pw),
    role: "admin",
  });
  ownerCookie = await signIn(ownerEmail, pw);
  editorCookie = await signIn(editorEmail, pw);
  otherCookie = await signIn(otherEmail, pw);
  adminCookie = await signIn(adminEmail, pw);
  await ensureLocalNode(db);

  const now = new Date().toISOString();
  for (const [id, kind] of [
    [NODE_A, "agent"],
    [PEER_B, "agent"],
    [PEER_NAKED, "agent"],
  ] as const) {
    await db
      .insertInto("nodes")
      .values({ id, ownerUserId: ownerId, name: id, kind, status: "offline", createdAt: now, updatedAt: now } as never)
      .execute();
  }
  await new NodeSharesRepository(db).replaceForNode(NODE_A, [{ granteeUserId: editorId, permission: "edit" }], ownerId);
  await new IdentitiesRepository(db).register({
    principalId: `node:${PEER_B}`,
    publicKey: PEER_ENCRYPT,
    signingPublicKey: PEER_SIGNING,
    displayName: null,
  });

  // A pane row of the owner's, for the bearer refusal: a machine credential
  // may not speak to this door at all.
  const paneId = crypto.randomUUID();
  await db
    .insertInto("subshells")
    .values({
      id: paneId,
      userId: ownerId,
      name: "rp-probe",
      harnessId: "claude-code",
      workingDir: "/tmp",
      tmuxSocket: "subshell-rp-probe",
      nodeId: NODE_A,
      status: "terminated",
      alive: 0,
    } as never)
    .execute();
  subshellKey = await issueSubshellToken(paneId, ownerId);
});

afterAll(async () => {
  setSshMachinePinsDepsForTests(null);
  await db.deleteFrom("subshells").where("nodeId", "=", NODE_A).execute();
  await db.deleteFrom("nodes").where("id", "in", [NODE_A, PEER_B, PEER_NAKED]).execute();
  await db.deleteFrom("identities").where("principalId", "=", `node:${PEER_B}`).execute();
  for (const email of [ownerEmail, editorEmail, otherEmail, adminEmail]) await deleteUserByEmailOrId(email);
});

beforeEach(() => {
  sentCmds = [];
  sendBehavior = async (_n, cmd) => ({ repaired: true, peerNodeId: (cmd as { peerNodeId: string }).peerNodeId });
  setSshMachinePinsDepsForTests({
    sendRepair: async (nodeId, cmd) => {
      sentCmds.push(cmd);
      return sendBehavior(nodeId, cmd);
    },
  });
});

describe("the door: EXACTLY the owner", () => {
  it("the owner re-pairs: 200, the registered pair sent, one ids-only audit row", async () => {
    const res = await post(NODE_A, PEER_B, ownerCookie);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ repaired: true });
    expect(sentCmds).toEqual([
      {
        type: "ssh_machine_pin_repair",
        peerNodeId: PEER_B,
        peerSigningPublicKey: PEER_SIGNING,
        peerEncryptPublicKey: PEER_ENCRYPT_B64,
      },
    ]);
    const rows = await repairRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].actorUserId).toBe(ownerId); // the human, wired at the route
    expect(rows[0].metadataJson).toBe(JSON.stringify({ nodeIdOfA: NODE_A, peerNodeId: PEER_B }));
    const serialized = JSON.stringify(rows);
    for (const secret of [PEER_SIGNING, PEER_ENCRYPT, PEER_ENCRYPT_B64, "SENTINEL"]) {
      expect(serialized).not.toContain(secret); // §10: ids only, no key bytes in the row
    }
  });

  it("an edit grantee is 403: a share level does not re-authorize trust on another machine", async () => {
    const before = (await repairRows()).length;
    expect((await post(NODE_A, PEER_B, editorCookie)).status).toBe(403);
    expect(sentCmds).toHaveLength(0);
    expect((await repairRows()).length).toBe(before);
  });

  it("an admin cannot repair a foreign node but manages server pins", async () => {
    // The exact-owner rule, not `canManage`: the admin boost (effective edit)
    // and the seeded-local manage exception both stop at a trust act.
    const before = (await repairRows()).length;
    expect((await post(NODE_A, PEER_B, adminCookie)).status).toBe(403);
    expect((await post(LOCAL_NODE_ID, PEER_B, adminCookie)).status).toBe(200);
    expect((await post(LOCAL_NODE_ID, PEER_B, ownerCookie)).status).toBe(403);
    expect(sentCmds).toHaveLength(1);
    expect((await repairRows()).length).toBe(before);
  });

  it("a stranger is 404 and an unknown node is 404: invisible stays invisible", async () => {
    expect((await post(NODE_A, PEER_B, otherCookie)).status).toBe(404);
    expect((await post(`n-rp-ghost-${crypto.randomUUID()}`, PEER_B, ownerCookie)).status).toBe(404);
  });

  it("a bearer machine credential is refused outright (cookie-only, like every node write)", async () => {
    const before = (await repairRows()).length;
    expect((await post(NODE_A, PEER_B, null, subshellKey)).status).toBe(403);
    expect((await post(NODE_A, PEER_B, null)).status).toBe(401);
    expect(sentCmds).toHaveLength(0);
    expect((await repairRows()).length).toBe(before);
  });
});

describe("the service doors the route renders", () => {
  it("A offline: 409 NODE_OFFLINE, no command audited as a success", async () => {
    sendBehavior = async () => {
      throw new SshRpcError("offline", "no live socket", NODE_A);
    };
    const before = (await repairRows()).length;
    const res = await post(NODE_A, PEER_B, ownerCookie);
    expect(res.status).toBe(409);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("NODE_OFFLINE");
    expect((await repairRows()).length).toBe(before);
  });

  it("a peer without its registered signing half: 409 SSH_RELAY_IDENTITY_MISSING", async () => {
    const res = await post(NODE_A, PEER_NAKED, ownerCookie);
    expect(res.status).toBe(409);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("SSH_RELAY_IDENTITY_MISSING");
  });

  it("same-node is a 400, and a machine refusal is 502 SSH_NODE_REFUSED", async () => {
    expect((await post(NODE_A, NODE_A, ownerCookie)).status).toBe(400);
    sendBehavior = async () => {
      throw new SshRpcError("refused", "peer key rejected", NODE_A, "peer key rejected");
    };
    const res = await post(NODE_A, PEER_B, ownerCookie);
    expect(res.status).toBe(502);
    const body = (await res.json()) as { code: string; message: string };
    expect(body.code).toBe("SSH_NODE_REFUSED");
    // The node's words stay in the service log, not in the human's refusal -
    // and no key material could ride either way (this copy is fixed).
    expect(body.message).not.toContain("SENTINEL");
  });
});

describe("server relay identity recovery", () => {
  it("requires an admin cookie and both verified disk fingerprints; it never rewrites peer pins", async () => {
    const identity = await ensureLocalRelayIdentity();
    const repo = new IdentitiesRepository(db);
    const original = await repo.findByPrincipal("node:local");
    if (!original) throw new Error("missing server identity");
    const call = (method: string, cookie: string, body?: unknown) =>
      nodesRoutes.fetch(
        new Request(`http://localhost/api/nodes/local/ssh-identity${method === "POST" ? "/repair" : ""}`, {
          method,
          headers: { cookie: `better-auth.session_token=${cookie}`, "content-type": "application/json" },
          ...(body ? { body: JSON.stringify(body) } : {}),
        }),
      );
    const own = {
      signing: await fingerprintJwk(identity.signingPublicJwk),
      encryption: await fingerprintJwk(identity.publicJwk),
    };
    const pins = new MachinePinStore(localRelayIdentityDir());
    pins.repair("peer-recovery-test", { signing: identity.signingPublicJwk, encryption: identity.publicJwk });
    const before = pins.entries();
    try {
      await repo.register({ ...original, signingPublicKey: identity.publicJwk });
      expect((await call("GET", ownerCookie)).status).toBe(403);
      expect((await call("POST", ownerCookie, own)).status).toBe(403);
      const status = await call("GET", adminCookie);
      expect(status.status).toBe(200);
      expect(((await status.json()) as { matches: boolean }).matches).toBe(false);
      expect((await call("POST", adminCookie, { ...own, signing: "wrong" })).status).toBe(409);
      expect((await repo.findByPrincipal("node:local"))?.signingPublicKey).toBe(identity.publicJwk);
      expect((await call("POST", adminCookie, own)).status).toBe(200);
      expect((await repo.findByPrincipal("node:local"))?.signingPublicKey).toBe(identity.signingPublicJwk);
      expect(pins.entries()).toEqual(before);
    } finally {
      await repo.register(original);
      resetLocalRelayIdentity();
    }
  });
});
