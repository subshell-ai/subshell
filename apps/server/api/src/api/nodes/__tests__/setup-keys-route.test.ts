import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { hashPassword } from "better-auth/crypto";
import { Elysia } from "elysia";
import { nodesRoutes } from "@/api/nodes/index.js";
import { authDatabase } from "@/auth/database.js";
import { db } from "@/db/index.js";
import { NodeSetupKeysRepository } from "@/db/repositories/node-setup-keys.repository.js";
import { SettingsRepository } from "@/db/repositories/settings.repository.js";
import { SubshellsRepository } from "@/db/repositories/subshells.repository.js";
import { UsersRepository } from "@/db/repositories/users.repository.js";
import { errorHandlerPlugin } from "@/plugins/error-handler.plugin.js";
import { ALLOW_NODE_ENROLLMENT_KEY } from "@/services/registration-gate.js";
import { issueSubshellToken } from "@/services/subshell-tokens.js";
import { deleteUserByEmailOrId, setupAuthTables, signIn } from "../../__tests__/helpers/auth-tables.js";

/** One key row as the list route renders it (no secret, no hash). */
type KeyRow = {
  id: string;
  label: string;
  createdAt: string;
  expiresAt: string;
  usedAt: string | null;
  consumedNodeId: string | null;
};

/**
 * `/api/nodes/setup-keys` — single-use enrollment key management (spec
 * 2026-08-31 §5.1/§9). Plaintext shown exactly once at create; the list never
 * carries the secret; owner-scoped list/delete; cookie-only (machine tokens
 * 403).
 */
describe("/api/nodes/setup-keys", () => {
  const pw = "setup-keys-1";
  const aliceEmail = `nsk-alice-${crypto.randomUUID()}@subshell.local`;
  const bobEmail = `nsk-bob-${crypto.randomUUID()}@subshell.local`;
  let aliceId: string;
  let aliceCookie: string;
  let bobCookie: string;
  const adminEmail = `nsk-admin-${crypto.randomUUID()}@subshell.local`;
  let adminCookie: string;
  let subshellKey: string;
  const createdApiKeyIds: string[] = [];
  const repo = new NodeSetupKeysRepository(db);

  async function mkUser(email: string, role: "user" | "admin" = "user"): Promise<string> {
    return await new UsersRepository(db).createUser({ email, name: email, passwordHash: await hashPassword(pw), role });
  }

  beforeAll(async () => {
    await setupAuthTables();
    aliceId = await mkUser(aliceEmail);
    await mkUser(bobEmail);
    aliceCookie = await signIn(aliceEmail, pw);
    bobCookie = await signIn(bobEmail, pw);
    await mkUser(adminEmail, "admin");
    adminCookie = await signIn(adminEmail, pw);

    // A real subshell bearer key owned by alice — proves cookie-only enforcement.
    await new SubshellsRepository(db).create({
      id: "s_nsk",
      userId: aliceId,
      presetId: "p",
      harnessId: "claude-code",
      name: "s_nsk",
      workingDir: "/tmp",
      tmuxSocket: null,
    });
    subshellKey = await issueSubshellToken("s_nsk", aliceId);
    const row = await new SubshellsRepository(db).findById("s_nsk");
    if (row?.apiKeyId) createdApiKeyIds.push(row.apiKeyId);
  });

  afterAll(async () => {
    for (const kid of createdApiKeyIds) authDatabase().run("DELETE FROM apikey WHERE id = ?", [kid]);
    await db.deleteFrom("subshells").where("id", "=", "s_nsk").execute();
    for (const email of [aliceEmail, bobEmail, adminEmail]) await deleteUserByEmailOrId(email);
  });

  async function req(
    method: string,
    path: string,
    opts: { cookie?: string; bearer?: string; body?: unknown } = {},
  ): Promise<Response> {
    const headers: Record<string, string> = {};
    if (opts.cookie) headers.cookie = `better-auth.session_token=${opts.cookie}`;
    if (opts.bearer) headers.authorization = `Bearer ${opts.bearer}`;
    if (opts.body !== undefined) headers["content-type"] = "application/json";
    return nodesRoutes.fetch(
      new Request(`http://localhost:3080/api/nodes${path}`, {
        method,
        headers,
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      }),
    );
  }

  async function listKeys(cookie: string): Promise<KeyRow[]> {
    const res = await req("GET", "/setup-keys", { cookie });
    expect(res.status).toBe(200);
    return ((await res.json()) as { keys: KeyRow[] }).keys;
  }

  it("create → 201 with nsk_-prefixed plaintext; list shows the row but NOT the secret", async () => {
    const res = await req("POST", "/setup-keys", { cookie: aliceCookie, body: { label: "mac mini" } });
    expect(res.status).toBe(201);
    const created = (await res.json()) as { id: string; key: string; expiresAt: string };
    expect(created.key.startsWith("nsk_")).toBe(true);
    expect(created.id).toBeTruthy();
    expect(Date.parse(created.expiresAt)).toBeGreaterThan(Date.now());

    const body = JSON.stringify(await listKeys(aliceCookie));
    expect(body).toContain(created.id);
    expect(body).toContain("mac mini");
    expect(body).not.toContain(created.key); // plaintext never comes back
    expect(body).not.toContain("keyHash");

    await req("DELETE", `/setup-keys/${created.id}`, { cookie: aliceCookie });
  });

  it("create with an empty label → 400 INPUT_VALIDATION_ERROR", async () => {
    // Mounted with the global error handler (as in the real server), Elysia's
    // native 422 becomes the shared 400 structured body (system-keys rhythm).
    const app = new Elysia().use(errorHandlerPlugin).use(nodesRoutes);
    const res = await app.fetch(
      new Request("http://localhost:3080/api/nodes/setup-keys", {
        method: "POST",
        headers: { cookie: `better-auth.session_token=${aliceCookie}`, "content-type": "application/json" },
        body: JSON.stringify({ label: "" }),
      }),
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe("INPUT_VALIDATION_ERROR");
  });

  it("list is owner-scoped — user B sees none of user A's keys", async () => {
    const { row } = await repo.create("alice-only", aliceId);
    const bobKeys = await listKeys(bobCookie);
    expect(bobKeys.some((k) => k.id === row.id)).toBe(false);
    const aliceKeys = await listKeys(aliceCookie);
    expect(aliceKeys.some((k) => k.id === row.id)).toBe(true);
    await repo.deleteById(row.id, aliceId);
  });

  it("delete own key → ok, gone from the list; unknown/other's id → 404", async () => {
    const { row } = await repo.create("to-delete", aliceId);
    const del = await req("DELETE", `/setup-keys/${row.id}`, { cookie: aliceCookie });
    expect(del.status).toBe(200);
    expect(((await del.json()) as { ok: boolean }).ok).toBe(true);
    expect((await listKeys(aliceCookie)).some((k) => k.id === row.id)).toBe(false);

    // Another user's row reads as not found (no existence leak, same as deleteById count 0).
    const other = await repo.create("bob-owned", aliceId);
    expect((await req("DELETE", `/setup-keys/${other.row.id}`, { cookie: bobCookie })).status).toBe(404);
    expect((await req("DELETE", "/setup-keys/does-not-exist", { cookie: aliceCookie })).status).toBe(404);
    await repo.deleteById(other.row.id, aliceId);
  });

  it("delete of a consumed key is allowed (housekeeping)", async () => {
    const { row, plaintext } = await repo.create("spent", aliceId);
    await repo.consume(plaintext, "node-x");
    const res = await req("DELETE", `/setup-keys/${row.id}`, { cookie: aliceCookie });
    expect(res.status).toBe(200);
    expect((await listKeys(aliceCookie)).some((k) => k.id === row.id)).toBe(false);
  });

  it("a subshell bearer key is refused (cookie-only) → 403 on POST, GET and DELETE", async () => {
    expect((await req("POST", "/setup-keys", { bearer: subshellKey, body: { label: "nope" } })).status).toBe(403);
    expect((await req("GET", "/setup-keys", { bearer: subshellKey })).status).toBe(403);
    // 403 before the 404 lookup — requireCookieActor gates the route first.
    expect((await req("DELETE", "/setup-keys/whatever", { bearer: subshellKey })).status).toBe(403);
  });

  it("unauthenticated → 401", async () => {
    expect((await req("GET", "/setup-keys")).status).toBe(401);
  });

  describe("the allow_node_enrollment setting", () => {
    const settings = new SettingsRepository(db);
    async function setAllowed(value: boolean | null): Promise<void> {
      if (value === null) await db.deleteFrom("settings").where("key", "=", ALLOW_NODE_ENROLLMENT_KEY).execute();
      else await settings.set(ALLOW_NODE_ENROLLMENT_KEY, value);
    }

    it("is ON when the row is absent, so an instance that never set it is unchanged", async () => {
      await setAllowed(null);
      const res = await req("POST", "/setup-keys", { cookie: bobCookie, body: { label: "default-on" } });
      expect(res.status).toBe(201);
    });

    it("refuses a non-admin when it is off, with a reason naming who can", async () => {
      await setAllowed(false);
      try {
        const res = await req("POST", "/setup-keys", { cookie: bobCookie, body: { label: "nope" } });
        expect(res.status).toBe(403);
        // Actionable rather than "Forbidden": the person cannot fix this
        // themselves, and the sentence says who can.
        expect(((await res.json()) as { message: string }).message).toContain("ask one");
      } finally {
        await setAllowed(null);
      }
    });

    it("never applies to admins", async () => {
      await setAllowed(false);
      try {
        // The same shape as an admin creating a user through POST /api/users
        // while sign-up is closed: the switch governs everyone else.
        const res = await req("POST", "/setup-keys", { cookie: adminCookie, body: { label: "admin-ok" } });
        expect(res.status).toBe(201);
      } finally {
        await setAllowed(null);
      }
    });

    it("does NOT invalidate a key already minted (operator's call)", async () => {
      await setAllowed(null);
      const minted = await req("POST", "/setup-keys", { cookie: bobCookie, body: { label: "before" } });
      expect(minted.status).toBe(201);
      const { id } = (await minted.json()) as { id: string };
      await setAllowed(false);
      try {
        // Flipping it off means "stop handing these out", not "revoke what is
        // outstanding" — the same semantics as closing registrations, which
        // signs nobody out. Revoking is deleting the key, which is its own
        // audited act; anything left expires in 24 h.
        const listed = await req("GET", "/setup-keys", { cookie: bobCookie });
        expect(((await listed.json()) as { keys: KeyRow[] }).keys.some((k) => k.id === id)).toBe(true);
      } finally {
        await setAllowed(null);
      }
    });
  });
});
