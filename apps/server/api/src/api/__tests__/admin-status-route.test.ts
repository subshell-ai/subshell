import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { MIN_AGENT_VERSION, NODE_PROTOCOL_VERSION } from "@internal/subshell-protocol";
import { hashPassword } from "better-auth/crypto";
import { Elysia } from "elysia";
import { adminStatusRoutes } from "@/api/admin-status.route.js";
import { AUTH_SECRET, PLACEHOLDER_AUTH_SECRET } from "@/constants.js";
import { db } from "@/db/index.js";
import { NodesRepository } from "@/db/repositories/nodes.repository.js";
import { SubshellsRepository } from "@/db/repositories/subshells.repository.js";
import { UsersRepository } from "@/db/repositories/users.repository.js";
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
      versions: { server: string; nodeProtocol: number; minAgent: string; bun: string };
      generatedAt: string;
    };
    // Shared constants, never literals — a bump must not leave this stale.
    expect(body.versions.server).toBe(SERVER_VERSION);
    expect(body.versions.nodeProtocol).toBe(NODE_PROTOCOL_VERSION);
    expect(body.versions.minAgent).toBe(MIN_AGENT_VERSION);
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
      agentVersion: MIN_AGENT_VERSION,
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
