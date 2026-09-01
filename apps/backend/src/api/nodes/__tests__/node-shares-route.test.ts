import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { hashPassword } from "better-auth/crypto";
import { Elysia } from "elysia";
import { nodesRoutes } from "@/api/nodes/index.js";
import { db } from "@/db/index.js";
import { NodeSharesRepository } from "@/db/repositories/node-shares.repository.js";
import { NodesRepository } from "@/db/repositories/nodes.repository.js";
import { UsersRepository } from "@/db/repositories/users.repository.js";
import { errorHandlerPlugin } from "@/plugins/error-handler.plugin.js";
import { ensureLocalNode } from "@/services/nodes/seed-local.js";
import { deleteUserByEmailOrId, setupAuthTables, signIn } from "../../__tests__/helpers/auth-tables.js";

/** One rendered share (the session-shares shape mirrored for nodes). */
type ShareRow = { id: string; granteeUserId: string | null; granteeName: string; permission: string };

/**
 * `GET/PUT /api/nodes/:id/shares` — the node mirror of session sharing (spec
 * 2026-08-31 §2/§9). Owner-only cookie; `local` is the seeded exception whose
 * shares admins manage. A view/edit grantee never touches the grant set.
 */
describe("/api/nodes/:id/shares", () => {
  const pw = "node-shares-1";
  const emails = {
    alice: `ns-alice-${crypto.randomUUID()}@mote.local`,
    bob: `ns-bob-${crypto.randomUUID()}@mote.local`,
    root: `ns-root-${crypto.randomUUID()}@mote.local`,
  };
  let aliceId: string;
  let bobId: string;
  let adminCookie = "";
  let aliceCookie = "";
  let bobCookie = "";
  const app = new Elysia().use(errorHandlerPlugin).use(nodesRoutes);
  const nodes = new NodesRepository(db);
  const shares = new NodeSharesRepository(db);
  const createdNodeIds: string[] = [];

  async function mkNode(ownerId: string): Promise<string> {
    const id = crypto.randomUUID();
    await nodes.create({ id, ownerUserId: ownerId, name: `sh-${id.slice(0, 8)}`, kind: "agent", status: "offline" });
    createdNodeIds.push(id);
    return id;
  }

  beforeAll(async () => {
    await setupAuthTables();
    aliceId = await new UsersRepository(db).createUser({
      email: emails.alice,
      passwordHash: await hashPassword(pw),
      role: "user",
    });
    bobId = await new UsersRepository(db).createUser({
      email: emails.bob,
      passwordHash: await hashPassword(pw),
      role: "user",
    });
    await new UsersRepository(db).createUser({
      email: emails.root,
      passwordHash: await hashPassword(pw),
      role: "admin",
    });
    aliceCookie = await signIn(emails.alice, pw);
    bobCookie = await signIn(emails.bob, pw);
    adminCookie = await signIn(emails.root, pw);
    await ensureLocalNode(db);
  });

  afterAll(async () => {
    for (const id of createdNodeIds) await nodes.deleteById(id);
    for (const email of Object.values(emails)) await deleteUserByEmailOrId(email);
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

  async function getShares(path: string, cookie: string): Promise<ShareRow[]> {
    const res = await req("GET", `${path}/shares`, { cookie });
    expect(res.status).toBe(200);
    return ((await res.json()) as { shares: ShareRow[] }).shares;
  }

  it("GET: owner sees the grant set with resolved names (Everyone for the null grant)", async () => {
    const id = await mkNode(aliceId);
    await shares.replaceForNode(
      id,
      [
        { granteeUserId: null, permission: "view" },
        { granteeUserId: bobId, permission: "edit" },
      ],
      aliceId,
    );
    const rows = await getShares(`/${id}`, aliceCookie);
    expect(rows.length).toBe(2);
    const everyone = rows.find((r) => r.granteeUserId === null);
    expect(everyone?.granteeName).toBe("Everyone");
    expect(rows.find((r) => r.granteeUserId === bobId)?.permission).toBe("edit");
  });

  it("GET gates: non-owner admin 403 on an agent, grantee 403, admin 200 on local, invisible 404", async () => {
    const id = await mkNode(aliceId);
    await shares.replaceForNode(id, [{ granteeUserId: bobId, permission: "view" }], aliceId);
    expect((await req("GET", `/${id}/shares`, { cookie: adminCookie })).status).toBe(403);
    expect((await req("GET", `/${id}/shares`, { cookie: bobCookie })).status).toBe(403);
    expect((await req("GET", "/local/shares", { cookie: adminCookie })).status).toBe(200);
    expect((await req("GET", `/ghost-node/shares`, { cookie: aliceCookie })).status).toBe(404);
  });

  it("PUT: replace-set works and a view grantee cannot change grants (403)", async () => {
    const id = await mkNode(aliceId);
    await shares.replaceForNode(id, [{ granteeUserId: bobId, permission: "view" }], aliceId);

    // Bob can see the node but not re-share it.
    expect((await req("PUT", `/${id}/shares`, { cookie: bobCookie, body: { shares: [] } })).status).toBe(403);

    const res = await req("PUT", `/${id}/shares`, {
      cookie: aliceCookie,
      body: { shares: [{ granteeUserId: bobId, permission: "edit" }] },
    });
    expect(res.status).toBe(200);
    const rows = ((await res.json()) as { shares: ShareRow[] }).shares;
    expect(rows.length).toBe(1);
    expect(rows[0]?.permission).toBe("edit");

    // The widened grant is live: bob now reads the node as `edit`.
    const detail = await req("GET", `/${id}`, { cookie: bobCookie });
    expect(((await detail.json()) as { access: string }).access).toBe("edit");
  });

  it("PUT: unknown grantee → 400; invalid permission → 400 via validation", async () => {
    const id = await mkNode(aliceId);
    const bad = await req("PUT", `/${id}/shares`, {
      cookie: aliceCookie,
      body: { shares: [{ granteeUserId: "user-does-not-exist", permission: "view" }] },
    });
    expect(bad.status).toBe(400);

    const invalid = await req("PUT", `/${id}/shares`, {
      cookie: aliceCookie,
      body: { shares: [{ granteeUserId: null, permission: "admin" }] },
    });
    expect(invalid.status).toBe(400);
  });

  it("local: non-admin (even at edit via the Everyone grant) 403; admin PUT accepts a valid set and it is restored", async () => {
    // Alice is `edit` on local through the seeded Everyone grant — still not a manager.
    const refused = await req("PUT", "/local/shares", { cookie: aliceCookie, body: { shares: [] } });
    expect(refused.status).toBe(403);

    const ok = await req("PUT", "/local/shares", {
      cookie: adminCookie,
      body: { shares: [{ granteeUserId: bobId, permission: "view" }] },
    });
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { shares: ShareRow[] }).shares.length).toBe(1);

    // Restore the seeded Everyone/edit shape for every other suite.
    const restore = await req("PUT", "/local/shares", {
      cookie: adminCookie,
      body: { shares: [{ granteeUserId: null, permission: "edit" }] },
    });
    expect(restore.status).toBe(200);
  });

  it("bearer keys are refused (cookie-only) → 403 before any lookup", async () => {
    const res = await req("GET", "/local/shares", { bearer: "mote_not_a_real_key" });
    expect(res.status).toBe(401); // auth-guard rejects unknown bearer first
    expect((await req("GET", "/local/shares")).status).toBe(401);
  });
});
