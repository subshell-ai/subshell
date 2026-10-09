import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { hashPassword } from "better-auth/crypto";
import { exportJWK, generateKeyPair } from "jose";
import { deleteUserByEmailOrId, setupAuthTables } from "@/api/__tests__/helpers/auth-tables.js";
import { db } from "@/db/index.js";
import { IdentitiesRepository } from "@/db/repositories/identities.repository.js";
import { NodesRepository } from "@/db/repositories/nodes.repository.js";
import { UsersRepository } from "@/db/repositories/users.repository.js";
import { resetNodeRegistryForTests } from "@/services/nodes/node-registry.js";
import { bootstrapSshIdentityOnReady, deliverSigningKey } from "@/services/nodes/ssh-identity.js";
import { attachScriptedNode, type ScriptedNode } from "@/test-helpers/scripted-node.js";

/**
 * `deliverSigningKey` + the `ready`-time bootstrap (spec 2026-10-08 §4.3):
 * the §4.3 delivery stores a first report, is idempotent on a re-report of
 * the SAME bytes, and REFUSES to overwrite a slot holding a DIFFERENT key
 * (the own-registration guard: a silent rotation must never be repairable
 * by the machine that reported it). The property this suite exists to pin
 * is that refusal, and that nothing the store writes is ever a private key:
 * a JWK carrying `d` is refused exactly like junk.
 *
 * Posture copied from ssh-enabled.test.ts: real migrated DB, real rows,
 * scripted node on the real registry for the RPC leg - no RPC mocks, the
 * `ssh_register_identity` frame travels the real `sendCommand` chain and is
 * gated by the real `parseNodeCommandBody`.
 */

const nodes = new NodesRepository(db);
const identities = new IdentitiesRepository(db);
const nodeIds: string[] = [];
const emails: string[] = [];
const scripted: ScriptedNode[] = [];
let ownerId: string;
let KEY_A: string;
let KEY_B: string;
/** A real ES256 PRIVATE JWK: the store must refuse it exactly like garbage. */
let PRIVATE_A: string;
/** A plausible ECDH-ES public JWK for the identity row's encryption half. */
const ENC_JWK =
  '{"kty":"EC","crv":"P-256","x":"BBBBBBBBBBBBBBBBBBBBBBBB-BBBBBBBBBBBBBBBBBBB","y":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"}';

async function mkUser(): Promise<string> {
  const email = `ssh-id-${crypto.randomUUID()}@subshell.local`;
  emails.push(email);
  return await new UsersRepository(db).createUser({
    email,
    name: email,
    passwordHash: await hashPassword("ssh-id-pass-1"),
    role: "user",
  });
}

/** An enrolled agent node whose identity record carries an EMPTY signing slot. */
async function mkNodeWithEmptySlot(): Promise<string> {
  const id = crypto.randomUUID();
  nodeIds.push(id);
  await nodes.create({ id, ownerUserId: ownerId, name: `ssh-id-${id.slice(0, 8)}`, kind: "agent", status: "online" });
  await identities.register({
    principalId: `node:${id}`,
    publicKey: ENC_JWK,
    signingPublicKey: null,
    displayName: null,
  });
  return id;
}

async function slotOf(nodeId: string): Promise<string | null> {
  const row = await identities.findByPrincipal(`node:${nodeId}`);
  return row?.signingPublicKey ?? null;
}

/** Audit rows for one target's registration, newest last. */
async function auditFor(targetId: string): Promise<{ actorUserId: string | null; meta: string | null }[]> {
  const rows = await db
    .selectFrom("auditEvents")
    .select(["actorUserId", "metadataJson"])
    .where("targetId", "=", targetId)
    .where("action", "=", "node.ssh_identity.register")
    .orderBy("createdAt", "asc")
    .execute();
  return rows.map((r) => ({ actorUserId: r.actorUserId, meta: r.metadataJson }));
}

beforeAll(async () => {
  await setupAuthTables();
  ownerId = await mkUser();
  const a = await generateKeyPair("ES256", { crv: "P-256", extractable: true });
  KEY_A = JSON.stringify(await exportJWK(a.publicKey));
  PRIVATE_A = JSON.stringify(await exportJWK(a.privateKey));
  const b = await generateKeyPair("ES256", { crv: "P-256", extractable: true });
  KEY_B = JSON.stringify(await exportJWK(b.publicKey));
});

afterAll(async () => {
  for (const s of scripted) s.detach();
  resetNodeRegistryForTests();
  for (const id of nodeIds) {
    await db.deleteFrom("identities").where("principalId", "=", `node:${id}`).execute();
    await nodes.deleteById(id);
  }
  for (const mail of emails) await deleteUserByEmailOrId(mail);
});

describe("deliverSigningKey (spec 2026-10-08 §4.3)", () => {
  it("stores a FIRST report into the empty slot and audits it (ids and via only)", async () => {
    const id = await mkNodeWithEmptySlot();
    expect(await deliverSigningKey(id, KEY_A)).toBe(KEY_A);
    expect(await slotOf(id)).toBe(KEY_A);
    const rows = await auditFor(id);
    expect(rows).toHaveLength(1);
    expect(rows[0].actorUserId).toBeNull();
    expect(JSON.parse(rows[0].meta ?? "null")).toEqual({ via: "link" });
    // The key VALUE never enters the audit row (Global Constraint: no key
    // material in any audit row; the metadata names the delivery, nothing else).
    expect(rows[0].meta).not.toContain(KEY_A);
    expect(rows[0].meta).not.toContain("-----");
  });

  it("is idempotent on a re-report of the SAME bytes: success, no second write", async () => {
    const id = await mkNodeWithEmptySlot();
    expect(await deliverSigningKey(id, KEY_A)).toBe(KEY_A);
    expect(await deliverSigningKey(id, KEY_A)).toBe(KEY_A);
    expect(await slotOf(id)).toBe(KEY_A);
    expect(await auditFor(id)).toHaveLength(1); // the re-report wrote nothing new
  });

  it("REFUSES a DIFFERENT key: returns the existing, overwrites nothing, audits nothing", async () => {
    const id = await mkNodeWithEmptySlot();
    await deliverSigningKey(id, KEY_A);
    // The §4.3 own-registration guard: a machine that reports a key other
    // than the one on file gets the EXISTING answer back and changes nothing.
    expect(await deliverSigningKey(id, KEY_B)).toBe(KEY_A);
    expect(await slotOf(id)).toBe(KEY_A);
    expect(await auditFor(id)).toHaveLength(1);
  });

  it("refuses malformed input WITHOUT storing it (and never a private JWK)", async () => {
    const id = await mkNodeWithEmptySlot();
    expect(await deliverSigningKey(id, "not json at all")).toBeNull();
    expect(await deliverSigningKey(id, '"just a string"')).toBeNull();
    expect(await deliverSigningKey(id, PRIVATE_A)).toBeNull(); // has `d`
    expect(await slotOf(id)).toBeNull();
    expect(await auditFor(id)).toHaveLength(0);
  });

  it("refuses a node with NO identity row: nothing to fill, no row invented", async () => {
    const id = crypto.randomUUID();
    nodeIds.push(id);
    await nodes.create({
      id,
      ownerUserId: ownerId,
      name: `ssh-orphan-${id.slice(0, 8)}`,
      kind: "agent",
      status: "online",
    });
    expect(await deliverSigningKey(id, KEY_A)).toBeNull();
    expect(await identities.findByPrincipal(`node:${id}`)).toBeUndefined();
    expect(await auditFor(id)).toHaveLength(0);
  });

  it("a raced double-report lands exactly once (the CAS-loser branch)", async () => {
    const id = await mkNodeWithEmptySlot();
    // Two concurrent deliveries against the EMPTY slot: their reads both see
    // null (each chain yields at the same awaits, and bun:sqlite runs the
    // query synchronously), so both reach the CAS. Exactly one UPDATE flips
    // the slot; the loser re-reads and returns the winner's bytes instead of
    // auditing a second row.
    const results = await Promise.all([deliverSigningKey(id, KEY_B), deliverSigningKey(id, KEY_B)]);
    expect(results).toEqual([KEY_B, KEY_B]);
    expect(await slotOf(id)).toBe(KEY_B);
    expect(await auditFor(id)).toHaveLength(1); // the loser wrote no audit row
  });
});

describe("IdentitiesRepository.fillSigningPublicKey (the CAS in SQL)", () => {
  it("refuses every write once the slot holds a value, same bytes or different", async () => {
    const id = await mkNodeWithEmptySlot();
    const principalId = `node:${id}`;
    // The first fill lands: this is the write the empty slot exists for.
    expect(await identities.fillSigningPublicKey(principalId, KEY_A)).toBe(true);
    // Same bytes: the UPDATE still matches nothing (the `signingPublicKey is
    // null` predicate fails), so even re-reporting the stored key answers
    // false. Different bytes: refused the same way.
    expect(await identities.fillSigningPublicKey(principalId, KEY_A)).toBe(false);
    expect(await identities.fillSigningPublicKey(principalId, KEY_B)).toBe(false);
    // The stored bytes never moved.
    expect(await slotOf(id)).toBe(KEY_A);
  });
});

describe("bootstrapSshIdentityOnReady (the ready-time wire-up)", () => {
  it("sends ssh_register_identity ONCE on an empty slot and files the answer", async () => {
    const id = await mkNodeWithEmptySlot();
    const node = attachScriptedNode(id, { ssh_register_identity: () => ({ signingPublicKey: KEY_A }) });
    scripted.push(node);
    await bootstrapSshIdentityOnReady(id);
    expect(node.countOf("ssh_register_identity")).toBe(1);
    expect(await slotOf(id)).toBe(KEY_A);
    expect(await auditFor(id)).toHaveLength(1);
  });

  it("sends NOTHING when the slot is already filled (the no-spam gate)", async () => {
    const id = await mkNodeWithEmptySlot();
    await deliverSigningKey(id, KEY_A);
    const node = attachScriptedNode(id, { ssh_register_identity: () => ({ signingPublicKey: KEY_A }) });
    scripted.push(node);
    await bootstrapSshIdentityOnReady(id);
    expect(node.countOf("ssh_register_identity")).toBe(0);
    expect(await slotOf(id)).toBe(KEY_A);
    expect(await auditFor(id)).toHaveLength(1); // only the direct delivery above
  });

  it("sends NOTHING for a node with no identity row", async () => {
    const id = crypto.randomUUID();
    nodeIds.push(id);
    await nodes.create({
      id,
      ownerUserId: ownerId,
      name: `ssh-none-${id.slice(0, 8)}`,
      kind: "agent",
      status: "online",
    });
    const node = attachScriptedNode(id, { ssh_register_identity: () => ({ signingPublicKey: KEY_A }) });
    scripted.push(node);
    await bootstrapSshIdentityOnReady(id);
    expect(node.countOf("ssh_register_identity")).toBe(0);
    expect(await identities.findByPrincipal(`node:${id}`)).toBeUndefined();
  });

  it("survives a malformed machine answer: no throw, nothing stored", async () => {
    const id = await mkNodeWithEmptySlot();
    const node = attachScriptedNode(id, { ssh_register_identity: () => ({ signingPublicKey: "garbage{" }) });
    scripted.push(node);
    await bootstrapSshIdentityOnReady(id);
    expect(node.countOf("ssh_register_identity")).toBe(1); // the ask did go out
    expect(await slotOf(id)).toBeNull();
    expect(await auditFor(id)).toHaveLength(0);
  });

  it("swallows an unreachable machine quietly (offline is routine at ready)", async () => {
    const id = await mkNodeWithEmptySlot(); // no scripted node attached: sendCommand answers offline
    await expect(bootstrapSshIdentityOnReady(id)).resolves.toBeUndefined();
    expect(await slotOf(id)).toBeNull();
  });
});
