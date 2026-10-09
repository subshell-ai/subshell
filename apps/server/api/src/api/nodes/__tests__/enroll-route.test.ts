import { afterAll, beforeAll, describe, expect, it, mock, spyOn } from "bun:test";
import { NODE_NAME_MAX } from "@internal/subshell-protocol";
import { ensureSodium, generateLinkKeyPair } from "@internal/subshell-protocol/node-link-crypto";
import { hashPassword } from "better-auth/crypto";
import { Elysia } from "elysia";
import { exportJWK, generateKeyPair } from "jose";
import { nodeWsUrl } from "@/api/nodes/enroll.route.js";
import { nodesRoutes } from "@/api/nodes/index.js";
import { authDatabase } from "@/auth/database.js";
import * as constants from "@/constants.js";
import { db } from "@/db/index.js";
import { IdentitiesRepository } from "@/db/repositories/identities.repository.js";
import { NodeSetupKeysRepository } from "@/db/repositories/node-setup-keys.repository.js";
import { NodesRepository } from "@/db/repositories/nodes.repository.js";
import { UsersRepository } from "@/db/repositories/users.repository.js";
import { errorHandlerPlugin } from "@/plugins/error-handler.plugin.js";
import {
  attachConnection,
  getLive,
  REVOKED_CLOSE_CODE,
  resetNodeRegistryForTests,
} from "@/services/nodes/node-registry.js";
import { deleteUserByEmailOrId, setupAuthTables, signIn } from "../../__tests__/helpers/auth-tables.js";

/** Fresh extractable P-256 keypair exported as a JWK string; `withD` exports the PRIVATE half. */
async function jwkString(withD = false): Promise<string> {
  const { publicKey, privateKey } = await generateKeyPair("ECDH-ES", { crv: "P-256", extractable: true });
  return JSON.stringify(await exportJWK(withD ? privateKey : publicKey));
}

/**
 * Fresh ES256 signing keypair as a JWK string (the M2 relay identity, spec
 * 2026-10-08 §4.1); `withD` exports the PRIVATE half, which enroll must refuse.
 */
async function signingJwkString(withD = false): Promise<string> {
  const { publicKey, privateKey } = await generateKeyPair("ES256", { crv: "P-256", extractable: true });
  return JSON.stringify(await exportJWK(withD ? privateKey : publicKey));
}

/**
 * Snapshot of the constants module taken before any `mock.module` swap, so the
 * wsUrl subpath test can restore the real values for the suites that share this
 * process (`bun test` runs every file against one DB in one process).
 */
const constantsSnapshot = { ...constants };

/**
 * `POST /api/nodes/enroll` — public redemption of a single-use setup key
 * (spec 2026-08-31 §5.2). The setup key IS the credential (no authGuard).
 * Validation happens BEFORE consumption, and the write order is
 * consume → node row → identity → api key → setApiKeyId.
 */
describe("/api/nodes/enroll", () => {
  const pw = "enroll-1";
  const aliceEmail = `enroll-alice-${crypto.randomUUID()}@subshell.local`;
  let aliceId: string;
  const app = new Elysia().use(errorHandlerPlugin).use(nodesRoutes);
  const repo = new NodeSetupKeysRepository(db);
  const nodes = new NodesRepository(db);
  const identities = new IdentitiesRepository(db);

  const createdNodeIds: string[] = [];
  const createdSetupKeyIds: string[] = [];
  let goodJwk: string;
  let goodSigningJwk: string;

  beforeAll(async () => {
    await setupAuthTables();
    aliceId = await new UsersRepository(db).createUser({
      email: aliceEmail,
      name: aliceEmail,
      passwordHash: await hashPassword(pw),
      role: "user",
    });
    await signIn(aliceEmail, pw); // exercise the real auth stack; enroll itself needs no cookie
    goodJwk = await jwkString();
    goodSigningJwk = await signingJwkString();
  });

  afterAll(async () => {
    // Reverse the write order when tearing down: keys → (api key, identity) → nodes → user.
    for (const id of createdSetupKeyIds) await repo.deleteById(id, aliceId);
    for (const id of createdNodeIds) {
      const node = await nodes.findById(id);
      if (node?.apiKeyId) authDatabase().run("DELETE FROM apikey WHERE id = ?", [node.apiKeyId]);
      await db.deleteFrom("identities").where("principalId", "=", `node:${id}`).execute();
      await nodes.deleteById(id);
    }
    await deleteUserByEmailOrId(aliceEmail);
  });

  /** Mint a real setup key owned by alice, tracked for cleanup. No label — a
   * setup key names nothing since the 2026-09-17 revamp. */
  async function makeKey(): Promise<string> {
    const row = await repo.create(aliceId);
    createdSetupKeyIds.push(row.id);
    return row.key;
  }

  async function enroll(body: Record<string, unknown>): Promise<Response> {
    return app.fetch(
      new Request("http://localhost:3080/api/nodes/enroll", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
  }

  function bodyFor(setupKey: string, over: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      setupKey,
      name: `enroll-${crypto.randomUUID().slice(0, 8)}`,
      os: "linux",
      arch: "x64",
      hostname: "host-a",
      agentVersion: "0.1.0",
      publicKey: goodJwk,
      // The M2 relay signing key (spec 2026-10-08 §4.2): a post-M2 agent
      // carries it; the pre-M2 posture is `signingPublicKey: undefined`,
      // which JSON.stringify drops from the body.
      signingPublicKey: goodSigningJwk,
      ...over,
    };
  }

  it("happy path: 201 + node row + identity + node key; the setup key is spent", async () => {
    const setupKey = await makeKey();
    const res = await enroll(bodyFor(setupKey, { name: "mini-one" }));
    expect(res.status).toBe(201);
    const body = (await res.json()) as { nodeId: string; nodeKey: string; controlPublicKey: string; wsUrl: string };
    createdNodeIds.push(body.nodeId);

    // The node row: agent kind, offline, owner = key creator, machine facts from the body.
    const node = await nodes.findById(body.nodeId);
    expect(node).toBeDefined();
    expect(node?.kind).toBe("agent");
    expect(node?.status).toBe("offline");
    expect(node?.ownerUserId).toBe(aliceId);
    expect(node?.name).toBe("mini-one");
    expect(node?.os).toBe("linux");
    expect(node?.arch).toBe("x64");
    expect(node?.hostname).toBe("host-a");
    expect(node?.agentVersion).toBe("0.1.0");
    expect(node?.apiKeyId).toBeTruthy();

    // The identity row carries the exact validated JWK string under node:<id>,
    // and the M2 signing slot (spec 2026-10-08 §4.2) rides the SAME record.
    const identity = await identities.findByPrincipal(`node:${body.nodeId}`);
    expect(identity?.publicKey).toBe(goodJwk);
    expect(identity?.signingPublicKey).toBe(goodSigningJwk);
    expect(identity?.displayName).toBe("mini-one");

    // The node key is a real `subshell_` bearer; the setup key cannot redeem again.
    expect(body.nodeKey.startsWith("subshell_")).toBe(true);
    expect(await repo.peekValid(setupKey)).toBe(false);

    // controlPublicKey is a PUBLIC JWK; wsUrl follows the ws(s) scheme + /ws/node path.
    const cpk = JSON.parse(body.controlPublicKey) as { kty?: string; d?: string };
    expect(cpk.kty).toBe("EC");
    expect(cpk.d).toBeUndefined();
    // Loopback/no-path default: the exact dial target, not just "ends with /ws/node".
    expect(body.wsUrl).toBe(`ws://localhost:${constants.SERVER_PORT}/ws/node`);

    // No key internals on the wire.
    const raw = JSON.stringify(body);
    expect(raw).not.toContain("expiresAt");
    expect(raw).not.toContain("keyHash");
  });

  it("a node-bound key replaces credentials on the same row and preserves its settings", async () => {
    const first = await enroll(bodyFor(await makeKey(), { name: `recovery-${crypto.randomUUID()}` }));
    const original = (await first.json()) as { nodeId: string; nodeKey: string };
    createdNodeIds.push(original.nodeId);
    const old = await nodes.findById(original.nodeId);
    if (!old?.apiKeyId) throw new Error("Initial node was not provisioned");
    await db
      .updateTable("nodes")
      .set({ maintenance: 1, maintenanceAt: "2026-01-01T00:00:00Z", maintenanceSource: "plane" })
      .where("id", "=", original.nodeId)
      .execute();
    await db
      .insertInto("nodeShares")
      .values({
        nodeId: original.nodeId,
        id: crypto.randomUUID(),
        granteeUserId: null,
        createdBy: aliceId,
        createdAt: new Date().toISOString(),
        permission: "view",
      })
      .execute();
    const key = await repo.create(aliceId, 60_000, original.nodeId);
    const sibling = await repo.create(aliceId, 60_000, original.nodeId);
    createdSetupKeyIds.push(key.id, sibling.id);
    const closed: { code?: number; reason?: string }[] = [];
    const conn = attachConnection(original.nodeId, {
      send() {
        return 0;
      },
      close(code?: number, reason?: string) {
        closed.push({ code, reason });
      },
    });
    let pendingFailure: unknown;
    conn.pending.set("recovery-test", {
      resolve() {},
      reject(error) {
        pendingFailure = error;
      },
      timer: setTimeout(() => {}, 30000),
    });
    const freshJwk = await jwkString();
    const freshSigningJwk = await signingJwkString();
    const link = await generateLinkKeyPair();
    const freshEncryptPublicKey = link.publicKey;
    const res = await enroll(
      bodyFor(key.key, {
        name: "ignored replacement name",
        hostname: "replacement-host",
        publicKey: freshJwk,
        signingPublicKey: freshSigningJwk,
        encryptPublicKey: freshEncryptPublicKey,
      }),
    );
    expect(res.status).toBe(201);
    const recovered = (await res.json()) as { nodeId: string; nodeKey: string };
    expect(recovered.nodeId).toBe(original.nodeId);
    expect(closed[0]?.code).toBe(REVOKED_CLOSE_CODE);
    expect(getLive(original.nodeId)).toBeUndefined();
    expect(pendingFailure).toBeDefined();
    expect(conn.pending.size).toBe(0);
    resetNodeRegistryForTests();
    expect(recovered.nodeKey).not.toBe(original.nodeKey);
    const current = await nodes.findById(original.nodeId);
    if (!current) throw new Error("Recovery deleted the node");
    expect(current.name).toBe(old.name);
    expect(current.createdAt).toBe(old.createdAt);
    expect(current.ownerUserId).toBe(aliceId);
    expect(current.maintenance).toBe(1);
    expect(current.hostname).toBe("replacement-host");
    expect(current.publicKey).toBe(freshJwk);
    expect(current.encryptPublicKey).toBe(freshEncryptPublicKey);
    // Both identity halves swap together: re-registration replaces the whole
    // machine identity, signing slot included (spec 2026-10-08 §4.2).
    const recoveredIdentity = await identities.findByPrincipal(`node:${original.nodeId}`);
    expect(recoveredIdentity?.publicKey).toBe(freshJwk);
    expect(recoveredIdentity?.signingPublicKey).toBe(freshSigningJwk);
    expect(await db.selectFrom("nodeShares").selectAll().where("nodeId", "=", original.nodeId).execute()).toHaveLength(
      1,
    );
    expect(authDatabase().query("SELECT enabled FROM apikey WHERE id = ?").get(old.apiKeyId)).toEqual({ enabled: 0 });
    expect((await repo.findById(key.id))?.consumedNodeId).toBe(original.nodeId);
    expect(await repo.peekValid(sibling.key)).toBe(false);
    expect((await enroll(bodyFor(key.key))).status).toBe(401);
  });

  it("competing recovery keys have one winner and stale keys cannot supersede a rotation", async () => {
    const first = await enroll(bodyFor(await makeKey()));
    const original = (await first.json()) as { nodeId: string };
    createdNodeIds.push(original.nodeId);
    const a = await repo.create(aliceId, 60_000, original.nodeId);
    const b = await repo.create(aliceId, 60_000, original.nodeId);
    const replies = await Promise.all([enroll(bodyFor(a.key)), enroll(bodyFor(b.key))]);
    expect(replies.map((r) => r.status).sort()).toEqual([201, 401]);
    const recovery = await repo.create(aliceId, 60_000, original.nodeId);
    createdSetupKeyIds.push(a.id, b.id, recovery.id);
    const currentApiKeyId = (await nodes.findById(original.nodeId))?.apiKeyId ?? null;
    await nodes.setApiKeyId(original.nodeId, "a-new-credential-binding");
    expect(await repo.peekValid(recovery.key)).toBe(false);
    expect((await enroll(bodyFor(recovery.key))).status).toBe(401);
    expect((await nodes.findById(original.nodeId))?.apiKeyId).toBe("a-new-credential-binding");
    await nodes.setApiKeyId(original.nodeId, currentApiKeyId);
  });

  it("a failed recovery transaction keeps the old credentials and identity usable", async () => {
    const first = await enroll(bodyFor(await makeKey()));
    const original = (await first.json()) as { nodeId: string };
    createdNodeIds.push(original.nodeId);
    const old = await nodes.findById(original.nodeId);
    const identity = await identities.findByPrincipal(`node:${original.nodeId}`);
    const recovery = await repo.create(aliceId, 60_000, original.nodeId);
    createdSetupKeyIds.push(recovery.id);
    const failed = spyOn(IdentitiesRepository.prototype, "register").mockRejectedValue(
      new Error("identity write failed"),
    );
    try {
      expect((await enroll(bodyFor(recovery.key))).status).toBe(500);
    } finally {
      failed.mockRestore();
    }
    expect((await nodes.findById(original.nodeId))?.apiKeyId).toBe(old?.apiKeyId);
    expect((await identities.findByPrincipal(`node:${original.nodeId}`))?.publicKey).toBe(identity?.publicKey);
    if (!old?.apiKeyId) throw new Error("Missing original credentials");
    expect(authDatabase().query("SELECT enabled FROM apikey WHERE id = ?").get(old.apiKeyId)).toEqual({ enabled: 1 });
    const rows = authDatabase()
      .query("SELECT enabled FROM apikey WHERE name = ? AND id != ?")
      .all(`node:${original.nodeId}`, old.apiKeyId);
    expect(rows.length).toBe(1);
    expect(rows[0]).toEqual({ enabled: 0 });
  });

  it("invalid recovery input and expired recovery keys leave the existing credentials intact", async () => {
    const res = await enroll(bodyFor(await makeKey()));
    const original = (await res.json()) as { nodeId: string };
    createdNodeIds.push(original.nodeId);
    const old = await nodes.findById(original.nodeId);
    const key = await repo.create(aliceId, 60_000, original.nodeId);
    const expired = await repo.create(aliceId, -1, original.nodeId);
    createdSetupKeyIds.push(key.id, expired.id);
    expect((await enroll(bodyFor(key.key, { publicKey: "malformed public JWK" }))).status).toBe(400);
    expect(await repo.peekValid(key.key)).toBe(true);
    expect((await enroll(bodyFor(expired.key))).status).toBe(401);
    expect((await nodes.findById(original.nodeId))?.apiKeyId).toBe(old?.apiKeyId);
  });

  it("deleting the target invalidates its recovery key instead of creating another node", async () => {
    const id = crypto.randomUUID();
    await nodes.create({ id, ownerUserId: aliceId, name: `deleted-${id}`, kind: "agent" });
    const key = await repo.create(aliceId, 60_000, id);
    await nodes.deleteById(id);
    expect(await repo.peekValid(key.key)).toBe(false);
    expect((await enroll(bodyFor(key.key))).status).toBe(401);
  });

  it("the issued node key carries NO permissions map (security-actionable item 10)", async () => {
    // `auth-guard` rejects every node-kind key on REST before its permissions
    // are ever read, and `/ws/node`'s upgrade chain reads METADATA only. The
    // `{ nodes: ["read","write"] }` enroll used to write was therefore inert
    // AND misleading — a future reader widening the kind guard would silently
    // activate those grants. Node keys carry no permission map: the kind
    // guard is the whole boundary, so the column must be NULL.
    const setupKey = await makeKey();
    const res = await enroll(bodyFor(setupKey));
    expect(res.status).toBe(201);
    const { nodeId } = (await res.json()) as { nodeId: string };
    createdNodeIds.push(nodeId);
    const node = await nodes.findById(nodeId);
    expect(node?.apiKeyId).toBeTruthy();
    const row = authDatabase()
      .prepare<{ permissions: string | null }, [string]>(`SELECT permissions FROM apikey WHERE id = ?`)
      .get(node?.apiKeyId as string);
    expect(row?.permissions).toBeNull();
  });

  it("wsUrl preserves a subpath APP_BASE_URL (17c regression)", async () => {
    // Under tests constants.ts pins APP_BASE_URL to the loopback default (env is
    // ignored), so the subpath spelling has to be injected via a module mock;
    // the snapshot is restored in finally so the rest of the suite is unaffected.
    mock.module("@/constants.js", () => ({ ...constantsSnapshot, APP_BASE_URL: "https://subshell.example/cloud" }));
    try {
      const setupKey = await makeKey();
      const res = await enroll(bodyFor(setupKey, { name: "subpath-node" }));
      expect(res.status).toBe(201);
      const body = (await res.json()) as { nodeId: string; wsUrl: string };
      createdNodeIds.push(body.nodeId);
      // The 17c bug: origin-only derivation made this `wss://subshell.example/ws/node`
      // and the persisted dial target missed the mount point end-to-end.
      expect(body.wsUrl).toBe("wss://subshell.example/cloud/ws/node");
    } finally {
      mock.module("@/constants.js", () => constantsSnapshot);
    }
  });

  it("nodeWsUrl: preserves multi-segment paths, trims trailing slashes, maps scheme", () => {
    expect(nodeWsUrl("http://localhost:3080")).toBe("ws://localhost:3080/ws/node");
    expect(nodeWsUrl("http://127.0.0.1:3080/")).toBe("ws://127.0.0.1:3080/ws/node");
    expect(nodeWsUrl("https://subshell.example/cloud/")).toBe("wss://subshell.example/cloud/ws/node");
    expect(nodeWsUrl("https://subshell.example/a/b//")).toBe("wss://subshell.example/a/b/ws/node");
  });

  it("second redemption of the same key → 401 SETUP_KEY_CONSUMED (ledger 17a)", async () => {
    const setupKey = await makeKey();
    const first = await enroll(bodyFor(setupKey));
    expect(first.status).toBe(201);
    createdNodeIds.push(((await first.json()) as { nodeId: string }).nodeId);

    const secondName = `reuse-${crypto.randomUUID().slice(0, 8)}`;
    const ownedBefore = await nodes.listByOwner(aliceId);
    const again = await enroll(bodyFor(setupKey, { name: secondName }));
    expect(again.status).toBe(401);
    const err = (await again.json()) as { code: string; message: string };
    // The state-distinction batch (task 17a): a spent key now reads CONSUMED,
    // not the old one-honest-code-for-all-three INVALID.
    expect(err.code).toBe("SETUP_KEY_CONSUMED");
    expect(err.message).toContain("already been used");
    // The rejected redemption wrote nothing: the creator's node rows are unchanged
    // and the 401's name never became a node.
    const ownedAfter = await nodes.listByOwner(aliceId);
    expect(ownedAfter.length).toBe(ownedBefore.length);
    expect(ownedAfter.some((n) => n.name === secondName)).toBe(false);
  });

  it("expired key → 401 SETUP_KEY_EXPIRED (no row churn, ledger 17a)", async () => {
    const expiredRow = await repo.create(aliceId, -1000); // already expired
    createdSetupKeyIds.push(expiredRow.id);
    const expiredName = `expired-${crypto.randomUUID().slice(0, 8)}`;
    const ownedBefore = await nodes.listByOwner(aliceId);
    const res = await enroll(bodyFor(expiredRow.key, { name: expiredName }));
    expect(res.status).toBe(401);
    const err = (await res.json()) as { code: string; message: string };
    expect(err.code).toBe("SETUP_KEY_EXPIRED");
    expect(err.message).toContain("expired");
    const ownedAfter = await nodes.listByOwner(aliceId);
    expect(ownedAfter.length).toBe(ownedBefore.length);
    expect(ownedAfter.some((n) => n.name === expiredName)).toBe(false);
  });

  it("unknown key → 401 SETUP_KEY_INVALID (no row churn)", async () => {
    const ownedBefore = await nodes.listByOwner(aliceId);
    const res = await enroll(bodyFor("nsk_not_a_real_key_at_all"));
    expect(res.status).toBe(401);
    const err = (await res.json()) as { code: string; message: string };
    expect(err.code).toBe("SETUP_KEY_INVALID");
    // The invalid case keeps its pre-17a wording verbatim (the three-state sentence).
    expect(err.message).toContain("invalid, expired, or already used");
    const ownedAfter = await nodes.listByOwner(aliceId);
    expect(ownedAfter.length).toBe(ownedBefore.length);
  });

  it("bad publicKey fails BEFORE consume — key stays redeemable", async () => {
    const setupKey = await makeKey();
    // Both fixtures stay ABOVE the body schema's `minLength: 16` so they pass schema
    // validation and genuinely reach the route's own JSON.parse-catch /
    // assertImportablePublicJwk branches (shorter strings die at the schema instead).
    const garbage = await enroll(bodyFor(setupKey, { publicKey: "this-is-not-json-at-all" }));
    expect(garbage.status).toBe(400);
    expect(await repo.peekValid(setupKey)).toBe(true);

    const notImportable = await enroll(
      bodyFor(setupKey, {
        publicKey: JSON.stringify({ kty: "OKP", crv: "Ed25519", x: "a".repeat(43) }),
      }),
    );
    expect(notImportable.status).toBe(400);
    expect(await repo.peekValid(setupKey)).toBe(true);

    // The very same key still redeems with a good JWK.
    const ok = await enroll(bodyFor(setupKey));
    expect(ok.status).toBe(201);
    createdNodeIds.push(((await ok.json()) as { nodeId: string }).nodeId);
  });

  // ── Link encryption key exchange (spec 2026-09-24 §3): enroll provisions BOTH
  // directions — the node's static public half lands on the row, the plane's
  // static public half is pinned by the agent from the response.

  it("valid encryptPublicKey → stored on the row; response carries controlEncryptPublicKey (32-byte base64, stable per instance)", async () => {
    const link = await generateLinkKeyPair();
    const setupKey = await makeKey();
    const res = await enroll(bodyFor(setupKey, { name: "kx-node", encryptPublicKey: link.publicKey }));
    expect(res.status).toBe(201);
    const body = (await res.json()) as { nodeId: string; controlEncryptPublicKey: string };
    createdNodeIds.push(body.nodeId);

    expect((await nodes.findById(body.nodeId))?.encryptPublicKey).toBe(link.publicKey);

    // The plane's answer is its OWN static — base64 decoding to 32 bytes, never
    // the node's key echoed back.
    const sodium = await ensureSodium();
    expect(sodium.from_base64(body.controlEncryptPublicKey).length).toBe(32);
    expect(body.controlEncryptPublicKey).not.toBe(link.publicKey);

    // Static per instance: a second enroll gets the same answer, and the key is
    // long-term (the node pins it; rotation is manual, spec §3).
    const second = await enroll(bodyFor(await makeKey(), { name: "kx-node-2", encryptPublicKey: link.publicKey }));
    expect(second.status).toBe(201);
    const secondBody = (await second.json()) as { nodeId: string; controlEncryptPublicKey: string };
    createdNodeIds.push(secondBody.nodeId);
    expect(secondBody.controlEncryptPublicKey).toBe(body.controlEncryptPublicKey);
  });

  it("a pre-v14 enroll (no encryptPublicKey) stores null and STILL gets controlEncryptPublicKey", async () => {
    // The field is optional so an old one-liner still enrolls — the row simply
    // carries no pin (legacy held mode until §5's first-connect registration).
    // The response field is NOT optional: a v14 agent must always be able to pin.
    const setupKey = await makeKey();
    const res = await enroll(bodyFor(setupKey, { name: "legacy-one" }));
    expect(res.status).toBe(201);
    const body = (await res.json()) as { nodeId: string; controlEncryptPublicKey: string };
    createdNodeIds.push(body.nodeId);

    expect((await nodes.findById(body.nodeId))?.encryptPublicKey).toBeNull();
    expect((await ensureSodium()).from_base64(body.controlEncryptPublicKey).length).toBe(32);
  });

  it("malformed encryptPublicKey fails BEFORE consume — key stays redeemable", async () => {
    // THE ordering test for the new field (same position the publicKey checks
    // hold): a body that cannot be stored must not spend the single-use key.
    // Both fixtures stay inside the schema's 43-44 char window so they reach
    // the route's decode check rather than dying at schema validation.
    const setupKey = await makeKey();
    const sodium = await ensureSodium();

    const notBase64 = await enroll(bodyFor(setupKey, { encryptPublicKey: "!".repeat(43) }));
    expect(notBase64.status).toBe(400);
    expect(((await notBase64.json()) as { message: string }).message).toInclude("encryptPublicKey");
    expect(await repo.peekValid(setupKey)).toBe(true);

    // Valid base64, wrong byte length (33 → 44 chars, schema-legal).
    const wrongLength = sodium.to_base64(new Uint8Array(33));
    expect(wrongLength.length).toBe(44);
    const badLen = await enroll(bodyFor(setupKey, { encryptPublicKey: wrongLength }));
    expect(badLen.status).toBe(400);
    expect(((await badLen.json()) as { message: string }).message).toInclude("encryptPublicKey");
    expect(await repo.peekValid(setupKey)).toBe(true);

    // The very same key still redeems with a valid key.
    const ok = await enroll(bodyFor(setupKey, { encryptPublicKey: (await generateLinkKeyPair()).publicKey }));
    expect(ok.status).toBe(201);
    createdNodeIds.push(((await ok.json()) as { nodeId: string }).nodeId);
  });

  it("private JWK (carries `d`) → 400 + key unconsumed", async () => {
    const setupKey = await makeKey();
    const res = await enroll(bodyFor(setupKey, { publicKey: await jwkString(true) }));
    expect(res.status).toBe(400);
    expect(await repo.peekValid(setupKey)).toBe(true);
  });

  // ── Relay signing identity (spec 2026-10-08 §4.1/§4.2): enroll carries the
  // machine's ES256 public key into the SAME `node:` identity record, and a
  // bad one burns nothing.

  it("a valid signingPublicKey registers beside the encryption key", async () => {
    const setupKey = await makeKey();
    const res = await enroll(bodyFor(setupKey, { name: "relay-id" }));
    expect(res.status).toBe(201);
    const { nodeId } = (await res.json()) as { nodeId: string };
    createdNodeIds.push(nodeId);
    const identity = await identities.findByPrincipal(`node:${nodeId}`);
    expect(identity?.signingPublicKey).toBe(goodSigningJwk);
    // The relay half lives only in the identities record, never on the node row.
    expect(await nodes.findById(nodeId)).not.toHaveProperty("signingPublicKey");
  });

  it("an absent signingPublicKey (pre-M2 agent) still enrolls and registers NULL", async () => {
    // The field is optional so an old binary enrolls unchanged; §4.3's
    // bootstrap delivers the signing key over the node link later. Until then
    // the slot is NULL, exactly the shape every pre-M2 row carries.
    const setupKey = await makeKey();
    const res = await enroll(bodyFor(setupKey, { name: "pre-m2-one", signingPublicKey: undefined }));
    expect(res.status).toBe(201);
    const { nodeId } = (await res.json()) as { nodeId: string };
    createdNodeIds.push(nodeId);
    const identity = await identities.findByPrincipal(`node:${nodeId}`);
    expect(identity?.publicKey).toBe(goodJwk);
    expect(identity?.signingPublicKey).toBeNull();
  });

  it("malformed signingPublicKey fails BEFORE consume — key stays redeemable", async () => {
    // THE ordering test for the new field (same position the publicKey checks
    // hold): a body that cannot be stored must not spend the single-use key.
    // The fixture stays above the schema's minLength so it genuinely reaches
    // the route's own decode branches.
    const setupKey = await makeKey();

    const notJson = await enroll(bodyFor(setupKey, { signingPublicKey: "this-is-not-json-at-all" }));
    expect(notJson.status).toBe(400);
    expect(((await notJson.json()) as { message: string }).message).toInclude("signingPublicKey");
    expect(await repo.peekValid(setupKey)).toBe(true);

    // Well-formed, right shape, coordinates off the curve: only the real
    // import proves a curve point (the publicKey discipline, measured).
    const offCurve = await enroll(
      bodyFor(setupKey, {
        signingPublicKey: JSON.stringify({ kty: "EC", crv: "P-256", x: "A".repeat(43), y: "B".repeat(43) }),
      }),
    );
    expect(offCurve.status).toBe(400);
    expect(((await offCurve.json()) as { message: string }).message).toInclude("signingPublicKey");
    expect(await repo.peekValid(setupKey)).toBe(true);

    // The very same key still redeems with a good signing JWK.
    const ok = await enroll(bodyFor(setupKey));
    expect(ok.status).toBe(201);
    createdNodeIds.push(((await ok.json()) as { nodeId: string }).nodeId);
  });

  it("private signing JWK (carries `d`) → 400 + key unconsumed", async () => {
    const setupKey = await makeKey();
    const res = await enroll(bodyFor(setupKey, { signingPublicKey: await signingJwkString(true) }));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { message: string }).message).toInclude("signingPublicKey");
    expect(await repo.peekValid(setupKey)).toBe(true);
  });

  it("os outside linux|darwin|unknown → 400 + key unconsumed", async () => {
    const setupKey = await makeKey();
    const res = await enroll(bodyFor(setupKey, { os: "windows" }));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe("INPUT_VALIDATION_ERROR");
    expect(await repo.peekValid(setupKey)).toBe(true);
  });

  it("a name with nothing printable in it → 400 + key unconsumed", async () => {
    // The machine supplies the name now (the mint dialog stopped asking), so this
    // body is the one door through which every spelling arrives: a prompt answer,
    // --name, the desktop field, or a script's JSON. Whitespace and control
    // characters are what a paste or a terminal can hand over, and an empty row
    // in the Nodes page is worse than a refusal — refused BEFORE consume, because
    // a single-use key must not be spent by a body that cannot be stored.
    for (const name of ["   ", "\t\n", "\u0000\u0007"]) {
      const setupKey = await makeKey();
      const res = await enroll(bodyFor(setupKey, { name }));
      expect(res.status).toBe(400);
      expect(((await res.json()) as { message: string }).message).toBe(
        "A node name needs at least one printable character",
      );
      expect(await repo.peekValid(setupKey)).toBe(true);
    }
  });

  it("the name is normalized on the way in, exactly as rename normalizes it", async () => {
    // One rule for both doors (enroll and rename), from one function in
    // @internal/subshell-protocol: control characters become spaces, runs of
    // whitespace collapse, the ends trim, and the cap is NODE_NAME_MAX.
    const setupKey = await makeKey();
    const res = await enroll(bodyFor(setupKey, { name: "  mac\n\tmini  two  " }));
    expect(res.status).toBe(201);
    const { nodeId } = (await res.json()) as { nodeId: string };
    createdNodeIds.push(nodeId);
    expect((await nodes.findById(nodeId))?.name).toBe("mac mini two");
  });

  it("the schema counts units, so a 64-character astral name enrolls intact", async () => {
    // `NODE_NAME_MAX_UNITS` exists for THIS body. JSON Schema counts UTF-16 code
    // units, so `maxLength: NODE_NAME_MAX` answered a name the shared rule calls
    // legal with a validation error naming nothing the operator could act on — and
    // the machine had already been asked for it. Widening the schema moved no limit:
    // `normalizeNodeName` still caps at 64 characters, which is what gets stored.
    const setupKey = await makeKey();
    const widest = "\u{1F5A5}".repeat(NODE_NAME_MAX); // 64 characters, 128 units
    const res = await enroll(bodyFor(setupKey, { name: widest }));
    expect(res.status).toBe(201);
    const { nodeId } = (await res.json()) as { nodeId: string };
    createdNodeIds.push(nodeId);
    expect((await nodes.findById(nodeId))?.name).toBe(widest);
  });

  it("duplicate name for the same owner → 409 NODE_NAME_TAKEN", async () => {
    const name = `dup-${crypto.randomUUID().slice(0, 8)}`;
    const first = await enroll(bodyFor(await makeKey(), { name }));
    expect(first.status).toBe(201);
    createdNodeIds.push(((await first.json()) as { nodeId: string }).nodeId);

    const second = await enroll(bodyFor(await makeKey(), { name }));
    expect(second.status).toBe(409);
    expect(((await second.json()) as { code: string }).code).toBe("NODE_NAME_TAKEN");
  });
});
