import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { hashPassword } from "better-auth/crypto";
import { auditRoutes } from "@/api/audit.route.js";
import { authRateLimitRoutes } from "@/api/auth-rate-limit.route.js";
import { usersRoutes } from "@/api/users.route.js";
import { authDatabase } from "@/auth/database.js";
import { ensureSystemUser } from "@/auth/system-user.js";
import { getAuth } from "@/auth.js";
import { db } from "@/db/index.js";
import { AuditRepository } from "@/db/repositories/audit.repository.js";
import { UsersRepository } from "@/db/repositories/users.repository.js";
import { authedRequest, deleteUserByEmailOrId, setupAuthTables, signIn } from "./helpers/auth-tables.js";

/**
 * Admin user-management + audit route tests against the dev singleton DB.
 *
 * Covers the roster contract end to end: GET /api/users is instance-wide and
 * returns the {viewerIsAdmin, users} envelope (management rights only for a
 * cookie-session admin), POST stays admin-cookie-only (non-admin/bearer ->
 * 403), admin creates a user -> that user can sign in, and the
 * admin-only audit endpoint lists recorded events. Fixtures are created
 * directly via the repository (deterministic roles; the runtime's
 * "first registration becomes admin" hook depends on userMeta row counts).
 */

describe("users-admin + audit routes", () => {
  let usersRepo: UsersRepository;
  let adminId: string;
  let adminEmail: string;
  const adminPassword = "admin-test-pass-123";
  let nonAdminEmail: string;
  let nonAdminIdRef: string;
  const nonAdminPassword = "user-test-pass-456";
  const createdKeyIds: string[] = [];

  beforeAll(async () => {
    await setupAuthTables();
    usersRepo = new UsersRepository(db);
    adminEmail = `admin-${crypto.randomUUID()}@subshell.local`;
    nonAdminEmail = `user-${crypto.randomUUID()}@subshell.local`;
    adminId = await usersRepo.createUser({
      email: adminEmail,
      name: adminEmail,
      passwordHash: await hashPassword(adminPassword),
      role: "admin",
    });
    const nonAdminId = await usersRepo.createUser({
      email: nonAdminEmail,
      name: nonAdminEmail,
      passwordHash: await hashPassword(nonAdminPassword),
      role: "user",
    });
    nonAdminIdRef = nonAdminId;
  });

  afterAll(async () => {
    // Remove the fixture users (user delete cascades account/session) and
    // their user_meta rows; drop audit rows written by these tests.
    await db.deleteFrom("userMeta").where("userId", "=", adminId).execute();
    await db.deleteFrom("userMeta").where("userId", "=", nonAdminIdRef).execute();
    await deleteUserByEmailOrId(adminEmail);
    await deleteUserByEmailOrId(nonAdminEmail);
    await db.deleteFrom("auditEvents").where("actorUserId", "=", adminId).execute();
    // remove the api keys minted here (raw table, plugin owns it)
    for (const kid of createdKeyIds) authDatabase().run(`DELETE FROM apikey WHERE id = ?`, [kid]);
  });

  it("users repository lists users with their roles", async () => {
    const rows = await usersRepo.listWithRoles();
    const mine = rows.filter((r) => r.email === adminEmail || r.email === nonAdminEmail);
    expect(mine).toHaveLength(2);
    const byEmail = Object.fromEntries(mine.map((r) => [r.email, r.role]));
    expect(byEmail[adminEmail]).toBe("admin");
    expect(byEmail[nonAdminEmail]).toBe("user");
  });

  it("admin can list users (GET /api/users)", async () => {
    const token = await signIn(adminEmail, adminPassword);
    const res = await usersRoutes.fetch(authedRequest("/api/users", token));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      viewerIsAdmin: boolean;
      users: Array<{ id: string; email: string; role: string | null; createdAt: string | null }>;
    };
    expect(body.viewerIsAdmin).toBe(true);
    const adminRow = body.users.find((u) => u.email === adminEmail);
    expect(adminRow?.id).toBe(adminId);
    expect(adminRow?.role).toBe("admin");
    expect(adminRow?.createdAt).toBeTruthy();
  });

  it("non-admin lists users read-only (200, viewerIsAdmin false)", async () => {
    const token = await signIn(nonAdminEmail, nonAdminPassword);
    const res = await usersRoutes.fetch(authedRequest("/api/users", token));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { viewerIsAdmin: boolean; users: unknown[] };
    expect(body.viewerIsAdmin).toBe(false);
    expect(Array.isArray(body.users)).toBe(true);
  });

  it("non-admin cannot create users (POST 403)", async () => {
    const token = await signIn(nonAdminEmail, nonAdminPassword);
    const res = await usersRoutes.fetch(
      authedRequest("/api/users", token, {
        method: "POST",
        body: JSON.stringify({
          name: "Member Post",
          email: `member-post-${crypto.randomUUID()}@subshell.local`,
          password: "member-pass-123",
          role: "user",
        }),
      }),
    );
    expect(res.status).toBe(403);
  });

  it("system key bearer may read the roster but is never an admin viewer", async () => {
    const systemUserId = await ensureSystemUser();
    const created = (await getAuth().api.createApiKey({
      body: { name: "roster-test", userId: systemUserId, metadata: { kind: "system" } },
    })) as unknown as { id: string; key: string };
    createdKeyIds.push(created.id);
    const res = await usersRoutes.fetch(
      new Request("http://localhost:3080/api/users", { headers: { authorization: `Bearer ${created.key}` } }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { viewerIsAdmin: boolean };
    expect(body.viewerIsAdmin).toBe(false);
  });

  it("admin creates a user (POST /api/users) and they can sign in", async () => {
    const token = await signIn(adminEmail, adminPassword);
    const email = `created-${crypto.randomUUID()}@subshell.local`;
    const password = "created-pass-123";
    const res = await usersRoutes.fetch(
      authedRequest("/api/users", token, {
        method: "POST",
        body: JSON.stringify({ name: "  Ada Lovelace  ", email, password, role: "user" }),
      }),
    );
    expect(res.status).toBe(200);
    const created = (await res.json()) as {
      id: string;
      email: string;
      name: string;
      role: string;
      createdAt: string;
    };
    expect(created.id).toBeTruthy();
    expect(created.email).toBe(email);
    expect(created.role).toBe("user");
    // The name is trimmed on the way in and comes back on the way out.
    expect(created.name).toBe("Ada Lovelace");

    // ...and the roster carries the same name, so the page that created the
    // account and the page that lists it agree.
    const roster = await usersRoutes.fetch(authedRequest("/api/users", token));
    const rosterBody = (await roster.json()) as { users: Array<{ email: string; name: string }> };
    expect(rosterBody.users.find((u) => u.email === email)?.name).toBe("Ada Lovelace");

    // The user_meta row carries the role and the credential account hashes the password.
    const meta = await db.selectFrom("userMeta").select("role").where("userId", "=", created.id).executeTakeFirst();
    expect(meta?.role).toBe("user");

    // Fresh credentials actually log in through the real better-auth chain.
    const login = await authRateLimitRoutes.fetch(
      new Request("http://localhost:3080/api/auth/sign-in/email", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "http://localhost:5173" },
        body: JSON.stringify({ email, password }),
      }),
    );
    expect(login.status).toBe(200);

    // Duplicate email is rejected with a conflict.
    const dup = await usersRoutes.fetch(
      authedRequest("/api/users", token, {
        method: "POST",
        body: JSON.stringify({ name: "Ada Again", email, password, role: "user" }),
      }),
    );
    expect(dup.status).toBe(409);

    // Cleanup: user row (cascades account/session) + user_meta row.
    await db.deleteFrom("userMeta").where("userId", "=", created.id).execute();
    await deleteUserByEmailOrId(email);
  });

  it("a blank name is refused (400) and the refusal never echoes the password", async () => {
    const token = await signIn(adminEmail, adminPassword);
    const email = `blank-name-${crypto.randomUUID()}@subshell.local`;
    // A password long enough to pass `assertPasswordLength`, so the ONLY thing
    // wrong with this request is the name.
    const password = "blank-name-pass-123";
    const res = await usersRoutes.fetch(
      authedRequest("/api/users", token, {
        method: "POST",
        body: JSON.stringify({ name: "   ", email, password, role: "user" }),
      }),
    );
    expect(res.status).toBe(400);
    // Checked in the handler rather than by a schema `minLength`, for the same
    // reason the password bound is: Elysia puts the offending VALUE in a schema
    // failure, and this route's contract is that a rejection quotes nothing the
    // caller typed as a credential.
    const raw = await res.text();
    expect(raw).not.toContain(password);
    expect(raw).toContain("Name is required.");

    // Nothing was written.
    const rows = await usersRepo.listWithRoles();
    expect(rows.find((r) => r.email === email)).toBeUndefined();
  });

  it("audit repo records events and the admin audit endpoint lists them (403 for non-admin)", async () => {
    const auditRepo = new AuditRepository(db);
    const eventId = crypto.randomUUID();
    const now = new Date().toISOString();
    await auditRepo.create({
      id: eventId,
      actorUserId: adminId,
      action: "subshell.create",
      targetType: "subshell",
      targetId: "sess-audit-test",
      metadataJson: JSON.stringify({ name: "audit test" }),
      createdAt: now,
    });

    // Repo: newest-first listing includes the event.
    const latest = await auditRepo.listLatest(50);
    const found = latest.find((e) => e.id === eventId);
    expect(found?.action).toBe("subshell.create");
    expect(found?.actorUserId).toBe(adminId);

    const token = await signIn(adminEmail, adminPassword);
    const res = await auditRoutes.fetch(authedRequest("/api/audit", token));
    expect(res.status).toBe(200);
    const events = (await res.json()) as Array<{ id: string; metadata: unknown }>;
    const viaApi = events.find((e) => e.id === eventId);
    expect(viaApi?.metadata).toEqual({ name: "audit test" });

    // limit is honored (a single event exists at this point).
    const limited = await auditRoutes.fetch(authedRequest("/api/audit?limit=1", token));
    expect(limited.status).toBe(200);
    const limitedBody = (await limited.json()) as unknown[];
    expect(limitedBody.length).toBe(1);

    // Non-admins are refused.
    const userToken = await signIn(nonAdminEmail, nonAdminPassword);
    const denied = await auditRoutes.fetch(authedRequest("/api/audit", userToken));
    expect(denied.status).toBe(403);

    // Cleanup the event row.
    await db.deleteFrom("auditEvents").where("id", "=", eventId).execute();
  });

  it("pages the trail by keyset cursor — no skips and no repeats while events land", async () => {
    // Keyset rather than OFFSET because the trail is append-only-DESCENDING:
    // a row written between two offset reads shifts every later page, so a
    // boundary can both skip an event and repeat one. A `(createdAt, id)`
    // cursor cannot — `(createdAt, id)` is a TOTAL order (id breaks timestamp
    // ties), and the fixtures include a deliberate tie to prove it.
    const auditRepo = new AuditRepository(db);
    const base = Date.parse("2026-09-20T12:00:00.000Z");
    const mk = (n: number, id: string, ms = 0) => ({
      id,
      actorUserId: adminId,
      action: "subshell.create",
      targetType: "subshell",
      targetId: `sess-page-${id}`,
      metadataJson: null,
      createdAt: new Date(base + n * 60_000 + ms).toISOString(),
    });
    for (const r of [mk(0, "p-0"), mk(1, "p-1"), mk(2, "p-2"), mk(3, "p-3a"), mk(3, "p-3b")]) await auditRepo.create(r);

    // Ground truth is the FULL ledger, not just the fixtures: earlier tests in
    // this file write real audit events with now-stamps, so page 1 belongs to
    // whatever is newest, and the assertions below are against that whole
    // order — which is exactly the property that matters for paging ANY trail.
    const all = await auditRepo.listLatest(500);
    const ids = all.map((e) => e.id);
    // The tie: id descending inside one timestamp, adjacent.
    expect(ids.indexOf("p-3a")).toBe(ids.indexOf("p-3b") + 1);

    const token = await signIn(adminEmail, adminPassword);
    const page = async (q: string) => {
      const res = await auditRoutes.fetch(authedRequest(`/api/audit?${q}`, token));
      expect(res.status).toBe(200);
      return (await res.json()) as Array<{ id: string; createdAt: string }>;
    };

    // Walk the whole ledger in pages of 2: every page must match the slice,
    // and the walk must end exactly where the ledger ends — no gaps, no
    // repeats, by construction.
    const collected: string[] = [];
    let cursor: { createdAt: string; id: string } | undefined;
    for (let guard = 0; ; guard++) {
      expect(guard).toBeLessThan(200);
      const q = cursor
        ? `limit=2&beforeCreatedAt=${encodeURIComponent(cursor.createdAt)}&beforeId=${cursor.id}`
        : "limit=2";
      const rows = await page(q);
      expect(rows.map((r) => r.id)).toEqual(ids.slice(collected.length, collected.length + 2));
      collected.push(...rows.map((r) => r.id));
      if (rows.length < 2) break;
      cursor = { createdAt: rows[rows.length - 1].createdAt, id: rows[rows.length - 1].id };
    }
    expect(collected).toEqual(ids);

    // THE point of keyset: a newer event landing mid-walk shifts NOTHING
    // behind the cursor. Freeze a boundary two pages in, insert a new head,
    // and re-read that page — byte-identical. OFFSET would have skipped one.
    const p2 = await page(`limit=2&beforeCreatedAt=${encodeURIComponent(all[1].createdAt)}&beforeId=${all[1].id}`);
    await auditRepo.create(mk(99, "p-late")); // newer than everything
    const p2again = await page(`limit=2&beforeCreatedAt=${encodeURIComponent(all[1].createdAt)}&beforeId=${all[1].id}`);
    expect(p2again.map((r) => r.id)).toEqual(p2.map((r) => r.id));

    // Half a cursor is not a cursor — 400, not a silent page 1.
    const broken = await auditRoutes.fetch(authedRequest(`/api/audit?beforeId=${all[0].id}`, token));
    expect(broken.status).toBe(400);

    await db.deleteFrom("auditEvents").where("targetId", "like", "sess-page-%").execute();
    await db.deleteFrom("auditEvents").where("id", "=", "p-late").execute();
  });
});
