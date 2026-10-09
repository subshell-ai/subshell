import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { hashPassword } from "better-auth/crypto";
import { ensureMigratedTestDb } from "@/__tests__/helpers/test-database.js";
import { deleteUserByEmailOrId, setupAuthTables } from "@/api/__tests__/helpers/auth-tables.js";
import { db } from "@/db/index.js";
import { IdentitiesRepository } from "@/db/repositories/identities.repository.js";
import { UsersRepository } from "@/db/repositories/users.repository.js";
import { LOCAL_NODE_ID, type NodeKind } from "@/db/types/nodes.db-types.js";
import { SshRpcError } from "@/services/nodes/ssh-rpc.js";
import {
  repairMachinePin,
  SshMachinePinRepairError,
  type SshMachinePinRepairFailure,
  setSshMachinePinsDepsForTests,
} from "@/services/ssh-machine-pins.service.js";

/**
 * The §4.5 re-pair service (spec 2026-10-08 §4.5, Task 17). The properties
 * this suite exists to pin:
 *
 * - The delivered pair is the peer's REGISTERED public half from the
 *   identities store (signing + encryption), sent in the relay-open's own
 *   base64 carriage - never from the caller.
 * - OWNER, exactly: a non-owner actor (an admin included) refuses BEFORE any
 *   command leaves, and nothing is audited.
 * - A offline is the named `offline` refusal with NO audit row - the audit
 *   lands only after A's ack confirms the write (no success-as-audit).
 * - A ack mismatch (or a machine refusal) refuses and audits nothing.
 * - `local` refuses as A and as peer; `same-node` refuses; an absent peer or
 *   a peer with no registered signing half refuses by name before any send.
 * - The audit row is `node.ssh_machine_pin.repair` naming the TWO NODE IDS
 *   ONLY - the serialized row is asserted free of every key sentinel.
 */

const pw = "mp-repair-1";
const OWNER_EMAIL = `mp-owner-${crypto.randomUUID()}@subshell.local`;
const ADMIN_EMAIL = `mp-admin-${crypto.randomUUID()}@subshell.local`;
let ownerId: string;
let adminId: string;

const NODE_A = `n-a-${crypto.randomUUID()}`;
const PEER_B = `n-b-${crypto.randomUUID()}`;

/** Sentinel-bearing public JWK text: if these bytes reach an audit row, the sentinel assert names them. */
const PEER_SIGNING = '{"kty":"EC","crv":"P-256","x":"SIGN-SENTINEL-aaaa","y":"SIGN-SENTINEL-bbbb"}';
const PEER_ENCRYPT = '{"kty":"EC","crv":"P-256","x":"ENCL-SENTINEL-cccc","y":"ENCL-SENTINEL-dddd"}';
const PEER_ENCRYPT_B64 = Buffer.from(PEER_ENCRYPT, "utf8").toString("base64");

type SentCmd = { nodeId: string; cmd: unknown };
let sent: SentCmd[] = [];
let sendBehavior: (nodeId: string, cmd: unknown) => Promise<{ repaired: true; peerNodeId: string }> = async (
  _n,
  cmd,
) => {
  const c = cmd as { peerNodeId: string };
  return { repaired: true, peerNodeId: c.peerNodeId };
};

function installDeps() {
  sent = [];
  setSshMachinePinsDepsForTests({
    sendRepair: async (nodeId, cmd) => {
      sent.push({ nodeId, cmd });
      return sendBehavior(nodeId, cmd);
    },
  });
}

async function repairRows(): Promise<
  { id: string; actorUserId: string | null; targetId: string | null; metadataJson: string | null }[]
> {
  return await db
    .selectFrom("auditEvents")
    .select(["id", "actorUserId", "targetId", "metadataJson"])
    .where("action", "=", "node.ssh_machine_pin.repair")
    .where("targetId", "=", NODE_A)
    .execute();
}

async function mkNode(id: string, ownerUserId: string, kind: NodeKind): Promise<void> {
  const now = new Date().toISOString();
  await db
    .insertInto("nodes")
    .values({ id, ownerUserId, name: id, kind, status: "offline", createdAt: now, updatedAt: now } as never)
    .execute();
}

beforeAll(async () => {
  await ensureMigratedTestDb();
  await setupAuthTables();
  ownerId = await new UsersRepository(db).createUser({
    email: OWNER_EMAIL,
    name: OWNER_EMAIL,
    passwordHash: await hashPassword(pw),
    role: "user",
  });
  adminId = await new UsersRepository(db).createUser({
    email: ADMIN_EMAIL,
    name: ADMIN_EMAIL,
    passwordHash: await hashPassword(pw),
    role: "admin",
  });
  await mkNode(NODE_A, ownerId, "agent");
  await mkNode(PEER_B, ownerId, "agent");
  await new IdentitiesRepository(db).register({
    principalId: `node:${PEER_B}`,
    publicKey: PEER_ENCRYPT,
    signingPublicKey: PEER_SIGNING,
    displayName: null,
  });
});

afterAll(async () => {
  setSshMachinePinsDepsForTests(null);
  await db.deleteFrom("nodes").where("id", "in", [NODE_A, PEER_B]).execute();
  await db.deleteFrom("identities").where("principalId", "=", `node:${PEER_B}`).execute();
  for (const email of [OWNER_EMAIL, ADMIN_EMAIL]) await deleteUserByEmailOrId(email);
});

beforeEach(() => installDeps());

describe("the happy path: registered pair out, ids-only audit in", () => {
  it("sends the peer's REGISTERED public pair in the relay-open carriage and audits ids only", async () => {
    await repairMachinePin({ actorUserId: ownerId, nodeId: NODE_A, peerNodeId: PEER_B });
    expect(sent).toHaveLength(1);
    expect(sent[0].nodeId).toBe(NODE_A);
    expect(sent[0].cmd).toEqual({
      type: "ssh_machine_pin_repair",
      peerNodeId: PEER_B,
      peerSigningPublicKey: PEER_SIGNING, // byte-identical to the store (§4.4's byte-equality depends on it)
      peerEncryptPublicKey: PEER_ENCRYPT_B64, // acceptance (h): base64 of the UTF-8 JSON
    });
    const rows = await repairRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].actorUserId).toBe(ownerId); // the acting human, not null
    expect(rows[0].metadataJson).toBe(JSON.stringify({ nodeIdOfA: NODE_A, peerNodeId: PEER_B }));
    // The §10 rule, asserted against the SERIALIZED row, not the intent:
    // no key bytes, no base64 carriage, no sentinel coordinates - ids only.
    const serialized = JSON.stringify(rows[0]);
    for (const secret of [PEER_SIGNING, PEER_ENCRYPT, PEER_ENCRYPT_B64, "SIGN-SENTINEL", "ENCL-SENTINEL"]) {
      expect(serialized).not.toContain(secret);
    }
  });
});

describe("the owner door (exact, not manage, not admin)", () => {
  async function expectRefusal(code: SshMachinePinRepairFailure, run: () => Promise<void>): Promise<void> {
    const before = (await repairRows()).length;
    const err = await run().then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(SshMachinePinRepairError);
    expect((err as SshMachinePinRepairError).code).toBe(code);
    expect(sent).toHaveLength(0); // refused BEFORE any command
    expect((await repairRows()).length).toBe(before); // and nothing audited
  }

  it("a non-owner actor refuses not-owner - an admin included", async () => {
    await expectRefusal("not-owner", () =>
      repairMachinePin({ actorUserId: adminId, nodeId: NODE_A, peerNodeId: PEER_B }),
    );
  });

  it("the owner's OWN re-pair still answers when the peer is owned by someone else", async () => {
    // The peer's ownership gates NOTHING: the act re-delivers what the
    // peer's own enrollment registered, into a store A's owner commands.
    const foreign = `n-f-${crypto.randomUUID()}`;
    await mkNode(foreign, adminId, "agent");
    await new IdentitiesRepository(db).register({
      principalId: `node:${foreign}`,
      publicKey: PEER_ENCRYPT,
      signingPublicKey: PEER_SIGNING,
      displayName: null,
    });
    await repairMachinePin({ actorUserId: ownerId, nodeId: NODE_A, peerNodeId: foreign });
    expect(sent).toHaveLength(1);
    expect(sent[0].cmd).toMatchObject({ peerNodeId: foreign });
    await db.deleteFrom("nodes").where("id", "=", foreign).execute();
    await db.deleteFrom("identities").where("principalId", "=", `node:${foreign}`).execute();
  });

  it("same-node refuses: a machine is never its own relay peer", async () => {
    await expectRefusal("same-node", () =>
      repairMachinePin({ actorUserId: ownerId, nodeId: NODE_A, peerNodeId: NODE_A }),
    );
  });

  it("local refuses as A and as peer: no agent store exists either way", async () => {
    await expectRefusal("local-node", () =>
      repairMachinePin({ actorUserId: ownerId, nodeId: LOCAL_NODE_ID, peerNodeId: PEER_B }),
    );
    await expectRefusal("local-node", () =>
      repairMachinePin({ actorUserId: ownerId, nodeId: NODE_A, peerNodeId: LOCAL_NODE_ID }),
    );
  });

  it("an absent A refuses no-node; an absent peer refuses no-peer", async () => {
    const ghost = `n-ghost-${crypto.randomUUID()}`;
    await expectRefusal("no-node", () => repairMachinePin({ actorUserId: ownerId, nodeId: ghost, peerNodeId: PEER_B }));
    await expectRefusal("no-peer", () => repairMachinePin({ actorUserId: ownerId, nodeId: NODE_A, peerNodeId: ghost }));
  });
});

describe("the peer-identity door", () => {
  it("a peer with no registered signing half refuses peer-identity-missing, without asking A", async () => {
    const keyless = `n-k-${crypto.randomUUID()}`;
    await mkNode(keyless, ownerId, "agent");
    const before = (await repairRows()).length;
    const err = await repairMachinePin({ actorUserId: ownerId, nodeId: NODE_A, peerNodeId: keyless }).then(
      () => null,
      (e: unknown) => e,
    );
    expect((err as SshMachinePinRepairError).code).toBe("peer-identity-missing");
    expect(sent).toHaveLength(0);
    expect((await repairRows()).length).toBe(before);
    await db.deleteFrom("nodes").where("id", "=", keyless).execute();
  });
});

describe("A online by command: every delivery failure audits NOTHING (no success-as-audit)", () => {
  async function expectSendFailure(code: SshMachinePinRepairFailure, boom: Error): Promise<void> {
    sendBehavior = async () => {
      throw boom;
    };
    const before = (await repairRows()).length;
    const err = await repairMachinePin({ actorUserId: ownerId, nodeId: NODE_A, peerNodeId: PEER_B }).then(
      () => null,
      (e: unknown) => e,
    );
    expect((err as SshMachinePinRepairError).code).toBe(code);
    expect((await repairRows()).length).toBe(before);
  }

  it("offline refuses by name and audits nothing", async () => {
    await expectSendFailure("offline", new SshRpcError("offline", "no live socket", NODE_A));
  });
  it("unsupported (old agent) refuses and audits nothing", async () => {
    await expectSendFailure("unsupported", new SshRpcError("unsupported", "unknown command", NODE_A));
  });
  it("timeout refuses and audits nothing", async () => {
    await expectSendFailure("timeout", new SshRpcError("timeout", "deadline", NODE_A));
  });
  it("a machine refusal refuses and audits nothing", async () => {
    await expectSendFailure("refused", new SshRpcError("refused", "peer key rejected", NODE_A, "peer key rejected"));
  });

  it("an ack about the WRONG peer is malformed, loudly, with no audit", async () => {
    sendBehavior = async () => ({ repaired: true, peerNodeId: "someone-else" });
    const before = (await repairRows()).length;
    const err = await repairMachinePin({ actorUserId: ownerId, nodeId: NODE_A, peerNodeId: PEER_B }).then(
      () => null,
      (e: unknown) => e,
    );
    expect((err as SshMachinePinRepairError).code).toBe("malformed");
    expect((await repairRows()).length).toBe(before);
  });

  it("a thrown non-RPC error is not swallowed (it leaves as itself)", async () => {
    sendBehavior = async () => {
      throw new Error("db exploded");
    };
    const before = (await repairRows()).length;
    await expect(repairMachinePin({ actorUserId: ownerId, nodeId: NODE_A, peerNodeId: PEER_B })).rejects.toThrow(
      "db exploded",
    );
    expect((await repairRows()).length).toBe(before); // and it audited nothing either
  });
});
