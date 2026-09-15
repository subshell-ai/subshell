import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { hashPassword } from "better-auth/crypto";
import { Elysia } from "elysia";
import { nodesRoutes } from "@/api/nodes/index.js";
import { validateNodeServerUrl } from "@/api/nodes/set-node-server-url.route.js";
import { db } from "@/db/index.js";
import { NodeSharesRepository } from "@/db/repositories/node-shares.repository.js";
import { NodesRepository } from "@/db/repositories/nodes.repository.js";
import { UsersRepository } from "@/db/repositories/users.repository.js";
import { errorHandlerPlugin } from "@/plugins/error-handler.plugin.js";
import { resetNodeRegistryForTests } from "@/services/nodes/node-registry.js";
import { ensureLocalNode } from "@/services/nodes/seed-local.js";
import { deleteUserByEmailOrId, setupAuthTables, signIn } from "../../__tests__/helpers/auth-tables.js";

/**
 * `GET /api/nodes/:id/logs` and `PATCH /api/nodes/:id/config` — the two halves
 * of the node Service surface that are not the service manager itself (spec
 * 2026-09-12, node half § 5).
 *
 * The gates are the point here. Reading a machine's log is a configure act;
 * REPOINTING it is the owner's alone, and that split is the one thing in this
 * group that does not follow `nodeCanConfigure`.
 */

const app = new Elysia().use(errorHandlerPlugin).use(nodesRoutes);
const nodes = new NodesRepository(db);
const nodeShares = new NodeSharesRepository(db);

describe("validateNodeServerUrl", () => {
  it("accepts the spellings a person types, and canonicalizes them", () => {
    expect(validateNodeServerUrl("https://Plane.Example.com/")).toEqual({ url: "https://plane.example.com" });
    expect(validateNodeServerUrl("  https://plane.example.com:8443  ")).toEqual({
      url: "https://plane.example.com:8443",
    });
    // A plane behind a reverse-proxy subpath is a real deployment, so the path
    // survives — stripped of its trailing slash so one address has one
    // spelling.
    expect(validateNodeServerUrl("https://example.com/subshell/")).toEqual({ url: "https://example.com/subshell" });
  });

  it("refuses what a node cannot dial", () => {
    expect(validateNodeServerUrl("not a url")).toHaveProperty("error");
    expect(validateNodeServerUrl("ftp://plane.example.com")).toHaveProperty("error");
    // `URL.origin` drops credentials silently, so accepting this would store
    // an address that is not the one that was typed.
    expect(validateNodeServerUrl("https://user:pw@plane.example.com")).toHaveProperty("error");
  });

  /**
   * The enroll-time loopback trap, and worse from a browser: nobody is sitting
   * at a headless machine to notice it started dialing itself. The Nodes page
   * warns at enroll; here it has to be a refusal.
   */
  it("refuses every loopback spelling", () => {
    for (const url of ["http://localhost:3080", "http://127.0.0.1:3080", "http://[::1]:3080"]) {
      const checked = validateNodeServerUrl(url);
      expect(checked).toHaveProperty("error");
      expect("error" in checked && checked.error).toMatch(/loopback/i);
    }
  });
});

describe("/api/nodes logs + config gates", () => {
  const pw = "node-cfg-1";
  const emails = {
    alice: `nc-alice-${crypto.randomUUID()}@subshell.local`,
    carol: `nc-carol-${crypto.randomUUID()}@subshell.local`,
  };
  let aliceId = "";
  let carolId = "";
  let aliceCookie = "";
  let carolCookie = "";
  const createdNodeIds: string[] = [];

  async function mkAgent(): Promise<string> {
    const id = crypto.randomUUID();
    await nodes.create({ id, ownerUserId: aliceId, name: `nc-${id.slice(0, 8)}`, kind: "agent", status: "offline" });
    createdNodeIds.push(id);
    return id;
  }

  beforeAll(async () => {
    await setupAuthTables();
    const users = new UsersRepository(db);
    aliceId = await users.createUser({
      email: emails.alice,
      name: emails.alice,
      passwordHash: await hashPassword(pw),
      role: "user",
    });
    carolId = await users.createUser({
      email: emails.carol,
      name: emails.carol,
      passwordHash: await hashPassword(pw),
      role: "user",
    });
    aliceCookie = await signIn(emails.alice, pw);
    carolCookie = await signIn(emails.carol, pw);
    await ensureLocalNode(db);
  });

  afterAll(async () => {
    resetNodeRegistryForTests();
    for (const id of createdNodeIds) await nodes.deleteById(id);
    for (const email of Object.values(emails)) await deleteUserByEmailOrId(email);
  });

  async function req(method: string, path: string, opts: { cookie?: string; body?: unknown } = {}): Promise<Response> {
    const headers: Record<string, string> = {};
    if (opts.cookie) headers.cookie = `better-auth.session_token=${opts.cookie}`;
    if (opts.body !== undefined) headers["content-type"] = "application/json";
    return app.fetch(
      new Request(`http://localhost:3080${path}`, {
        method,
        headers,
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      }),
    );
  }

  // ── GET /:id/logs ────────────────────────────────────────────────────────

  it("logs: a view grantee is refused, an edit grantee is not", async () => {
    const id = await mkAgent();
    await nodeShares.replaceForNode(id, [{ granteeUserId: carolId, permission: "view" }], aliceId);
    expect((await req("GET", `/api/nodes/${id}/logs`, { cookie: carolCookie })).status).toBe(403);
    // An `edit` grantee gets past the gate and lands on the node being
    // offline, which is a 409 — the gate and the liveness are different
    // answers and this pins that they stay that way.
    await nodeShares.replaceForNode(id, [{ granteeUserId: carolId, permission: "edit" }], aliceId);
    expect((await req("GET", `/api/nodes/${id}/logs`, { cookie: carolCookie })).status).toBe(409);
  });

  it("logs: anonymous 401, unknown node 404, local 400", async () => {
    const id = await mkAgent();
    expect((await req("GET", `/api/nodes/${id}/logs`)).status).toBe(401);
    expect((await req("GET", `/api/nodes/nope-${crypto.randomUUID()}/logs`, { cookie: aliceCookie })).status).toBe(404);
    // The control-plane host's own log is an admin surface with its own route.
    expect((await req("GET", "/api/nodes/local/logs", { cookie: aliceCookie })).status).toBe(400);
  });

  // ── PATCH /:id/config ────────────────────────────────────────────────────

  /**
   * The one gate in this group that is NOT `nodeCanConfigure`. Repointing
   * hands a credential valid on this plane to whatever host was typed, and
   * takes the machine out of this instance — an `edit` grantee is trusted to
   * interrupt a machine, not to make it someone else's.
   */
  it("config: owner only — an edit grantee is refused", async () => {
    const id = await mkAgent();
    await nodeShares.replaceForNode(id, [{ granteeUserId: carolId, permission: "edit" }], aliceId);
    const res = await req("PATCH", `/api/nodes/${id}/config`, {
      cookie: carolCookie,
      body: { serverUrl: "https://plane.example.com" },
    });
    expect(res.status).toBe(403);
  });

  it("config: the owner gets past the gate and onto the node's liveness", async () => {
    const id = await mkAgent();
    const res = await req("PATCH", `/api/nodes/${id}/config`, {
      cookie: aliceCookie,
      body: { serverUrl: "https://plane.example.com" },
    });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe("NODE_OFFLINE");
  });

  // Validated BEFORE the node is asked anything, so an unusable address is a
  // 400 rather than a confusing 409 about a machine that is merely offline.
  it("config: an unusable address is refused before the node is dialed", async () => {
    const id = await mkAgent();
    const res = await req("PATCH", `/api/nodes/${id}/config`, {
      cookie: aliceCookie,
      body: { serverUrl: "http://localhost:3080" },
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { message: string }).message).toMatch(/loopback/i);
  });

  it("config: anonymous 401, unknown node 404, local 400", async () => {
    const id = await mkAgent();
    const body = { serverUrl: "https://plane.example.com" };
    expect((await req("PATCH", `/api/nodes/${id}/config`, { body })).status).toBe(401);
    expect(
      (await req("PATCH", `/api/nodes/nope-${crypto.randomUUID()}/config`, { cookie: aliceCookie, body })).status,
    ).toBe(404);
    expect((await req("PATCH", "/api/nodes/local/config", { cookie: aliceCookie, body })).status).toBe(400);
  });
});
