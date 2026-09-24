import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { hashPassword } from "better-auth/crypto";
import { Elysia } from "elysia";
import { sql } from "kysely";
import { usersRoutes } from "@/api/users.route.js";
import { ensureSystemUser } from "@/auth/system-user.js";
import { db } from "@/db/index.js";
import { AuthProvidersRepository } from "@/db/repositories/auth-providers.repository.js";
import { SubshellsRepository } from "@/db/repositories/subshells.repository.js";
import { UserMetaRepository } from "@/db/repositories/user-meta.repository.js";
import { UsersRepository } from "@/db/repositories/users.repository.js";
import { errorHandlerPlugin } from "@/plugins/error-handler.plugin.js";
import { issueSubshellToken } from "@/services/subshell-tokens.js";
import { deleteUserByEmailOrId, setupAuthTables, signIn } from "./helpers/auth-tables.js";

/**
 * The approval queue surfaces (spec 2026-09-24 §6/§8): `GET /api/users/pending`
 * and `PATCH /api/users/:id/approval`, plus the two roster changes that make
 * the queue safe to run — `providers` on every member row, and pending/rejected
 * rows INVISIBLE to `GET /api/users` (defense in depth behind the §6 hook
 * undo).
 *
 * Fixtures are repository-level, not flow-level: the sign-in path that CREATES
 * pending rows is Task 6's (the hooks), while this file owns the ROUTES that
 * read and clear the queue. A pending person never had a session or a socket,
 * so neither approval edge carries a sweep (§9) — which is also why nothing
 * here waits on session state.
 */
const app = new Elysia().use(errorHandlerPlugin).use(usersRoutes);

const users = new UsersRepository(db);
const meta = new UserMetaRepository(db);
const doors = new AuthProvidersRepository(db);

const pw = "pending-pass-1";
const adminEmail = `ap-admin-${crypto.randomUUID()}@subshell.local`;
const memberEmail = `ap-member-${crypto.randomUUID()}@subshell.local`;
let adminId: string;
let adminCookie: string;
let memberCookie: string;
let adminBearerKey: string;
const subshellId = `ap-sub-${crypto.randomUUID()}`;
/** Door rows created by this file; removed in afterAll. */
const providerIds: string[] = [];
/** User rows created by this file; removed in afterAll. */
const fixtureUserIds: string[] = [];

async function mkCookieUser(email: string, role: "admin" | "user"): Promise<string> {
  const id = await users.createUser({ email, name: email, passwordHash: await hashPassword(pw), role });
  fixtureUserIds.push(id);
  return id;
}

async function mkProvider(kind: "google" | "oidc", name: string): Promise<string> {
  const id = `ap-${kind}-${crypto.randomUUID().slice(0, 8)}`;
  providerIds.push(id);
  await doors.create({ id, kind, name });
  return id;
}

/**
 * Creates a queue row the shape production leaves behind: a user whose one
 * account row names its door (`providerId` re-parented, the way better-auth's
 * OAuth link writes it) and whose meta row is `pending`/`rejected` with the
 * given arrival stamp.
 */
async function mkQueueUser(
  email: string,
  providerId: string,
  state: "pending" | "rejected",
  arrivedAt: string,
): Promise<string> {
  const id = await mkCookieUser(email, "user");
  await sql`UPDATE account SET providerId = ${providerId} WHERE userId = ${id}`.execute(db);
  await meta.setApproval(id, state, { arrivedAt });
  return id;
}

async function req(
  method: string,
  path: string,
  cookie: string | null,
  body?: unknown,
  bearer?: string,
): Promise<Response> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (cookie) headers.cookie = `better-auth.session_token=${cookie}`;
  if (bearer) headers.authorization = `Bearer ${bearer}`;
  // Elysia's `fetch` is typed `MaybePromise<Response>`; the async wrapper
  // awaits it, so no cast is needed to hand callers a `Promise<Response>`.
  return app.fetch(
    new Request(`http://localhost:3080/api/users${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    }),
  );
}

interface QueueRow {
  id: string;
  email: string;
  name: string;
  providerId: string | null;
  providerName: string | null;
  arrivedAt: string | null;
  approvalState: string;
}

async function queue(): Promise<QueueRow[]> {
  const res = await req("GET", "/pending", adminCookie);
  expect(res.status).toBe(200);
  return ((await res.json()) as { pending: QueueRow[] }).pending;
}

async function roster(): Promise<{ id: string; email: string; providers: string[] }[]> {
  const res = await req("GET", "/", adminCookie);
  expect(res.status).toBe(200);
  return ((await res.json()) as { users: { id: string; email: string; providers: string[] }[] }).users;
}

describe("approval queue routes (spec §6/§8)", () => {
  let googleDoor: string;
  let pendingId: string;
  let rejectedId: string;
  let systemId: string;
  const pendingEmail = `ap-pending-${crypto.randomUUID()}@subshell.local`;
  const rejectedEmail = `ap-rejected-${crypto.randomUUID()}@subshell.local`;

  beforeAll(async () => {
    await setupAuthTables();
    adminId = await mkCookieUser(adminEmail, "admin");
    await mkCookieUser(memberEmail, "user");
    adminCookie = await signIn(adminEmail, pw);
    memberCookie = await signIn(memberEmail, pw);
    systemId = await ensureSystemUser();

    // A real subshell of the admin, so the bearer refusal below presents a
    // VALID machine credential — the same discipline as users-management:
    // a bogus key 401s before the cookie-only rule can be asserted.
    await new SubshellsRepository(db).create({
      id: subshellId,
      userId: adminId,
      presetId: "p",
      harnessId: "claude-code",
      name: "ap-token-test",
      workingDir: "/tmp",
      tmuxSocket: null,
    });
    adminBearerKey = await issueSubshellToken(subshellId, adminId);

    googleDoor = await mkProvider("google", "Acme Google");
    pendingId = await mkQueueUser(pendingEmail, googleDoor, "pending", "2026-09-20T10:00:00.000Z");
    // The rejected row lives the production lifecycle: it ARRIVED pending with
    // a stamp, then the admin rejected it — which CLEARS the stamp (leaving
    // pending NULLs it, the setApproval rule), so queue ordering puts it below
    // still-pending rows. Seeding it pre-rejected would have skipped the
    // lifecycle that produces the NULL.
    rejectedId = await mkQueueUser(rejectedEmail, googleDoor, "pending", "2026-09-24T10:00:00.000Z");
    await meta.setApproval(rejectedId, "rejected");
  });

  afterAll(async () => {
    for (const id of fixtureUserIds) {
      await db.deleteFrom("userMeta").where("userId", "=", id).execute();
      await deleteUserByEmailOrId(id);
    }
    for (const id of providerIds) await doors.remove(id);
    await db.deleteFrom("subshells").where("id", "=", subshellId).execute();
  });

  it("pending and rejected rows are invisible to the MEMBERS list", async () => {
    const users = await roster();
    expect(users.some((u) => u.email === pendingEmail)).toBe(false);
    expect(users.some((u) => u.email === rejectedEmail)).toBe(false);
    // The admin fixture (approved, credential account) IS there and carries
    // its providers — the column the users page renders (Task 13).
    expect(users.find((u) => u.email === adminEmail)?.providers).toEqual(["credential"]);
  });

  it("GET /pending answers the queue: provider id/name, arrival, state", async () => {
    const rows = await queue();
    const p = rows.find((r) => r.email === pendingEmail);
    expect(p).toBeDefined();
    expect(p?.id).toBe(pendingId);
    expect(p?.name).toBe(pendingEmail);
    expect(p?.providerId).toBe(googleDoor);
    expect(p?.providerName).toBe("Acme Google");
    expect(p?.arrivedAt).toBe("2026-09-20T10:00:00.000Z");
    expect(p?.approvalState).toBe("pending");
    const rj = rows.find((r) => r.email === rejectedEmail);
    expect(rj?.approvalState).toBe("rejected");
    // The rejected row's stamp was cleared when it left pending, and SQLite
    // sorts NULLs last on DESC — resolved rejections sink below fresh knocks.
    expect(rj?.arrivedAt).toBeNull();
    expect(rows.findIndex((r) => r.id === rejectedId)).toBeGreaterThan(rows.findIndex((r) => r.id === pendingId));
  });

  it("a removed provider renders providerName null with the id kept", async () => {
    const ghostDoor = `ap-ghost-${crypto.randomUUID().slice(0, 8)}`;
    await doors.create({ id: ghostDoor, kind: "oidc", name: "Ghost" });
    const ghostEmail = `ap-ghost-${crypto.randomUUID()}@subshell.local`;
    const ghostId = await mkQueueUser(ghostEmail, ghostDoor, "pending", "2026-09-23T10:00:00.000Z");
    await doors.remove(ghostDoor);
    try {
      const rows = await queue();
      const row = rows.find((r) => r.id === ghostId);
      expect(row?.providerId).toBe(ghostDoor);
      // The UI turns null into "removed provider" (spec §6) — the route's
      // half of that promise is the null, never a 500.
      expect(row?.providerName).toBeNull();
      // Newest-first among stamped rows: this knock (09-23) leads the older
      // pending row (09-20).
      expect(rows.findIndex((r) => r.id === ghostId)).toBeLessThan(rows.findIndex((r) => r.id === pendingId));
    } finally {
      await db.deleteFrom("userMeta").where("userId", "=", ghostId).execute();
      await deleteUserByEmailOrId(ghostId);
      fixtureUserIds.push(ghostId);
    }
  });

  it("GET /pending is cookie-admin only: member 403, anonymous 401, bearer 403", async () => {
    expect((await req("GET", "/pending", memberCookie)).status).toBe(403);
    expect((await req("GET", "/pending", null)).status).toBe(401);
    expect((await req("GET", "/pending", null, undefined, adminBearerKey)).status).toBe(403);
  });

  it("approve moves the row out of pending, clears the stamp, audits, and re-lists", async () => {
    const res = await req("PATCH", `/${pendingId}/approval`, adminCookie, { approvalState: "approved" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: pendingId, approvalState: "approved" });
    const m = await db.selectFrom("userMeta").selectAll().where("userId", "=", pendingId).executeTakeFirstOrThrow();
    expect(m.approvalState).toBe("approved");
    expect(m.pendingArrivedAt).toBeNull();
    expect((await roster()).some((u) => u.id === pendingId)).toBe(true);
    const audit = await db
      .selectFrom("auditEvents")
      .selectAll()
      .where("action", "=", "user.approve")
      .where("targetId", "=", pendingId)
      .execute();
    expect(audit).toHaveLength(1);
    expect(audit[0]?.actorUserId).toBe(adminId);
    // The user-management family names its subject by email; providerId says
    // which door they came through.
    expect(JSON.parse(String(audit[0]?.metadataJson))).toEqual({ email: pendingEmail, providerId: googleDoor });
  });

  it("reject answers 200, audits user.reject, and keeps the row off the roster", async () => {
    const lateEmail = `ap-late-${crypto.randomUUID()}@subshell.local`;
    const lateId = await mkQueueUser(lateEmail, googleDoor, "pending", "2026-09-25T10:00:00.000Z");
    const res = await req("PATCH", `/${lateId}/approval`, adminCookie, { approvalState: "rejected" });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { approvalState: string }).approvalState).toBe("rejected");
    const m = await db.selectFrom("userMeta").selectAll().where("userId", "=", lateId).executeTakeFirstOrThrow();
    expect(m.approvalState).toBe("rejected");
    // Leaving pending clears the arrival stamp on BOTH edges.
    expect(m.pendingArrivedAt).toBeNull();
    const audit = await db
      .selectFrom("auditEvents")
      .selectAll()
      .where("action", "=", "user.reject")
      .where("targetId", "=", lateId)
      .execute();
    expect(audit).toHaveLength(1);
    expect(JSON.parse(String(audit[0]?.metadataJson))).toEqual({ email: lateEmail, providerId: googleDoor });
    expect((await roster()).some((u) => u.id === lateId)).toBe(false);
  });

  it("refuses an already-approved target with the named 409, untouched and unaudited", async () => {
    // The §8 rule the route exists to enforce: APPROVAL moves rows OUT of the
    // queue, so writing onto a member is refused rather than silently
    // rewriting someone's state (and `rejected` onto an approved member is
    // barred for the same reason — disabling is that switch).
    const hammerEmail = `ap-hammer-${crypto.randomUUID()}@subshell.local`;
    const hammerId = await mkCookieUser(hammerEmail, "user");
    for (const approvalState of ["approved", "rejected"]) {
      const res = await req("PATCH", `/${hammerId}/approval`, adminCookie, { approvalState });
      expect(res.status).toBe(409);
      expect(((await res.json()) as { code: string }).code).toBe("APPROVAL_NOOP");
    }
    expect(await meta.approvalState(hammerId)).toBe("approved");
    const audits = await db
      .selectFrom("auditEvents")
      .selectAll()
      .where("targetId", "=", hammerId)
      .where("action", "in", ["user.approve", "user.reject"])
      .execute();
    expect(audits).toHaveLength(0);
  });

  it("a rejected person can be approved — rejection is reversible", async () => {
    const res = await req("PATCH", `/${rejectedId}/approval`, adminCookie, { approvalState: "approved" });
    expect(res.status).toBe(200);
    expect(await meta.approvalState(rejectedId)).toBe("approved");
  });

  it("404s an unknown id and 403s the system service account", async () => {
    expect(
      (await req("PATCH", `/${crypto.randomUUID()}/approval`, adminCookie, { approvalState: "approved" })).status,
    ).toBe(404);
    expect((await req("PATCH", `/${systemId}/approval`, adminCookie, { approvalState: "approved" })).status).toBe(403);
  });

  it("refuses a member, an anonymous caller, and a bearer key", async () => {
    expect((await req("PATCH", `/${adminId}/approval`, memberCookie, { approvalState: "rejected" })).status).toBe(403);
    expect((await req("PATCH", `/${adminId}/approval`, null, { approvalState: "rejected" })).status).toBe(401);
    const bearer = await req("PATCH", `/${adminId}/approval`, null, { approvalState: "rejected" }, adminBearerKey);
    expect(bearer.status).toBe(403);
    expect(await meta.approvalState(adminId)).toBe("approved");
  });

  it("a malformed body is a 400, never a write", async () => {
    const res = await req("PATCH", `/${adminId}/approval`, adminCookie, { approvalState: "maybe" });
    expect(res.status).toBe(400);
  });
});
