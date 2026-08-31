import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { hashPassword } from "better-auth/crypto";
import { auditRoutes } from "@/api/audit.route.js";
import { authRateLimitRoutes } from "@/api/auth-rate-limit.route.js";
import { usersRoutes } from "@/api/users.route.js";
import { authDatabase } from "@/auth/database.js";
import { ensureSystemUser } from "@/auth/system-user.js";
import { auth } from "@/auth.js";
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
    adminEmail = `admin-${crypto.randomUUID()}@mote.local`;
    nonAdminEmail = `user-${crypto.randomUUID()}@mote.local`;
    adminId = await usersRepo.createUser({
      email: adminEmail,
      passwordHash: await hashPassword(adminPassword),
      role: "admin",
    });
    const nonAdminId = await usersRepo.createUser({
      email: nonAdminEmail,
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
          email: `member-post-${crypto.randomUUID()}@mote.local`,
          password: "member-pass-123",
          role: "user",
        }),
      }),
    );
    expect(res.status).toBe(403);
  });

  it("system key bearer may read the roster but is never an admin viewer", async () => {
    const systemUserId = await ensureSystemUser();
    const created = (await auth.api.createApiKey({
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
    const email = `created-${crypto.randomUUID()}@mote.local`;
    const password = "created-pass-123";
    const res = await usersRoutes.fetch(
      authedRequest("/api/users", token, {
        method: "POST",
        body: JSON.stringify({ email, password, role: "user" }),
      }),
    );
    expect(res.status).toBe(200);
    const created = (await res.json()) as { id: string; email: string; role: string; createdAt: string };
    expect(created.id).toBeTruthy();
    expect(created.email).toBe(email);
    expect(created.role).toBe("user");

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
        body: JSON.stringify({ email, password, role: "user" }),
      }),
    );
    expect(dup.status).toBe(409);

    // Cleanup: user row (cascades account/session) + user_meta row.
    await db.deleteFrom("userMeta").where("userId", "=", created.id).execute();
    await deleteUserByEmailOrId(email);
  });

  it("audit repo records events and the admin audit endpoint lists them (403 for non-admin)", async () => {
    const auditRepo = new AuditRepository(db);
    const eventId = crypto.randomUUID();
    const now = new Date().toISOString();
    await auditRepo.create({
      id: eventId,
      actorUserId: adminId,
      action: "session.create",
      targetType: "session",
      targetId: "sess-audit-test",
      metadataJson: JSON.stringify({ name: "audit test" }),
      createdAt: now,
    });

    // Repo: newest-first listing includes the event.
    const latest = await auditRepo.listLatest(50);
    const found = latest.find((e) => e.id === eventId);
    expect(found?.action).toBe("session.create");
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
});
