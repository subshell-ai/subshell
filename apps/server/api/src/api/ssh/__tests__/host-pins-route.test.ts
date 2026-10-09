import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BackendErrorCodes } from "@internal/backend-errors";
import { hashPassword } from "better-auth/crypto";
import { Elysia } from "elysia";
import { ensureMigratedTestDb } from "@/__tests__/helpers/test-database.js";
import { deleteUserByEmailOrId, setupAuthTables, signIn } from "@/api/__tests__/helpers/auth-tables.js";
import { sshRoutes } from "@/api/ssh/index.js";
import { db } from "@/db/index.js";
import { SubshellsRepository } from "@/db/repositories/subshells.repository.js";
import { UsersRepository } from "@/db/repositories/users.repository.js";
import { LOCAL_NODE_ID } from "@/db/types/nodes.db-types.js";
import { errorHandlerPlugin } from "@/plugins/error-handler.plugin.js";
import { setSshHostPinsDepsForTests } from "@/services/ssh-host-pins.service.js";
import { issueSubshellToken } from "@/services/subshell-tokens.js";

/**
 * `/api/ssh/host-pins` (spec 2026-10-08 §8-§9, Task 12): the destination
 * trust screen's HTTP surface. Pinned here:
 * - the cookie doctrine of every ssh sibling (empty cookie 401, a bearer
 *   token 403), owner-scoped reads (a foreign destination is the SAME 404 an
 *   absent one is on DELETE);
 * - the serialized view carries destination + `SHA256:` fingerprint and NEVER
 *   the key bytes;
 * - POST supplies an explicit pin (grammar-checked destination and line, the
 *   §9 hard block as a 409 `SSH_HOST_PIN_CHANGED`), DELETE removes a pin and
 *   the follow-up re-capture succeeds (the TOFU recovery), and the audit trail
 *   names only destination + fingerprint.
 *
 * No key home is asked by these routes (the screen SUPPLIES lines), so no
 * node, broker, or fetch is wired - the pins service's fetch seam is installed
 * with a never-called script to keep the promise.
 */
const app = new Elysia().use(errorHandlerPlugin).use(sshRoutes);

const pw = "hostpinsapi-1";
const ownerEmail = `hostpinsapi-owner-${crypto.randomUUID()}@subshell.local`;
const otherEmail = `hostpinsapi-other-${crypto.randomUUID()}@subshell.local`;
let ownerId: string;
let ownerCookie: string;
let otherCookie: string;
const emails: string[] = [];

const KEY_BYTES = Buffer.concat([
  Buffer.from([0, 0, 0, 11]),
  Buffer.from("ssh-ed25519"),
  Buffer.from([0, 0, 0, 32]),
  Buffer.alloc(32, 5),
]);
const LINE = `git.example.test ssh-ed25519 ${KEY_BYTES.toString("base64")}`;
const FP = `SHA256:${createHash("sha256").update(KEY_BYTES).digest("base64url")}`;
const DEST = "git.example.test:22";
const probeSubshellIds: string[] = [];

function fetchPins(
  path = "/api/ssh/host-pins",
  init: { method?: string; body?: unknown; cookie?: string; bearer?: string } = {},
) {
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
  // No fetch door on these routes; a call here is a bug the test would surface.
  setSshHostPinsDepsForTests({
    nowIso: () => new Date().toISOString(),
    fetchHostKey: async () => {
      throw new Error("the trust screen must never ask a key home");
    },
  });
});

afterAll(async () => {
  setSshHostPinsDepsForTests(null);
  await db.deleteFrom("sshHostPins").execute();
  await db.deleteFrom("auditEvents").execute();
  for (const id of probeSubshellIds) await new SubshellsRepository(db).delete(id).catch(() => {});
  for (const mail of emails) await deleteUserByEmailOrId(mail);
});

beforeEach(async () => {
  await db.deleteFrom("sshHostPins").execute();
  await db.deleteFrom("auditEvents").execute();
});

describe("the cookie doctrine", () => {
  it("an empty cookie is 401 and a real subshell token is 403 on every door", async () => {
    // A MACHINE credential must be refused the same way the sibling ssh doors
    // refuse it (the fake-token path 401s at better-auth before the guard).
    const subshellId = crypto.randomUUID();
    await new SubshellsRepository(db).create({
      id: subshellId,
      userId: ownerId,
      harnessId: "terminal",
      name: "hostpins-bearer-probe",
      workingDir: mkdtempSync(join(tmpdir(), "hostpins-bearer-")),
      tmuxSocket: null,
      nodeId: LOCAL_NODE_ID,
    });
    probeSubshellIds.push(subshellId);
    const key = await issueSubshellToken(subshellId, ownerId);
    expect((await fetchPins()).status).toBe(401);
    expect((await fetchPins(undefined, { bearer: key })).status).toBe(403);
    expect((await fetchPins(undefined, { method: "POST", body: { destination: DEST, hostKey: LINE } })).status).toBe(
      401,
    );
    expect((await fetchPins(`/api/ssh/host-pins/${DEST}`, { method: "DELETE", bearer: key })).status).toBe(403);
  });
});

describe("POST /api/ssh/host-pins (explicit pin)", () => {
  it("supplies a pin: the view carries destination + fingerprint, never the key bytes", async () => {
    const res = await fetchPins(undefined, {
      method: "POST",
      cookie: ownerCookie,
      body: { destination: DEST, hostKey: LINE },
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { pin: Record<string, string> };
    expect(json.pin.destination).toBe(DEST);
    expect(json.pin.fingerprint).toBe(FP);
    expect(JSON.stringify(json)).not.toContain(KEY_BYTES.toString("base64"));
    // The audit row names destination + fingerprint ONLY.
    const row = await db
      .selectFrom("auditEvents")
      .select("metadataJson")
      .where("action", "=", "node.ssh_host_pin.create")
      .executeTakeFirstOrThrow();
    const meta = JSON.parse(row.metadataJson ?? "{}") as Record<string, unknown>;
    expect(meta).toMatchObject({ destination: DEST, fingerprint: FP, via: "explicit" });
    expect(JSON.stringify(meta)).not.toContain(KEY_BYTES.toString("base64"));
  });

  it("refuses a non-canonical destination and a malformed key line with the named 400", async () => {
    const badDest = await fetchPins(undefined, {
      method: "POST",
      cookie: ownerCookie,
      body: { destination: "not-canonical", hostKey: LINE },
    });
    expect(badDest.status).toBe(400);
    expect(((await badDest.json()) as { code: string }).code).toBe(BackendErrorCodes.SSH_HOST_PIN_INVALID);
    const badLine = await fetchPins(undefined, {
      method: "POST",
      cookie: ownerCookie,
      body: { destination: DEST, hostKey: "git.example.test just-a-token" },
    });
    expect(badLine.status).toBe(400);
    const smuggled = await fetchPins(undefined, {
      method: "POST",
      cookie: ownerCookie,
      body: { destination: DEST, hostKey: `a b\nsecond ssh-ed25519 AAA` },
    });
    expect(smuggled.status).toBe(400);
    expect(await db.selectFrom("sshHostPins").selectAll().execute()).toHaveLength(0);
  });

  it("a destination already pinned to a DIFFERENT key is the §9 hard block, never an overwrite", async () => {
    await fetchPins(undefined, { method: "POST", cookie: ownerCookie, body: { destination: DEST, hostKey: LINE } });
    const other = Buffer.concat([Buffer.from([0, 0, 0, 11]), Buffer.from("ssh-ed25519"), Buffer.alloc(32, 9)]).toString(
      "base64",
    );
    const res = await fetchPins(undefined, {
      method: "POST",
      cookie: ownerCookie,
      body: { destination: DEST, hostKey: `git.example.test ssh-ed25519 ${other}` },
    });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe(BackendErrorCodes.SSH_HOST_PIN_CHANGED);
    // The standing pin is untouched.
    const standing = await db.selectFrom("sshHostPins").select("hostKey").executeTakeFirstOrThrow();
    expect(standing.hostKey).toBe(LINE);
  });
});

describe("GET list and the owner axis", () => {
  it("the list shows the caller's pins only, as fingerprint views", async () => {
    await fetchPins(undefined, { method: "POST", cookie: ownerCookie, body: { destination: DEST, hostKey: LINE } });
    const mine = (await (await fetchPins(undefined, { cookie: ownerCookie })).json()) as { pins: unknown[] };
    const theirs = (await (await fetchPins(undefined, { cookie: otherCookie })).json()) as { pins: unknown[] };
    expect(mine.pins).toHaveLength(1);
    expect(theirs.pins).toHaveLength(0);
    expect(JSON.stringify(mine.pins)).not.toContain(KEY_BYTES.toString("base64"));
  });
});

describe("DELETE /api/ssh/host-pins/:destination (the recovery)", () => {
  it("deletes the pin (audited with fingerprint) and the next supply at a NEW key succeeds as a fresh TOFU", async () => {
    await fetchPins(undefined, { method: "POST", cookie: ownerCookie, body: { destination: DEST, hostKey: LINE } });
    const del = await fetchPins(`/api/ssh/host-pins/${DEST}`, { method: "DELETE", cookie: ownerCookie });
    expect(del.status).toBe(200);
    expect(((await del.json()) as { deleted: boolean }).deleted).toBe(true);
    const delAudit = await db
      .selectFrom("auditEvents")
      .select("metadataJson")
      .where("action", "=", "node.ssh_host_pin.delete")
      .executeTakeFirstOrThrow();
    expect(JSON.parse(delAudit.metadataJson ?? "{}")).toMatchObject({ destination: DEST, fingerprint: FP });
    const other = Buffer.concat([Buffer.from([0, 0, 0, 11]), Buffer.from("ssh-ed25519"), Buffer.alloc(32, 9)]).toString(
      "base64",
    );
    const re = await fetchPins(undefined, {
      method: "POST",
      cookie: ownerCookie,
      body: { destination: DEST, hostKey: `git.example.test ssh-ed25519 ${other}` },
    });
    expect(re.status).toBe(200);
  });

  it("a foreign or absent destination is the same 404", async () => {
    await fetchPins(undefined, { method: "POST", cookie: ownerCookie, body: { destination: DEST, hostKey: LINE } });
    expect((await fetchPins(`/api/ssh/host-pins/${DEST}`, { method: "DELETE", cookie: otherCookie })).status).toBe(404);
    expect(
      (await fetchPins("/api/ssh/host-pins/nobody.test:22", { method: "DELETE", cookie: ownerCookie })).status,
    ).toBe(404);
    expect(await db.selectFrom("sshHostPins").selectAll().execute()).toHaveLength(1);
  });
});
