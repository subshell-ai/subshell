import { afterAll, beforeAll, describe, expect, it, mock } from "bun:test";
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
import { deleteUserByEmailOrId, setupAuthTables, signIn } from "../../__tests__/helpers/auth-tables.js";

/** Fresh extractable P-256 keypair exported as a JWK string; `withD` exports the PRIVATE half. */
async function jwkString(withD = false): Promise<string> {
  const { publicKey, privateKey } = await generateKeyPair("ECDH-ES", { crv: "P-256", extractable: true });
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

    // The identity row carries the exact validated JWK string under node:<id>.
    const identity = await identities.findByPrincipal(`node:${body.nodeId}`);
    expect(identity?.publicKey).toBe(goodJwk);
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

  it("private JWK (carries `d`) → 400 + key unconsumed", async () => {
    const setupKey = await makeKey();
    const res = await enroll(bodyFor(setupKey, { publicKey: await jwkString(true) }));
    expect(res.status).toBe(400);
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
