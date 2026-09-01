import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { hashPassword } from "better-auth/crypto";
import { Elysia } from "elysia";
import { exportJWK, generateKeyPair } from "jose";
import { nodesRoutes } from "@/api/nodes/index.js";
import { authDatabase } from "@/auth/database.js";
import { db } from "@/db/index.js";
import { IdentitiesRepository } from "@/db/repositories/identities.repository.js";
import { NodeSetupKeysRepository } from "@/db/repositories/node-setup-keys.repository.js";
import { NodesRepository } from "@/db/repositories/nodes.repository.js";
import { UsersRepository } from "@/db/repositories/users.repository.js";
import { errorHandlerPlugin } from "@/plugins/error-handler.plugin.js";
import { deleteUserByEmailOrId, setupAuthTables, signIn } from "../../__tests__/helpers/auth-tables.js";

/** Fresh extractable P-256 keypair exported as a JWK string; `withD` exports the PRIVATE half. */
async function jwkString(withD = false): Promise<string> {
  const { publicKey, privateKey } = await generateKeyPair("ECDH-ES", { crv: "P-256", extractable: true });
  return JSON.stringify(await exportJWK(withD ? privateKey : publicKey));
}

/**
 * `POST /api/nodes/enroll` — public redemption of a single-use setup key
 * (spec 2026-08-31 §5.2). The setup key IS the credential (no authGuard).
 * Validation happens BEFORE consumption, and the write order is
 * consume → node row → identity → api key → setApiKeyId.
 */
describe("/api/nodes/enroll", () => {
  const pw = "enroll-1";
  const aliceEmail = `enroll-alice-${crypto.randomUUID()}@mote.local`;
  let aliceId: string;
  const app = new Elysia().use(errorHandlerPlugin).use(nodesRoutes);
  const repo = new NodeSetupKeysRepository(db);
  const nodes = new NodesRepository(db);
  const identities = new IdentitiesRepository(db);

  const createdNodeIds: string[] = [];
  const createdSetupKeyIds: string[] = [];
  let goodJwk: string;

  beforeAll(async () => {
    await setupAuthTables();
    aliceId = await new UsersRepository(db).createUser({
      email: aliceEmail,
      passwordHash: await hashPassword(pw),
      role: "user",
    });
    await signIn(aliceEmail, pw); // exercise the real auth stack; enroll itself needs no cookie
    goodJwk = await jwkString();
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

  /** Mint a real setup key owned by alice, tracked for cleanup. */
  async function makeKey(label: string): Promise<string> {
    const { row, plaintext } = await repo.create(label, aliceId);
    createdSetupKeyIds.push(row.id);
    return plaintext;
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
      ...over,
    };
  }

  it("happy path: 201 + node row + identity + node key; the setup key is spent", async () => {
    const setupKey = await makeKey("happy");
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

    // The identity row carries the exact validated JWK string under node:<id>.
    const identity = await identities.findByPrincipal(`node:${body.nodeId}`);
    expect(identity?.publicKey).toBe(goodJwk);
    expect(identity?.displayName).toBe("mini-one");

    // The node key is a real `mote_` bearer; the setup key cannot redeem again.
    expect(body.nodeKey.startsWith("mote_")).toBe(true);
    expect(await repo.peekValid(setupKey)).toBe(false);

    // controlPublicKey is a PUBLIC JWK; wsUrl follows the ws(s) scheme + /ws/node path.
    const cpk = JSON.parse(body.controlPublicKey) as { kty?: string; d?: string };
    expect(cpk.kty).toBe("EC");
    expect(cpk.d).toBeUndefined();
    expect(body.wsUrl).toMatch(/^wss?:\/\//);
    expect(body.wsUrl.endsWith("/ws/node")).toBe(true);

    // No key internals on the wire.
    const raw = JSON.stringify(body);
    expect(raw).not.toContain("expiresAt");
    expect(raw).not.toContain("keyHash");
  });

  it("second redemption of the same key → 401 SETUP_KEY_INVALID", async () => {
    const setupKey = await makeKey("reuse");
    const first = await enroll(bodyFor(setupKey));
    expect(first.status).toBe(201);
    createdNodeIds.push(((await first.json()) as { nodeId: string }).nodeId);

    const secondName = `reuse-${crypto.randomUUID().slice(0, 8)}`;
    const ownedBefore = await nodes.listByOwner(aliceId);
    const again = await enroll(bodyFor(setupKey, { name: secondName }));
    expect(again.status).toBe(401);
    const err = (await again.json()) as { code: string; message: string };
    expect(err.code).toBe("SETUP_KEY_INVALID");
    // One honest code for invalid/expired/used — the message says all three.
    expect(err.message).toContain("invalid, expired, or already used");
    // The rejected redemption wrote nothing: the creator's node rows are unchanged
    // and the 401's name never became a node.
    const ownedAfter = await nodes.listByOwner(aliceId);
    expect(ownedAfter.length).toBe(ownedBefore.length);
    expect(ownedAfter.some((n) => n.name === secondName)).toBe(false);
  });

  it("unknown key → 401 (no row churn)", async () => {
    const res = await enroll(bodyFor("nsk_not_a_real_key_at_all"));
    expect(res.status).toBe(401);
    expect(((await res.json()) as { code: string }).code).toBe("SETUP_KEY_INVALID");
  });

  it("bad publicKey fails BEFORE consume — key stays redeemable", async () => {
    const setupKey = await makeKey("validate-first");
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

  it("private JWK (carries `d`) → 400 + key unconsumed", async () => {
    const setupKey = await makeKey("private-jwk");
    const res = await enroll(bodyFor(setupKey, { publicKey: await jwkString(true) }));
    expect(res.status).toBe(400);
    expect(await repo.peekValid(setupKey)).toBe(true);
  });

  it("os outside linux|darwin|unknown → 400 + key unconsumed", async () => {
    const setupKey = await makeKey("bad-os");
    const res = await enroll(bodyFor(setupKey, { os: "windows" }));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe("INPUT_VALIDATION_ERROR");
    expect(await repo.peekValid(setupKey)).toBe(true);
  });

  it("duplicate name for the same owner → 409 NODE_NAME_TAKEN", async () => {
    const name = `dup-${crypto.randomUUID().slice(0, 8)}`;
    const first = await enroll(bodyFor(await makeKey("dup-a"), { name }));
    expect(first.status).toBe(201);
    createdNodeIds.push(((await first.json()) as { nodeId: string }).nodeId);

    const second = await enroll(bodyFor(await makeKey("dup-b"), { name }));
    expect(second.status).toBe(409);
    expect(((await second.json()) as { code: string }).code).toBe("NODE_NAME_TAKEN");
  });
});
