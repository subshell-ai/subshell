import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { MIN_NODE_VERSION, NODE_PROTOCOL_VERSION } from "@internal/subshell-protocol";
import { hashPassword } from "better-auth/crypto";
import { Elysia } from "elysia";
import { sql } from "kysely";
import { adminStatusRoutes } from "@/api/admin-status.route.js";
import { AUTH_SECRET, PLACEHOLDER_AUTH_SECRET } from "@/constants.js";
import { db } from "@/db/index.js";
import { AuthProvidersRepository } from "@/db/repositories/auth-providers.repository.js";
import { NodesRepository } from "@/db/repositories/nodes.repository.js";
import { SubshellsRepository } from "@/db/repositories/subshells.repository.js";
import { UsersRepository } from "@/db/repositories/users.repository.js";
import { LOCAL_NODE_ID } from "@/db/types/nodes.db-types.js";
import { errorHandlerPlugin } from "@/plugins/error-handler.plugin.js";
import { issueSubshellToken } from "@/services/subshell-tokens.js";
import { SERVER_VERSION } from "@/version.js";
import { authedRequest, deleteUserByEmailOrId, setupAuthTables, signIn } from "./helpers/auth-tables.js";

/**
 * GET /api/admin/status.
 *
 * Two things this pins that nothing else can:
 *
 * 1. The gate. The payload names filesystem paths, the resolved MCP command
 *    and the instance's security posture, so it must be cookie-admin only —
 *    including the actor clause, since authGuard maps a bearer token's `user`
 *    to the subshell OWNER and an admin-owned subshell key would otherwise
 *    read the whole instance's shape.
 * 2. That NO SECRET is ever in the body. The auth secret appears as a boolean
 *    or not at all; the assertion below scans the SERIALIZED response for the
 *    actual value rather than trusting today's shape, because a field added
 *    later is exactly how that would regress.
 */
const app = new Elysia().use(errorHandlerPlugin).use(adminStatusRoutes);

function bearerRequest(path: string, key: string): Request {
  return new Request(`http://localhost:3080${path}`, { headers: { authorization: `Bearer ${key}` } });
}

describe("GET /api/admin/status", () => {
  let adminId: string;
  let nonAdminId: string;
  const adminEmail = `status-admin-${crypto.randomUUID()}@subshell.local`;
  const adminPassword = "status-admin-pass-1";
  const nonAdminEmail = `status-user-${crypto.randomUUID()}@subshell.local`;
  const nonAdminPassword = "status-user-pass-1";
  let adminCookie: string;
  let nonAdminCookie: string;
  let adminSubshellKey: string;
  // Every app-table row this suite creates. There are NO foreign keys between
  // the app tables and better-auth's (helpers/auth-tables.ts says so
  // outright), so deleting the users cascades NOTHING — and the test database
  // is shared by every suite in the same `bun test` process. An orphaned
  // `agent` node left here is a node some later instance-wide count did not
  // create, and which suite it breaks depends on file order.
  const createdSubshells: string[] = [];
  const createdNodes: string[] = [];

  beforeAll(async () => {
    await setupAuthTables();
    const users = new UsersRepository(db);
    adminId = await users.createUser({
      email: adminEmail,
      name: adminEmail,
      passwordHash: await hashPassword(adminPassword),
      role: "admin",
    });
    nonAdminId = await users.createUser({
      email: nonAdminEmail,
      name: nonAdminEmail,
      passwordHash: await hashPassword(nonAdminPassword),
      role: "user",
    });
    adminCookie = await signIn(adminEmail, adminPassword);
    nonAdminCookie = await signIn(nonAdminEmail, nonAdminPassword);

    // A subshell owned by the ADMIN — the credential whose owner is an admin
    // but which must still be refused.
    const subshellId = crypto.randomUUID();
    createdSubshells.push(subshellId);
    await new SubshellsRepository(db).create({
      id: subshellId,
      userId: adminId,
      presetId: "p",
      harnessId: "claude-code",
      name: "admin-status-test",
      workingDir: "/tmp",
      tmuxSocket: null,
    });
    adminSubshellKey = await issueSubshellToken(subshellId, adminId);
  });

  afterAll(async () => {
    const subshells = new SubshellsRepository(db);
    const nodes = new NodesRepository(db);
    for (const id of createdSubshells) await subshells.delete(id);
    for (const id of createdNodes) await nodes.deleteById(id);
    await deleteUserByEmailOrId(adminId);
    await deleteUserByEmailOrId(nonAdminId);
  });

  it("answers an admin cookie with versions derived from the real constants", async () => {
    const res = await app.fetch(authedRequest("/api/admin/status", adminCookie));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      versions: { server: string; nodeProtocol: number; minNode: string; bun: string };
      generatedAt: string;
    };
    // Shared constants, never literals — a bump must not leave this stale.
    expect(body.versions.server).toBe(SERVER_VERSION);
    expect(body.versions.nodeProtocol).toBe(NODE_PROTOCOL_VERSION);
    expect(body.versions.minNode).toBe(MIN_NODE_VERSION);
    expect(body.versions.bun).toMatch(/^\d+\.\d+\.\d+/);
    expect(Number.isNaN(Date.parse(body.generatedAt))).toBe(false);
  });

  it("reports runtime facts that are actually true of this process", async () => {
    const res = await app.fetch(authedRequest("/api/admin/status", adminCookie));
    const { runtime } = (await res.json()) as {
      runtime: { pid: number; uptimeSeconds: number; bootedAt: string; os: string; databasePath: string };
    };
    expect(runtime.pid).toBe(process.pid);
    expect(runtime.uptimeSeconds).toBeGreaterThanOrEqual(0);
    expect(["linux", "darwin"]).toContain(runtime.os);
    // bootedAt is derived from uptime, so it must land in the past.
    expect(Date.parse(runtime.bootedAt)).toBeLessThanOrEqual(Date.now());
    expect(runtime.databasePath.length).toBeGreaterThan(0);
  });

  it("counts the instance, and the counts move when a row is added", async () => {
    const before = (await (await app.fetch(authedRequest("/api/admin/status", adminCookie))).json()) as {
      inventory: { users: { total: number; admins: number }; subshells: { total: number } };
    };
    expect(before.inventory.users.total).toBeGreaterThanOrEqual(2);
    expect(before.inventory.users.admins).toBeGreaterThanOrEqual(1);

    const countedId = crypto.randomUUID();
    createdSubshells.push(countedId);
    await new SubshellsRepository(db).create({
      id: countedId,
      userId: adminId,
      presetId: "p",
      harnessId: "claude-code",
      name: "admin-status-count",
      workingDir: "/tmp",
      tmuxSocket: null,
    });
    const after = (await (await app.fetch(authedRequest("/api/admin/status", adminCookie))).json()) as {
      inventory: { subshells: { total: number } };
    };
    // A real aggregate, not a constant: the number must respond to the table.
    expect(after.inventory.subshells.total).toBe(before.inventory.subshells.total + 1);
  });

  it("names the enrolled agents the floor would refuse, and only those", async () => {
    // The refusal happens at connect, so a too-old agent simply reads as
    // offline with no other explanation anywhere in the UI. This list is the
    // explanation. `local` must never appear: it is a node row for launching,
    // but it runs no agent and so has no version to be behind.
    const nodes = new NodesRepository(db);
    const staleId = `stale-${crypto.randomUUID()}`;
    const currentId = `current-${crypto.randomUUID()}`;
    createdNodes.push(staleId, currentId);
    await nodes.create({
      id: staleId,
      ownerUserId: adminId,
      name: "stale-agent",
      kind: "agent",
      status: "offline",
      agentVersion: "0.0.1",
    });
    await nodes.create({
      id: currentId,
      ownerUserId: adminId,
      name: "current-agent",
      kind: "agent",
      status: "offline",
      agentVersion: MIN_NODE_VERSION,
    });

    const res = await app.fetch(authedRequest("/api/admin/status", adminCookie));
    const { inventory } = (await res.json()) as {
      inventory: { nodes: { needingUpdate: { id: string; agentVersion: string | null }[] } };
    };
    const ids = inventory.nodes.needingUpdate.map((n) => n.id);
    expect(ids).toContain(staleId);
    expect(ids).not.toContain(currentId);
    expect(ids).not.toContain("local");
  });

  /**
   * The control-plane host counts as online, and an agent holding no socket
   * does not.
   *
   * `online` used to be the socket registry alone, which the `local` row can
   * never appear in — it runs no agent — while `total` counted it. An instance
   * whose only node is the server therefore read "0 online · 1 enrolled"
   * forever, beside a Nodes page showing that same machine online: two
   * populations, one ratio.
   *
   * Both figures are asserted as DELTAS. The registry is process-wide state
   * this suite does not own, and the nodes table is shared by every suite in
   * this `bun test` process.
   */
  it("counts the seeded local row as online, and a socketless agent as enrolled only", async () => {
    const nodes = new NodesRepository(db);
    // `local` is seeded at BOOT, which a route test never runs. Create it only
    // when this database has none, and clean up only what this suite made.
    if (!(await nodes.findById(LOCAL_NODE_ID))) {
      createdNodes.push(LOCAL_NODE_ID);
      await nodes.create({
        id: LOCAL_NODE_ID,
        ownerUserId: adminId,
        name: "Server",
        kind: "local",
        status: "online",
      });
    }

    const readNodes = async () => {
      const res = await app.fetch(authedRequest("/api/admin/status", adminCookie));
      const body = (await res.json()) as { inventory: { nodes: { total: number; online: number } } };
      return body.inventory.nodes;
    };

    const before = await readNodes();
    expect(before.online).toBeGreaterThanOrEqual(1);

    // An ENROLLED agent with no live socket: it raises the enrolled figure and
    // must not raise the reachable one.
    const socketlessId = `socketless-${crypto.randomUUID()}`;
    createdNodes.push(socketlessId);
    await nodes.create({
      id: socketlessId,
      ownerUserId: adminId,
      name: "socketless-agent",
      kind: "agent",
      status: "offline",
    });

    const after = await readNodes();
    expect(after.total).toBe(before.total + 1);
    expect(after.online).toBe(before.online);
  });

  it("NEVER puts a secret in the body, in any field", async () => {
    const res = await app.fetch(authedRequest("/api/admin/status", adminCookie));
    const raw = await res.text();
    // Scan the SERIALIZED body: a field added later would slip past any
    // assertion written against today's shape.
    expect(raw).not.toContain(AUTH_SECRET);
    expect(raw).not.toContain(PLACEHOLDER_AUTH_SECRET);
    expect(raw.toLowerCase()).not.toContain("better_auth_secret");
    // The posture is reported as a boolean instead.
    const body = JSON.parse(raw) as { security: { usingPlaceholderSecret: boolean } };
    expect(typeof body.security.usingPlaceholderSecret).toBe("boolean");
  });

  /**
   * The posture must be the EFFECTIVE gate, not the stored column.
   *
   * This route used to answer with `settings.get("allow_registrations", true)`
   * — the raw row under an open-by-default fallback. That agreed with
   * everything else until registration became closed-by-default (an absent
   * row now means closed unless the instance has no users at all), and then
   * it did not: a plain instance that has never touched the setting refuses
   * every sign-up while this card rendered an amber "open".
   *
   * Spec 2026-09-24 §2 moved the stored answer onto the E-mail provider row,
   * where the same trap keeps its shape: the column's NULL is not "open" and
   * a hand-edited non-number is not "open" either — the gate, not the raw
   * column, is what this card must render.
   *
   * The direction was the mild one — it cried wolf rather than reassuring —
   * but this is the one card whose whole design is that the alarming state is
   * the loud one, and a card that cries wolf gets skimmed past.
   *
   * The row is saved and restored because the provider table is shared by
   * every suite in this `bun test` process, exactly like the app rows above.
   */
  it("reports the EFFECTIVE registration gate, not the raw provider column", async () => {
    const gate = new AuthProvidersRepository(db);
    const storedBefore = (await gate.getById("email"))?.registrationEnabled ?? null;
    try {
      // NULL on the row, and this suite has registered users — so the legacy
      // window is CLOSED, and a raw-truthy fallback would have said open.
      await gate.update("email", { registrationEnabled: null });
      const closed = await app.fetch(authedRequest("/api/admin/status", adminCookie));
      const closedBody = (await closed.json()) as { security: { registrationsOpen: boolean } };
      expect(closedBody.security.registrationsOpen).toBe(false);

      // And it still reports an instance that really is open, so the fix is
      // not "always false".
      await gate.update("email", { registrationEnabled: 1 });
      const open = await app.fetch(authedRequest("/api/admin/status", adminCookie));
      const openBody = (await open.json()) as { security: { registrationsOpen: boolean } };
      expect(openBody.security.registrationsOpen).toBe(true);

      // A corrupt value fails CLOSED here as it does at the gate, rather than
      // falling back to a permissive default. Raw SQL: the column's INTEGER
      // affinity stores what a hand edit gives it, and the typed patch
      // cannot express the corruption.
      await sql`UPDATE auth_providers SET registration_enabled = 'not json' WHERE id = 'email'`.execute(db);
      const corrupt = await app.fetch(authedRequest("/api/admin/status", adminCookie));
      const corruptBody = (await corrupt.json()) as { security: { registrationsOpen: boolean } };
      expect(corruptBody.security.registrationsOpen).toBe(false);
    } finally {
      await gate.update("email", { registrationEnabled: storedBefore });
    }
  });

  it("refuses a non-admin cookie with 403", async () => {
    const res = await app.fetch(authedRequest("/api/admin/status", nonAdminCookie));
    expect(res.status).toBe(403);
  });

  it("refuses an ADMIN-OWNED bearer key with 403 — machine credentials cannot read the instance", async () => {
    const res = await app.fetch(bearerRequest("/api/admin/status", adminSubshellKey));
    expect(res.status).toBe(403);
  });

  it("refuses an anonymous caller with 401, not 403", async () => {
    const res = await app.fetch(new Request("http://localhost:3080/api/admin/status"));
    expect(res.status).toBe(401);
  });
});
