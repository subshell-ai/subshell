import { afterAll, beforeAll, beforeEach, expect, it } from "bun:test";
import { BackendErrorCodes } from "@internal/backend-errors";
import type { SshConnectionSnapshotWire } from "@internal/subshell-protocol";
import { hashPassword } from "better-auth/crypto";
import { Elysia } from "elysia";
import { ensureMigratedTestDb } from "@/__tests__/helpers/test-database.js";
import { deleteUserByEmailOrId, setupAuthTables, signIn } from "@/api/__tests__/helpers/auth-tables.js";
import type { NodeGate } from "@/api/nodes/node-gate.js";
import { sshRoutes } from "@/api/ssh/index.js";
import { db } from "@/db/index.js";
import { UsersRepository } from "@/db/repositories/users.repository.js";
import { errorHandlerPlugin } from "@/plugins/error-handler.plugin.js";
import { setDestinationVerificationDepsForTests } from "@/services/ssh-destination-verification.service.js";
import { captureHostPin, hostPinFor } from "@/services/ssh-host-pins.service.js";

const app = new Elysia().use(errorHandlerPlugin).use(sshRoutes);
const emails = [0, 1].map((i) => `ssh-verify-${i}-${crypto.randomUUID()}@subshell.test`);
const cookies: string[] = [];
const users: string[] = [];
const request = { node: "connecting", keyHome: "keys", destination: "alias" };
const dest = "developer@host.test:2222";
const key = (n: number) =>
  Buffer.concat([
    Buffer.from([0, 0, 0, 11]),
    Buffer.from("ssh-ed25519"),
    Buffer.from([0, 0, 0, 32]),
    Buffer.alloc(32, n),
  ]).toString("base64");
const line = `[host.test]:2222 ssh-ed25519 ${key(1)}`;
const otherLine = `[host.test]:2222 ssh-ed25519 ${key(2)}`;
let now = 0;
let allowed = true;
let known: string[] = [];
let presented = line;
let scans = 0;
let snapshot: SshConnectionSnapshotWire;

function post(path: string, body: unknown, cookie = cookies[0]) {
  return app.fetch(
    new Request(`http://localhost:3099/api/ssh/${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(cookie ? { cookie: `better-auth.session_token=${cookie}` } : {}),
      },
      body: JSON.stringify(body),
    }),
  );
}
async function prepare() {
  const res = await post("verify-destination", request);
  expect(res.status).toBe(200);
  return (await res.json()) as { token: string; destination: string; fingerprint: string };
}

beforeAll(async () => {
  await setupAuthTables();
  await ensureMigratedTestDb();
  const password = "ssh-confirm-test-password";
  for (const email of emails) {
    users.push(
      await new UsersRepository(db).createUser({
        email,
        name: email,
        role: "user",
        passwordHash: await hashPassword(password),
      }),
    );
    cookies.push(await signIn(email, password));
  }
});
afterAll(async () => {
  setDestinationVerificationDepsForTests(null);
  for (const email of emails) await deleteUserByEmailOrId(email);
});
beforeEach(async () => {
  await db.deleteFrom("sshHostPins").execute();
  now = 0;
  allowed = true;
  known = [];
  presented = line;
  scans = 0;
  snapshot = {
    alias: "alias",
    host: "host.test",
    user: "developer",
    port: 2222,
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
  };
  setDestinationVerificationDepsForTests({
    now: () => now,
    gate: async () =>
      allowed
        ? { ok: true, value: {} as NodeGate }
        : {
            ok: false,
            refusal: { status: 403, code: BackendErrorCodes.SSH_GATE_OFF, message: "Access revoked" },
          },
    resolve: async () => ({ ok: true, value: { accepted: true, snapshot } }),
    hostKey: async (nodeId, target) => {
      expect(target).toMatchObject({ host: "host.test", port: 2222, user: "developer" });
      if (target.scan) {
        expect(nodeId).toBe("connecting");
        scans++;
        return { lines: [presented] };
      }
      expect(nodeId).toBe("keys");
      return { lines: known };
    },
  });
});

it("only remembers the identity offered to the authenticated viewer, once", async () => {
  const offer = await prepare();
  expect(offer.destination).toBe(dest);
  expect(offer.fingerprint).toStartWith("SHA256:");
  expect(JSON.stringify(offer)).not.toContain(key(1));
  expect(await hostPinFor({ ownerUserId: users[0], destination: dest })).toBeNull();
  expect((await post("verify-destination/accept", { token: offer.token }, cookies[1])).status).toBe(409);
  presented = otherLine; // Confirmation must not fetch and silently accept a newer key.
  expect((await post("verify-destination/accept", { token: offer.token })).status).toBe(200);
  expect((await hostPinFor({ ownerUserId: users[0], destination: dest }))?.hostKey).toBe(line);
  expect(await hostPinFor({ ownerUserId: users[1], destination: dest })).toBeNull();
  expect(scans).toBe(1);
  expect((await post("verify-destination/accept", { token: offer.token })).status).toBe(409);
});
it("rejects expired and unknown confirmations without saving anything", async () => {
  const offer = await prepare();
  now = 5 * 60_000;
  for (const token of [offer.token, "invented"])
    expect((await post("verify-destination/accept", { token })).status).toBe(409);
  expect(await hostPinFor({ ownerUserId: users[0], destination: dest })).toBeNull();
});
it("rechecks node access before accepting", async () => {
  const offer = await prepare();
  allowed = false;
  expect((await post("verify-destination/accept", { token: offer.token })).status).toBe(403);
  expect(await hostPinFor({ ownerUserId: users[0], destination: dest })).toBeNull();
});
it("rejects an alias that changed destination while the prompt was open", async () => {
  const offer = await prepare();
  snapshot = { ...snapshot, host: "changed.test" };
  expect((await post("verify-destination/accept", { token: offer.token })).status).toBe(409);
  expect(await db.selectFrom("sshHostPins").selectAll().execute()).toEqual([]);
});
it("a conflicting confirmation cannot replace existing trust", async () => {
  const offer = await prepare();
  await captureHostPin({ ownerUserId: users[0], aNodeId: null, destination: dest, hostKeyLine: otherLine });
  const res = await post("verify-destination/accept", { token: offer.token });
  expect(res.status).toBe(409);
  expect(((await res.json()) as { code: string }).code).toBe("SSH_HOST_PIN_CHANGED");
  expect((await hostPinFor({ ownerUserId: users[0], destination: dest }))?.hostKey).toBe(otherLine);
  expect((await post("verify-destination", request)).status).toBe(409);
  expect(scans).toBe(1);
});
it("cannot offer first-use trust over conflicting recorded identities or a different network path", async () => {
  known = [line, otherLine];
  expect((await post("verify-destination", request)).status).toBe(409);
  known = [];
  snapshot.hostKeyAlias = "other-name";
  expect((await post("verify-destination", request)).status).toBe(409);
  snapshot.hostKeyAlias = null;
  snapshot.proxyJumps = [{ host: "jump.test", user: null, port: 22 }];
  expect((await post("verify-destination", request)).status).toBe(409);
  expect(scans).toBe(0);
});
it("validates the request and authenticates before asking any node", async () => {
  expect((await post("verify-destination", request, "")).status).toBe(401);
  expect((await post("verify-destination/accept", { token: "unknown" }, "")).status).toBe(401);
  expect((await post("verify-destination", { ...request, destination: "x".repeat(254) })).status).toBe(400);
  expect(scans).toBe(0);
});
