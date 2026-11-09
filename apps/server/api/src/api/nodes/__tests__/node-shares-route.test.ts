import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { hashPassword } from "better-auth/crypto";
import { Elysia } from "elysia";
import { errorHandlerPlugin } from "@/api/middleware/error-handler.plugin.js";
import { nodesRoutes } from "@/api/nodes/index.js";
import { db } from "@/db/index.js";
import { NodeSharesRepository } from "@/db/repositories/node-shares.repository.js";
import { NodesRepository } from "@/db/repositories/nodes.repository.js";
import { UsersRepository } from "@/db/repositories/users.repository.js";
import { getAuth } from "@/modules/auth/auth.js";
import { authDatabase } from "@/modules/auth/database.js";
import { ensureSystemUser } from "@/modules/auth/system-user.js";
import { NodeSharesConflictError } from "@/modules/nodes/errors.js";
import { ensureLocalNode } from "@/modules/nodes/seed-local.js";
import { deleteUserByEmailOrId, setupAuthTables, signIn } from "../../../testing/api/auth-tables.js";

/** One rendered share (the subshell-shares shape mirrored for nodes). */
type ShareRow = { id: string; granteeUserId: string | null; granteeName: string; permission: string };

/**
 * `GET/PUT /api/nodes/:id/shares` — the node mirror of subshell sharing (spec
 * 2026-08-31 §2/§9). Manager-band cookie (owner or a `manage` grantee, spec
 * 2026-11-07); `local` is the seeded exception whose shares admins manage and
 * where `manage` grants are refused. A view/edit grantee never touches the
 * grant set.
 */
describe("/api/nodes/:id/shares", () => {
  const pw = "node-shares-1";
  const emails = {
    alice: `ns-alice-${crypto.randomUUID()}@subshell.local`,
    bob: `ns-bob-${crypto.randomUUID()}@subshell.local`,
    root: `ns-root-${crypto.randomUUID()}@subshell.local`,
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
      name: emails.alice,
      passwordHash: await hashPassword(pw),
      role: "user",
    });
    bobId = await new UsersRepository(db).createUser({
      email: emails.bob,
      name: emails.bob,
      passwordHash: await hashPassword(pw),
      role: "user",
    });
    await new UsersRepository(db).createUser({
      email: emails.root,
      name: emails.root,
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

  it("PUT: a manage grant round-trips on an agent node and reads back as manage (spec 2026-11-07)", async () => {
    const id = await mkNode(aliceId);
    const res = await req("PUT", `/${id}/shares`, {
      cookie: aliceCookie,
      body: { shares: [{ granteeUserId: bobId, permission: "manage" }] },
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { shares: ShareRow[] }).shares[0]?.permission).toBe("manage");
    const detail = (await (await req("GET", `/${id}`, { cookie: bobCookie })).json()) as {
      access: string;
      canManage: boolean;
      canRetire: boolean;
    };
    expect(detail.access).toBe("manage");
    // Server-derived flags, the never-re-derive rule: manage manages, and the
    // retire arm is NOT dragged along (the creep pin at the HTTP surface).
    expect(detail.canManage).toBe(true);
    expect(detail.canRetire).toBe(false);
  });

  it("PUT: a manage grantee may manage the grant set themselves, but not retire via it", async () => {
    const id = await mkNode(aliceId);
    await shares.replaceForNode(id, [{ granteeUserId: bobId, permission: "manage" }], aliceId);
    expect((await req("GET", `/${id}/shares`, { cookie: bobCookie })).status).toBe(200);
    const reShare = await req("PUT", `/${id}/shares`, {
      cookie: bobCookie,
      body: {
        shares: [
          { granteeUserId: bobId, permission: "manage" },
          { granteeUserId: aliceId, permission: "view" },
        ],
      },
    });
    expect(reShare.status).toBe(200);
    expect(((await reShare.json()) as { shares: ShareRow[] }).shares.length).toBe(2);
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

  it("local: a manage grant is refused 400 and the stored set is byte-unchanged (spec 2026-11-07)", async () => {
    // Who manages the control-plane host has always been the admins' own
    // decision; a `manage` share would hand that machine to one non-admin.
    const before = await getShares("/local", adminCookie);
    const bad = await req("PUT", "/local/shares", {
      cookie: adminCookie,
      body: { shares: [{ granteeUserId: null, permission: "manage" }] },
    });
    expect(bad.status).toBe(400);
    const after = await getShares("/local", adminCookie);
    expect(after.map((r) => `${r.granteeUserId}:${r.permission}`)).toEqual(
      before.map((r) => `${r.granteeUserId}:${r.permission}`),
    );
  });

  it("bearer keys are refused (cookie-only) → 403 before any lookup", async () => {
    const res = await req("GET", "/local/shares", { bearer: "subshell_not_a_real_key" });
    expect(res.status).toBe(401); // auth-guard rejects unknown bearer first
    expect((await req("GET", "/local/shares")).status).toBe(401);
  });

  /**
   * Security pass on merged #495 (slice C): the `nodes:share` grant's
   * description promises launch-access control ("Grant or revoke other users'
   * access to launch subshells"), and widening the shares route to `canManage`
   * would otherwise have silently enlarged it into a band-delegation door: a
   * leaked provisioning key could mint a MANAGE row for any account on its
   * system-owned fleet, and that account's session then repoints, rotates, and
   * stops those machines. Manage is a human owner's delegation; the machine
   * door keeps its advertised View/Edit ceiling.
   */
  it("a nodes:share system key may set view/edit rows on its own account's node", async () => {
    const systemUserId = await ensureSystemUser();
    const id = await mkNode(systemUserId);
    const created = (await getAuth().api.createApiKey({
      body: {
        name: "ns-share-key",
        userId: systemUserId,
        metadata: { kind: "system", permissionVersion: 1, systemPermissions: ["nodes:share"] },
      },
    })) as unknown as { id: string; key: string };
    try {
      const ok = await req("PUT", `/${id}/shares`, {
        bearer: created.key,
        body: { shares: [{ granteeUserId: bobId, permission: "view" }] },
      });
      expect(ok.status).toBe(200);
    } finally {
      authDatabase().run(`DELETE FROM apikey WHERE id = ?`, [created.id]);
      await nodes.deleteById(id);
    }
  });

  it("a nodes:share system key may NOT mint a Manage row: the band is delegated by humans", async () => {
    const systemUserId = await ensureSystemUser();
    const id = await mkNode(systemUserId);
    await shares.replaceForNode(id, [{ granteeUserId: bobId, permission: "view" }], systemUserId);
    const created = (await getAuth().api.createApiKey({
      body: {
        name: "ns-manage-key",
        userId: systemUserId,
        metadata: { kind: "system", permissionVersion: 1, systemPermissions: ["nodes:share"] },
      },
    })) as unknown as { id: string; key: string };
    try {
      const bad = await req("PUT", `/${id}/shares`, {
        bearer: created.key,
        body: { shares: [{ granteeUserId: bobId, permission: "manage" }] },
      });
      expect(bad.status).toBe(400);
      // Refusal leaves the stored set byte-unchanged, like every refusal here.
      const after = await shares.listForNode(id);
      expect(after.map((r) => `${r.granteeUserId}:${r.permission}`)).toEqual([`${bobId}:view`]);
    } finally {
      authDatabase().run(`DELETE FROM apikey WHERE id = ?`, [created.id]);
      await nodes.deleteById(id);
    }
  });

  it("replaceForNode refuses when the rows changed under the caller's read (optimistic concurrency)", async () => {
    // Security pass on merged #495 (slice A): the manage rung made shares a
    // multi-writer surface, so a revoked manager's in-flight whole-set PUT
    // could land AFTER its own revocation and re-mint the grant. The replace
    // now CASes the caller's observed row set inside its transaction.
    const id = await mkNode(aliceId);
    await shares.replaceForNode(id, [{ granteeUserId: bobId, permission: "view" }], aliceId);
    const current = await shares.listForNode(id);
    await expect(
      shares.replaceForNode(id, [{ granteeUserId: null, permission: "manage" }], aliceId, [
        "share-row-that-no-longer-exists",
      ]),
    ).rejects.toBeInstanceOf(NodeSharesConflictError);
    expect((await shares.listForNode(id)).map((r) => `${r.granteeUserId}:${r.permission}`)).toEqual([`${bobId}:view`]);
    // Matching ids apply normally.
    await shares.replaceForNode(
      id,
      [{ granteeUserId: null, permission: "manage" }],
      aliceId,
      current.map((r) => r.id),
    );
    expect((await shares.listForNode(id))[0]?.granteeUserId).toBe(null);
  });

  it("a shares conflict maps to 409 with the stored set unchanged", async () => {
    const id = await mkNode(aliceId);
    await shares.replaceForNode(id, [{ granteeUserId: bobId, permission: "view" }], aliceId);
    const proto = NodeSharesRepository.prototype as unknown as {
      replaceForNode: (this: NodeSharesRepository, ...args: never[]) => Promise<unknown>;
    };
    const original = proto.replaceForNode;
    proto.replaceForNode = async function throwConflict() {
      throw new NodeSharesConflictError();
    } as typeof original;
    try {
      const res = await req("PUT", `/${id}/shares`, {
        cookie: aliceCookie,
        body: { shares: [{ granteeUserId: null, permission: "view" }] },
      });
      expect(res.status).toBe(409);
      expect((await shares.listForNode(id)).map((r) => `${r.granteeUserId}:${r.permission}`)).toEqual([
        `${bobId}:view`,
      ]);
    } finally {
      proto.replaceForNode = original;
    }
  });
});
