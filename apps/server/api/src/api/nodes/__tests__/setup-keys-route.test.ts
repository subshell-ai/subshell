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

/** One key row as the list route renders it (owner-scoped read). */
type KeyRow = {
  id: string;
  /** The key text itself — the card's row title since the 2026-09-17 revamp */
  key: string;
  createdAt: string;
  expiresAt: string;
  usedAt: string | null;
  consumedNodeId: string | null;
};

/** One key row as the admin `?all=1` read renders it. */
type AdminKeyRow = KeyRow & { ownerUserId: string; ownerLabel: string };

// The error handler is what maps Elysia's native validation 422 to the
// contract's 400 (and every thrown status-carrier to its structured body);
// the sibling node-route tests compose it the same way.
const app = new Elysia().use(errorHandlerPlugin).use(nodesRoutes);

/**
 * `/api/nodes/setup-keys` — single-use enrollment key management (spec
 * 2026-08-31 §5.1/§9, as the 2026-09-17 node-setup revamp changed it). Minting
 * takes NO body — a key names nothing, because the machine names itself when it
 * enrolls — and the list carries the key text, because the Setup keys card is
 * where an operator goes back to read a key they minted and have not used. What
 * is unchanged: owner-scoped list/delete, cookie-only (machine tokens 403), and
 * the key never entering the audit log.
 */
describe("/api/nodes/setup-keys", () => {
  const pw = "setup-keys-1";
  const aliceEmail = `nsk-alice-${crypto.randomUUID()}@subshell.local`;
  const bobEmail = `nsk-bob-${crypto.randomUUID()}@subshell.local`;
  let aliceId: string;
  let aliceCookie: string;
  let bobCookie: string;
  const adminEmail = `nsk-admin-${crypto.randomUUID()}@subshell.local`;
  let adminId: string;
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
    adminId = await mkUser(adminEmail, "admin");
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
    return app.fetch(
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

  it("create → 201 with an nsk_ key; the list carries the SAME text", async () => {
    const res = await req("POST", "/setup-keys", { cookie: aliceCookie });
    expect(res.status).toBe(201);
    const created = (await res.json()) as { id: string; key: string; expiresAt: string };
    expect(created.key.startsWith("nsk_")).toBe(true);
    expect(created.id).toBeTruthy();
    expect(Date.parse(created.expiresAt)).toBeGreaterThan(Date.now());

    const listed = await listKeys(aliceCookie);
    const row = listed.find((k) => k.id === created.id);
    // The card is the durable place a key is read from: closing the dialog used
    // to mean the operator could only REVOKE an unused key, never re-read it.
    expect(row?.key).toBe(created.key);

    await req("DELETE", `/setup-keys/${created.id}`, { cookie: aliceCookie });
  });

  it("a stale body is ignored — the mint names nothing, and neither does the audit row", async () => {
    // The label was the mint's only body field; a client still posting one
    // (an older bundle, a hand-written script) must not 400 and must not have
    // its string recorded anywhere. And the KEY must never reach the audit log
    // now that the row itself holds it in the clear.
    const res = await req("POST", "/setup-keys", { cookie: aliceCookie, body: { label: "mac mini" } });
    expect(res.status).toBe(201);
    const created = (await res.json()) as { id: string; key: string };
    const rows = await db
      .selectFrom("auditEvents")
      .select(["metadataJson"])
      .where("targetId", "=", created.id)
      .where("action", "=", "setup_key.create")
      .execute();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.metadataJson ?? "").not.toContain("mac mini");
    expect(rows[0]?.metadataJson ?? "").not.toContain(created.key);
    expect(JSON.stringify(await listKeys(aliceCookie))).not.toContain("mac mini");

    await req("DELETE", `/setup-keys/${created.id}`, { cookie: aliceCookie });
  });

  it("list is owner-scoped — user B sees none of user A's keys", async () => {
    const row = await repo.create(aliceId);
    const bobKeys = await listKeys(bobCookie);
    expect(bobKeys.some((k) => k.id === row.id)).toBe(false);
    const aliceKeys = await listKeys(aliceCookie);
    expect(aliceKeys.some((k) => k.id === row.id)).toBe(true);
    await repo.deleteById(row.id, aliceId);
  });

  it("delete own key → ok, gone from the list; unknown/other's id → 404", async () => {
    const row = await repo.create(aliceId);
    const del = await req("DELETE", `/setup-keys/${row.id}`, { cookie: aliceCookie });
    expect(del.status).toBe(200);
    expect(((await del.json()) as { ok: boolean }).ok).toBe(true);
    expect((await listKeys(aliceCookie)).some((k) => k.id === row.id)).toBe(false);

    // Another user's row reads as not found (no existence leak, same as deleteById count 0).
    const other = await repo.create(aliceId);
    expect((await req("DELETE", `/setup-keys/${other.id}`, { cookie: bobCookie })).status).toBe(404);
    expect((await req("DELETE", "/setup-keys/does-not-exist", { cookie: aliceCookie })).status).toBe(404);
    await repo.deleteById(other.id, aliceId);
  });

  it("delete of a consumed key is allowed (housekeeping)", async () => {
    const row = await repo.create(aliceId);
    await repo.consume(row.key, "node-x");
    const res = await req("DELETE", `/setup-keys/${row.id}`, { cookie: aliceCookie });
    expect(res.status).toBe(200);
    expect((await listKeys(aliceCookie)).some((k) => k.id === row.id)).toBe(false);
  });

  it("a subshell bearer key is refused (cookie-only) → 403 on POST, GET and DELETE", async () => {
    expect((await req("POST", "/setup-keys", { bearer: subshellKey })).status).toBe(403);
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
      const res = await req("POST", "/setup-keys", { cookie: bobCookie });
      expect(res.status).toBe(201);
    });

    it("refuses a non-admin when it is off, with a reason naming who can", async () => {
      await setAllowed(false);
      try {
        const res = await req("POST", "/setup-keys", { cookie: bobCookie });
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
        const res = await req("POST", "/setup-keys", { cookie: adminCookie });
        expect(res.status).toBe(201);
      } finally {
        await setAllowed(null);
      }
    });

    it("does NOT invalidate a key already minted (operator's call)", async () => {
      await setAllowed(null);
      const minted = await req("POST", "/setup-keys", { cookie: bobCookie });
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

  /** The `setup_key.*` audit rows for one target id, metadata included. */
  async function auditRows(targetId: string) {
    return await db
      .selectFrom("auditEvents")
      .select(["action", "actorUserId", "metadataJson"])
      .where("targetId", "=", targetId)
      .execute();
  }

  // Audit 2026-09 item 4, operator-approved: an outstanding foreign key used
  // to be a door NO admin could close before its 24 h expiry — the delete was
  // owner-filtered and the list owner-scoped. Both halves opened at once:
  // `?all=1` for a cookie admin sees every row with its creator's label, and
  // DELETE closes any row, audited `foreign: true` so the trail says whose
  // door it was.
  describe("the admin instance-wide view and foreign revoke", () => {
    it("?all=1 as an admin lists every key with its creator's label and key text", async () => {
      const foreignRow = await repo.create(aliceId);
      const ownRow = await repo.create(adminId);
      try {
        const res = await req("GET", "/setup-keys?all=1", { cookie: adminCookie });
        expect(res.status).toBe(200);
        const keys = ((await res.json()) as { keys: AdminKeyRow[] }).keys;
        const foreign = keys.find((k) => k.id === foreignRow.id);
        expect(foreign?.key).toBe(foreignRow.key);
        // The label is the creator's display name, which `mkUser` sets to the
        // email — the card needs to say WHOSE door each row is.
        expect(foreign?.ownerUserId).toBe(aliceId);
        expect(foreign?.ownerLabel).toBe(aliceEmail);
        expect(keys.some((k) => k.id === ownRow.id)).toBe(true);
        // The plain read is unchanged: admin or not, it answers own rows only,
        // and its rows carry no owner fields at all — those are the `all=1`
        // shape. (Asserting the row's EXACT keys is the same discipline the
        // anonymous-read routes hold to: a field added later is a decision.)
        const plain = await req("GET", "/setup-keys", { cookie: adminCookie });
        expect(plain.status).toBe(200);
        const plainBody = (await plain.json()) as { keys: AdminKeyRow[] };
        expect(Object.keys(plainBody)).toEqual(["keys"]);
        expect(plainBody.keys.some((k) => k.id === foreignRow.id)).toBe(false);
        if (plainBody.keys.length > 0) {
          expect(Object.keys(plainBody.keys[0]!).sort()).toEqual([
            "consumedNodeId",
            "createdAt",
            "expiresAt",
            "id",
            "key",
            "usedAt",
          ]);
        }
      } finally {
        await repo.deleteByIdUnscoped(foreignRow.id);
        await repo.deleteByIdUnscoped(ownRow.id);
      }
    });

    it("the listing read writes no audit rows (mirrors the owner-scoped read)", async () => {
      const countKeyRows = () =>
        db
          .selectFrom("auditEvents")
          .where("targetType", "=", "node-setup-key")
          .select(({ fn }) => fn.countAll<number>().as("n"))
          .executeTakeFirst();
      const before = await countKeyRows();
      const res = await req("GET", "/setup-keys?all=1", { cookie: adminCookie });
      expect(res.status).toBe(200);
      const after = await countKeyRows();
      expect(Number(after?.n)).toBe(Number(before?.n));
    });

    it("a plain user asking for all=1 gets 403, not a silently-narrowed list", async () => {
      const res = await req("GET", "/setup-keys?all=1", { cookie: bobCookie });
      expect(res.status).toBe(403);
    });

    it("a machine token is 403 before the parameter is even read", async () => {
      expect((await req("GET", "/setup-keys?all=1", { bearer: subshellKey })).status).toBe(403);
    });

    it("a non-'1' spelling of all is a validation error, not a guess", async () => {
      // The parameter is a literal: `all=yes` cannot mean "yes" AND `all=0`
      // cannot mean "no" while looking like a request for everything. The
      // error handler maps Elysia's validation failure to 400.
      expect((await req("GET", "/setup-keys?all=yes", { cookie: adminCookie })).status).toBe(400);
    });

    it("an admin revokes a FOREIGN key → 200, gone for the creator too, audited foreign with no key text", async () => {
      const foreignRow = await repo.create(aliceId);
      const res = await req("DELETE", `/setup-keys/${foreignRow.id}`, { cookie: adminCookie });
      expect(res.status).toBe(200);
      expect(await repo.findById(foreignRow.id)).toBeUndefined();
      expect((await listKeys(aliceCookie)).some((k) => k.id === foreignRow.id)).toBe(false);

      const rows = await auditRows(foreignRow.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.action).toBe("setup_key.revoke");
      expect(rows[0]?.actorUserId).toBe(adminId);
      const meta = JSON.parse(rows[0]?.metadataJson ?? "{}") as Record<string, unknown>;
      expect(meta).toEqual({ foreign: true, ownerUserId: aliceId });
      expect(rows[0]?.metadataJson ?? "").not.toContain(foreignRow.key);
    });

    it("an admin deleting their OWN key keeps the creator's audit shape (null metadata)", async () => {
      const ownRow = await repo.create(adminId);
      const res = await req("DELETE", `/setup-keys/${ownRow.id}`, { cookie: adminCookie });
      expect(res.status).toBe(200);
      const rows = await auditRows(ownRow.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.action).toBe("setup_key.revoke");
      expect(rows[0]?.metadataJson).toBeNull();
    });

    it("the creator's own revoke still audits null metadata", async () => {
      const row = await repo.create(aliceId);
      expect((await req("DELETE", `/setup-keys/${row.id}`, { cookie: aliceCookie })).status).toBe(200);
      const rows = await auditRows(row.id);
      expect(rows[0]?.metadataJson).toBeNull();
    });

    it("an admin deleting an unknown id still 404s (no probe surface for anyone)", async () => {
      expect((await req("DELETE", "/setup-keys/nope-not-real", { cookie: adminCookie })).status).toBe(404);
      const rows = await db.selectFrom("auditEvents").select("id").where("targetId", "=", "nope-not-real").execute();
      expect(rows).toHaveLength(0);
    });
  });
});
