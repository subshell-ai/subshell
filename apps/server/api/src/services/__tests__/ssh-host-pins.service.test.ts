import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { BackendErrorCodes } from "@internal/backend-errors";
import type { NodeSshHostKeyResult } from "@internal/subshell-protocol";
import { hashPassword } from "better-auth/crypto";
import { ensureMigratedTestDb } from "@/__tests__/helpers/test-database.js";
import { deleteUserByEmailOrId, setupAuthTables } from "@/api/__tests__/helpers/auth-tables.js";
import { db } from "@/db/index.js";
import { UsersRepository } from "@/db/repositories/users.repository.js";
import { SshRpcError } from "@/services/nodes/ssh-rpc.js";
import {
  captureHostPin,
  deleteHostPin,
  hostKeyFingerprints,
  hostPinFor,
  hostPinRefusal,
  listHostPins,
  SshHostPinError,
  setSshHostPinsDepsForTests,
} from "@/services/ssh-host-pins.service.js";

/**
 * The host-key pin store (spec 2026-10-08 §9, Task 12). The properties this
 * suite exists to pin, one per §9 sentence:
 *
 * - A CAPTURE writes the destination's pin from A's `known_hosts` answer and
 *   audits `node.ssh_host_pin.create` naming destination + fingerprint ONLY:
 *   the audit row and every log path must never carry the line's bytes, and
 *   the fingerprint is OpenSSH's own `SHA256:` over the decoded blob.
 * - The EMPTY answer is the named `no-pin` failure (mapped to
 *   SSH_HOST_PIN_MISSING): a relay grant never stands without its pin.
 * - MULTIPLE distinct keys are `ambiguous`, refused rather than picked.
 * - A capture at a key DIFFERENT from the stored pin is `changed`: nothing
 *   is written, nothing is overwritten, the row stands verbatim.
 * - The SAME key again is idempotent (no second create row; updatedAt moves).
 * - DELETE + re-capture is the TOFU recovery: the differing key becomes the
 *   new pin only AFTER the delete, and the delete audits destination +
 *   fingerprint.
 * - Per-owner scoping: a foreign owner's pin is absent, never forbidden.
 * - The explicit line (trust-screen supply) is grammar-checked and audits
 *   `via: explicit`.
 *
 * The A fetch is the service's own seam; no test here touches a socket, an
 * ssh-keygen, or a developer's `~/.ssh`.
 */

const HOST = "git.example.test";
const DEST = `${HOST}:22`;
/** A real ed25519 public blob shape: the wire encoding, base64'd as known_hosts spells it. */
const KEY_BYTES = Buffer.concat([
  Buffer.from([0, 0, 0, 11]),
  Buffer.from("ssh-ed25519"),
  Buffer.from([0, 0, 0, 32]),
  Buffer.alloc(32, 7),
]);
const LINE = `${HOST} ssh-ed25519 ${KEY_BYTES.toString("base64")}`;
const OTHER_BYTES = Buffer.concat([Buffer.from([0, 0, 0, 11]), Buffer.from("ssh-ed25519"), Buffer.alloc(32, 9)]);
const OTHER_LINE = `${HOST} ssh-ed25519 ${OTHER_BYTES.toString("base64")}`;
const EXPECTED_FP = `SHA256:${createHash("sha256").update(KEY_BYTES).digest("base64url")}`;
const OTHER_FP = `SHA256:${createHash("sha256").update(OTHER_BYTES).digest("base64url")}`;

/** A clock the suite moves: stamps assert the touch, the row, and the audit. */
let clockMs = Date.parse("2026-10-08T00:00:00.000Z");

/** Scripted A: what the fetch answers, or the RPC error it throws. */
let fetchAnswer: () => NodeSshHostKeyResult = () => ({ lines: [LINE] });
let fetchCalls: { nodeId: string; triple: unknown }[] = [];

function installDeps() {
  fetchCalls = [];
  setSshHostPinsDepsForTests({
    nowIso: () => new Date(clockMs).toISOString(),
    fetchHostKey: async (nodeId, triple) => {
      fetchCalls.push({ nodeId, triple });
      return fetchAnswer();
    },
  });
}

async function expectPinError(fn: () => Promise<unknown>, code: SshHostPinError["code"]): Promise<SshHostPinError> {
  try {
    await fn();
  } catch (err) {
    expect(err).toBeInstanceOf(SshHostPinError);
    const e = err as SshHostPinError;
    expect(e.code).toBe(code);
    return e;
  }
  throw new Error(`expected SshHostPinError(${code}); nothing threw`);
}

let owner: string;
let stranger: string;
const emails: string[] = [];

async function mkUser(tag: string): Promise<string> {
  const email = `hostpins-${tag}-${crypto.randomUUID()}@subshell.local`;
  emails.push(email);
  return await new UsersRepository(db).createUser({
    email,
    name: email,
    passwordHash: await hashPassword("hostpins-1"),
    role: "user",
  });
}

beforeAll(async () => {
  await setupAuthTables();
  await ensureMigratedTestDb();
  owner = await mkUser("owner");
  stranger = await mkUser("stranger");
});

afterAll(async () => {
  setSshHostPinsDepsForTests(null);
  await db.deleteFrom("sshHostPins").execute();
  await db.deleteFrom("auditEvents").execute();
  for (const mail of emails) await deleteUserByEmailOrId(mail);
});

beforeEach(async () => {
  clockMs = Date.parse("2026-10-08T00:00:00.000Z");
  fetchAnswer = () => ({ lines: [LINE] });
  installDeps();
  await db.deleteFrom("sshHostPins").execute();
  await db.deleteFrom("auditEvents").execute();
});

async function latestAudit(action: string): Promise<Record<string, unknown>> {
  const rows = await db
    .selectFrom("auditEvents")
    .select(["metadataJson"])
    .where("action", "=", action)
    .orderBy("createdAt", "desc")
    .limit(1)
    .execute();
  return rows[0] ? (JSON.parse(rows[0].metadataJson ?? "{}") as Record<string, unknown>) : {};
}

describe("capture", () => {
  it("writes the pin from A's answer and audits destination + fingerprint, never the bytes", async () => {
    const row = await captureHostPin({ ownerUserId: owner, aNodeId: "node-a", destination: DEST });
    expect(row.hostKey).toBe(LINE);
    expect(row.destination).toBe(DEST);
    // The ask carried the PARSED triple (not the raw text): host git.example.test, port 22, user null.
    expect(fetchCalls).toEqual([{ nodeId: "node-a", triple: { host: HOST, port: 22, user: null } }]);
    const audit = await latestAudit("node.ssh_host_pin.create");
    expect(audit.destination).toBe(DEST);
    expect(audit.fingerprint).toBe(EXPECTED_FP);
    expect(audit.via).toBe("captured");
    // The bytes are nowhere on the trail: the base64 key material is not in
    // the audit metadata (the fingerprint is its digest, not its spelling).
    const meta = JSON.stringify(audit);
    expect(meta).not.toContain(KEY_BYTES.toString("base64"));
    expect(hostKeyFingerprints(LINE)).toEqual([EXPECTED_FP]);
  });

  it("an empty answer is the named no-pin failure and writes NOTHING (a relay grant never lacks its pin)", async () => {
    fetchAnswer = () => ({ lines: [] });
    const err = await expectPinError(
      () => captureHostPin({ ownerUserId: owner, aNodeId: "node-a", destination: DEST }),
      "no-pin",
    );
    expect(hostPinRefusal(err)).toMatchObject({ status: 409, code: BackendErrorCodes.SSH_HOST_PIN_MISSING });
    expect(await hostPinFor({ ownerUserId: owner, destination: DEST })).toBeNull();
    const rows = await db
      .selectFrom("auditEvents")
      .select("id")
      .where("action", "=", "node.ssh_host_pin.create")
      .execute();
    expect(rows).toHaveLength(0);
  });

  it("two distinct keys from A are refused (ambiguous), not picked", async () => {
    fetchAnswer = () => ({ lines: [LINE, OTHER_LINE] });
    await expectPinError(
      () => captureHostPin({ ownerUserId: owner, aNodeId: "node-a", destination: DEST }),
      "ambiguous",
    );
    expect(await hostPinFor({ ownerUserId: owner, destination: DEST })).toBeNull();
  });

  it("a differing capture is the changed hard block: nothing written, the row stands verbatim", async () => {
    await captureHostPin({ ownerUserId: owner, aNodeId: "node-a", destination: DEST });
    fetchAnswer = () => ({ lines: [OTHER_LINE] });
    const err = await expectPinError(
      () => captureHostPin({ ownerUserId: owner, aNodeId: "node-a", destination: DEST }),
      "changed",
    );
    expect(hostPinRefusal(err).code).toBe(BackendErrorCodes.SSH_HOST_PIN_CHANGED);
    const standing = await hostPinFor({ ownerUserId: owner, destination: DEST });
    expect(standing?.hostKey).toBe(LINE); // never overwritten
    const rows = await db
      .selectFrom("auditEvents")
      .select("id")
      .where("action", "=", "node.ssh_host_pin.create")
      .execute();
    expect(rows).toHaveLength(1); // the original capture is the only create row
  });

  it("the same key again is idempotent: no second create row, the updatedAt stamp moves", async () => {
    await captureHostPin({ ownerUserId: owner, aNodeId: "node-a", destination: DEST });
    clockMs += 60_000;
    const again = await captureHostPin({ ownerUserId: owner, aNodeId: "node-a", destination: DEST });
    expect(again.updatedAt).toBe(new Date(clockMs).toISOString());
    const creates = await db
      .selectFrom("auditEvents")
      .select("id")
      .where("action", "=", "node.ssh_host_pin.create")
      .execute();
    expect(creates).toHaveLength(1);
  });

  it("an explicit line (the trust-screen door) pins without asking A, audited via explicit", async () => {
    const row = await captureHostPin({ ownerUserId: owner, aNodeId: null, destination: DEST, hostKeyLine: LINE });
    expect(row.hostKey).toBe(LINE);
    expect(fetchCalls).toHaveLength(0); // supplied is never fetched
    const audit = await latestAudit("node.ssh_host_pin.create");
    expect(audit.via).toBe("explicit");
  });

  it("an explicit line that is not ONE grammar-valid key entry is refused", async () => {
    await expectPinError(
      () => captureHostPin({ ownerUserId: owner, aNodeId: null, destination: DEST, hostKeyLine: "just-a-host" }),
      "invalid-line",
    );
    await expectPinError(
      () =>
        captureHostPin({
          ownerUserId: owner,
          aNodeId: null,
          destination: DEST,
          hostKeyLine: "a b\nsecond ssh-ed25519 A",
        }),
      "invalid-line",
    );
  });

  it("the machine's RPC failures leave as the named capture causes (offline, refused)", async () => {
    fetchAnswer = () => {
      throw new SshRpcError("offline", "no live socket", "node-a");
    };
    const offline = await expectPinError(
      () => captureHostPin({ ownerUserId: owner, aNodeId: "node-a", destination: DEST }),
      "offline",
    );
    expect(hostPinRefusal(offline)).toMatchObject({ status: 409, code: BackendErrorCodes.NODE_OFFLINE });
    fetchAnswer = () => {
      throw new SshRpcError("refused", "ssh disabled on this node", "node-a");
    };
    const refused = await expectPinError(
      () => captureHostPin({ ownerUserId: owner, aNodeId: "node-a", destination: DEST }),
      "refused",
    );
    expect(hostPinRefusal(refused)).toMatchObject({ status: 502, code: BackendErrorCodes.SSH_NODE_REFUSED });
    expect(await hostPinFor({ ownerUserId: owner, destination: DEST })).toBeNull();
  });
});

describe("delete and re-capture (the TOFU recovery)", () => {
  it("delete removes the row and audits destination + fingerprint; the re-capture at the NEW key succeeds as a fresh TOFU", async () => {
    await captureHostPin({ ownerUserId: owner, aNodeId: "node-a", destination: DEST });
    const removed = await deleteHostPin({ ownerUserId: owner, destination: DEST });
    expect(removed?.hostKey).toBe(LINE);
    const audit = await latestAudit("node.ssh_host_pin.delete");
    expect(audit.destination).toBe(DEST);
    expect(audit.fingerprint).toBe(EXPECTED_FP);
    // The §9 recovery: only AFTER the delete does the differing key become the pin.
    fetchAnswer = () => ({ lines: [OTHER_LINE] });
    const re = await captureHostPin({ ownerUserId: owner, aNodeId: "node-a", destination: DEST });
    expect(re.hostKey).toBe(OTHER_LINE);
    expect(re.createdAt).toBe(new Date(clockMs).toISOString());
    // The recovered pin fingerprints as the NEW key.
    expect(hostKeyFingerprints(re.hostKey)).toEqual([OTHER_FP]);
  });

  it("deleting an absent or foreign destination answers null and audits nothing", async () => {
    await captureHostPin({ ownerUserId: owner, aNodeId: "node-a", destination: DEST });
    expect(await deleteHostPin({ ownerUserId: stranger, destination: DEST })).toBeNull();
    expect(await deleteHostPin({ ownerUserId: owner, destination: "other.test:22" })).toBeNull();
    expect(await hostPinFor({ ownerUserId: owner, destination: DEST })).not.toBeNull(); // stranger deleted nothing
    const dels = await db
      .selectFrom("auditEvents")
      .select("id")
      .where("action", "=", "node.ssh_host_pin.delete")
      .execute();
    expect(dels).toHaveLength(0);
  });

  it("pins are per-owner and per-destination: one owner's pin is absent for the other, and ports/users are distinct keys", async () => {
    await captureHostPin({ ownerUserId: owner, aNodeId: "node-a", destination: DEST });
    expect(await hostPinFor({ ownerUserId: stranger, destination: DEST })).toBeNull();
    expect(await listHostPins({ ownerUserId: stranger })).toHaveLength(0);
    const withUser = `deploy@${HOST}:22`;
    await captureHostPin({ ownerUserId: owner, aNodeId: "node-a", destination: withUser, hostKeyLine: LINE });
    expect(await listHostPins({ ownerUserId: owner })).toHaveLength(2);
    // The screens list never carries key bytes - only the fingerprint view.
    const views = await listHostPins({ ownerUserId: owner });
    expect(JSON.stringify(views)).not.toContain(KEY_BYTES.toString("base64"));
    expect(views.every((v) => v.fingerprint === EXPECTED_FP)).toBe(true);
  });
});

describe("the user@host:port triple", () => {
  it("a user and a non-default port parse to the ask the capture sends", async () => {
    await captureHostPin({ ownerUserId: owner, aNodeId: "node-a", destination: "deploy@git.example.test:2222" });
    expect(fetchCalls).toEqual([{ nodeId: "node-a", triple: { host: HOST, port: 2222, user: "deploy" } }]);
  });
});
