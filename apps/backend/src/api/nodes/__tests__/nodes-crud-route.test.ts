import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { hashPassword } from "better-auth/crypto";
import { Elysia } from "elysia";
import { nodesRoutes } from "@/api/nodes/index.js";
import { authDatabase } from "@/auth/database.js";
import { auth } from "@/auth.js";
import { db } from "@/db/index.js";
import { NodeSharesRepository } from "@/db/repositories/node-shares.repository.js";
import { NodesRepository } from "@/db/repositories/nodes.repository.js";
import { SessionsRepository } from "@/db/repositories/sessions.repository.js";
import { UsersRepository } from "@/db/repositories/users.repository.js";
import { errorHandlerPlugin } from "@/plugins/error-handler.plugin.js";
import {
  attachConnection,
  getLive,
  type NodeSocket,
  resetNodeRegistryForTests,
} from "@/services/nodes/node-registry.js";
import { ensureLocalNode } from "@/services/nodes/seed-local.js";
import { issueSessionToken } from "@/services/session-tokens.js";
import { deleteUserByEmailOrId, setupAuthTables, signIn } from "../../__tests__/helpers/auth-tables.js";

/** One rendered node as the list/detail routes return it. */
type View = {
  id: string;
  name: string;
  kind: string;
  status: string;
  access: string;
  canManage: boolean;
  capabilities: string[];
  harnesses: { harnessId: string; enabled: boolean; installed: boolean; version?: string }[];
  shares?: unknown[];
};

/** Fake live socket recording closes (registry seam — no real ws in tests). */
function fakeSocket(): NodeSocket & { closed: { code?: number; reason?: string }[] } {
  return {
    closed: [],
    send() {
      return 0;
    },
    close(code?: number, reason?: string) {
      this.closed.push({ code, reason });
    },
  };
}

/**
 * `/api/nodes` registry CRUD (spec 2026-08-31 §9): list/detail with the
 * share-row-is-the-filter access model, rename (per-owner collision 409,
 * `local` immutable), delete (owner-only, running-session guard, force rules,
 * api-key teardown + live-socket disconnect), rotate-key (mint → flip →
 * disable, live-socket disconnect). All cookie-only in phase 1.
 */
describe("/api/nodes registry CRUD", () => {
  const pw = "nodes-crud-1";
  const emails = {
    alice: `nc-alice-${crypto.randomUUID()}@mote.local`,
    bob: `nc-bob-${crypto.randomUUID()}@mote.local`,
    carol: `nc-carol-${crypto.randomUUID()}@mote.local`,
    root: `nc-root-${crypto.randomUUID()}@mote.local`,
  };
  let aliceId: string;
  let bobId: string;
  let carolId: string;
  const app = new Elysia().use(errorHandlerPlugin).use(nodesRoutes);
  const nodes = new NodesRepository(db);
  const nodeShares = new NodeSharesRepository(db);

  let aliceCookie = "";
  let bobCookie = "";
  let carolCookie = "";
  let adminCookie = "";
  let sessionKey = "";

  const createdNodeIds: string[] = [];
  const createdApiKeyIds: string[] = [];
  const createdSessionIds: string[] = [];

  /** Enrolled-style agent node WITH a real node-kind api key bound (rotate/delete fixtures). */
  async function mkNode(ownerId: string, name: string): Promise<{ id: string; key: string; keyRowId: string }> {
    const id = crypto.randomUUID();
    await nodes.create({ id, ownerUserId: ownerId, name, kind: "agent", status: "offline" });
    createdNodeIds.push(id);
    const created = (await auth.api.createApiKey({
      body: {
        name: `node:${id}`,
        userId: ownerId,
        metadata: { kind: "node", nodeId: id },
        permissions: { nodes: ["read", "write"] },
      },
    })) as unknown as { id: string; key: string };
    createdApiKeyIds.push(created.id);
    await nodes.setApiKeyId(id, created.id);
    return { id, key: created.key, keyRowId: created.id };
  }

  async function keyIsValid(key: string): Promise<boolean> {
    const res = (await auth.api.verifyApiKey({ body: { key } })) as unknown as { valid: boolean };
    return res.valid;
  }

  function apikeyRow(id: string): { id: string; enabled: number } | null {
    return authDatabase()
      .prepare<{ id: string; enabled: number }, [string]>(`SELECT id, enabled FROM apikey WHERE id = ?`)
      .get(id);
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
    carolId = await new UsersRepository(db).createUser({
      email: emails.carol,
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
    carolCookie = await signIn(emails.carol, pw);
    adminCookie = await signIn(emails.root, pw);
    await ensureLocalNode(db);

    // A real session bearer key owned by alice — proves cookie-only enforcement.
    await new SessionsRepository(db).create({
      id: "s_ncrud",
      userId: aliceId,
      profileId: "p",
      harnessId: "claude-code",
      name: "s_ncrud",
      workingDir: "/tmp",
      tmuxSocket: null,
    });
    createdSessionIds.push("s_ncrud");
    sessionKey = await issueSessionToken("s_ncrud", aliceId);
  });

  afterAll(async () => {
    resetNodeRegistryForTests();
    await db.deleteFrom("sessions").where("id", "in", createdSessionIds).execute();
    for (const id of createdNodeIds) await nodes.deleteById(id);
    for (const kid of createdApiKeyIds) authDatabase().run("DELETE FROM apikey WHERE id = ?", [kid]);
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

  async function list(cookie: string): Promise<View[]> {
    const res = await req("GET", "", { cookie });
    expect(res.status).toBe(200);
    return ((await res.json()) as { nodes: View[] }).nodes;
  }

  // ── list + detail visibility ──────────────────────────────────────────────

  it("list: owner sees own nodes with full view shape; a foreign private node is absent", async () => {
    const mine = await mkNode(aliceId, `list-a-${crypto.randomUUID().slice(0, 8)}`);
    const theirs = await mkNode(carolId, `list-b-${crypto.randomUUID().slice(0, 8)}`);

    const aliceNodes = await list(aliceCookie);
    const seen = aliceNodes.find((n) => n.id === mine.id);
    expect(seen).toBeDefined();
    expect(seen?.access).toBe("owner");
    expect(seen?.kind).toBe("agent");
    expect(seen?.capabilities).toEqual([]);
    expect(Array.isArray(seen?.harnesses)).toBe(true);
    expect(seen?.harnesses.length).toBeGreaterThan(0);
    expect(seen?.harnesses.every((h) => typeof h.harnessId === "string" && typeof h.enabled === "boolean")).toBe(true);
    expect(aliceNodes.some((n) => n.id === theirs.id)).toBe(false);
    // The seeded local node is visible to everyone (Everyone/edit share).
    expect(aliceNodes.some((n) => n.id === "local")).toBe(true);
  });

  it("detail: owner 200 (shares present), view-grantee 200 (shares ABSENT), foreign 404, unknown 404", async () => {
    const n = await mkNode(aliceId, `det-${crypto.randomUUID().slice(0, 8)}`);
    await nodeShares.replaceForNode(n.id, [{ granteeUserId: bobId, permission: "view" }], aliceId);

    const owner = await req("GET", `/${n.id}`, { cookie: aliceCookie });
    expect(owner.status).toBe(200);
    const ownerBody = (await owner.json()) as View & { shares?: unknown[] };
    expect(ownerBody.access).toBe("owner");
    expect(Array.isArray(ownerBody.shares)).toBe(true);

    const viewer = await req("GET", `/${n.id}`, { cookie: bobCookie });
    expect(viewer.status).toBe(200);
    const viewerBody = (await viewer.json()) as Record<string, unknown>;
    expect(viewerBody.access).toBe("view");
    expect("shares" in viewerBody).toBe(false); // omitted, not null

    expect((await req("GET", `/${n.id}`, { cookie: carolCookie })).status).toBe(404);
    expect((await req("GET", "/definitely-not-a-node", { cookie: aliceCookie })).status).toBe(404);
  });

  // ── canManage (T14 review carry: the frontend cannot derive admin identity) ──

  it("canManage: owner row true; edit/view rows false (list + detail agree)", async () => {
    const n = await mkNode(aliceId, `cm-${crypto.randomUUID().slice(0, 8)}`);
    await nodeShares.replaceForNode(
      n.id,
      [
        { granteeUserId: bobId, permission: "edit" },
        { granteeUserId: carolId, permission: "view" },
      ],
      aliceId,
    );

    // Owner.
    expect((await list(aliceCookie)).find((x) => x.id === n.id)?.canManage).toBe(true);
    expect(((await (await req("GET", `/${n.id}`, { cookie: aliceCookie })).json()) as View).canManage).toBe(true);

    // edit grantee (bob) — can configure, cannot manage.
    expect((await list(bobCookie)).find((x) => x.id === n.id)?.canManage).toBe(false);
    expect(((await (await req("GET", `/${n.id}`, { cookie: bobCookie })).json()) as View).canManage).toBe(false);

    // view grantee (carol) — cannot manage.
    expect((await list(carolCookie)).find((x) => x.id === n.id)?.canManage).toBe(false);
  });

  it("canManage on `local`: true for an admin, false for a plain viewer", async () => {
    const adminView = (await list(adminCookie)).find((x) => x.id === "local");
    expect(adminView?.canManage).toBe(true);
    const aliceView = (await list(aliceCookie)).find((x) => x.id === "local");
    expect(aliceView?.canManage).toBe(false);

    // detail path agrees with list
    expect(((await (await req("GET", "/local", { cookie: adminCookie })).json()) as View).canManage).toBe(true);
    expect(((await (await req("GET", "/local", { cookie: aliceCookie })).json()) as View).canManage).toBe(false);
  });

  it("canManage: an admin on a FOREIGN agent node is false (admin boost = edit, not manage)", async () => {
    const n = await mkNode(aliceId, `cm-ad-${crypto.randomUUID().slice(0, 8)}`);
    // Detail path (the admin boost lives in the gate, not findAccessible):
    // admin sees alice's node as edit — visible, but not manageable.
    const res = await req("GET", `/${n.id}`, { cookie: adminCookie });
    expect(res.status).toBe(200);
    const seen = (await res.json()) as View;
    expect(seen.access).toBe("edit");
    expect(seen.canManage).toBe(false);
  });

  it("a session bearer key is refused on every registry route (cookie-only phase 1)", async () => {
    expect((await req("GET", "", { bearer: sessionKey })).status).toBe(403);
    expect((await req("GET", "/local", { bearer: sessionKey })).status).toBe(403);
    expect((await req("PATCH", "/local", { bearer: sessionKey, body: { name: "x" } })).status).toBe(403);
    expect((await req("DELETE", "/local", { bearer: sessionKey })).status).toBe(403);
    expect((await req("POST", "/local/rotate-key", { bearer: sessionKey })).status).toBe(403);
  });

  it("unauthenticated → 401", async () => {
    expect((await req("GET", "")).status).toBe(401);
    expect((await req("GET", "/local")).status).toBe(401);
  });

  // ── rename ────────────────────────────────────────────────────────────────

  it("rename: owner ok; per-owner collision → 409 NODE_NAME_TAKEN; view-grantee and admin 403", async () => {
    const suffix = crypto.randomUUID().slice(0, 8);
    const a = await mkNode(aliceId, `rn-a-${suffix}`);
    const b = await mkNode(aliceId, `rn-b-${suffix}`);

    const ok = await req("PATCH", `/${a.id}`, { cookie: aliceCookie, body: { name: `rn-a2-${suffix}` } });
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as View).name).toBe(`rn-a2-${suffix}`);

    const clash = await req("PATCH", `/${b.id}`, { cookie: aliceCookie, body: { name: `rn-a2-${suffix}` } });
    expect(clash.status).toBe(409);
    expect(((await clash.json()) as { code: string }).code).toBe("NODE_NAME_TAKEN");

    await nodeShares.replaceForNode(a.id, [{ granteeUserId: bobId, permission: "view" }], aliceId);
    expect((await req("PATCH", `/${a.id}`, { cookie: bobCookie, body: { name: "hijack" } })).status).toBe(403);
    // Admins hold effective edit — rename on an AGENT node is still owner-only.
    expect((await req("PATCH", `/${a.id}`, { cookie: adminCookie, body: { name: "admin-hijack" } })).status).toBe(403);
  });

  it("rename of `local` → 400 even for an admin (name immutable)", async () => {
    const res = await req("PATCH", "/local", { cookie: adminCookie, body: { name: "mine now" } });
    expect(res.status).toBe(400);
  });

  // ── delete ────────────────────────────────────────────────────────────────

  it("delete: admin (non-owner) 403, foreign invisible 404, `local` 400", async () => {
    const n = await mkNode(aliceId, `del-guard-${crypto.randomUUID().slice(0, 8)}`);
    expect((await req("DELETE", `/${n.id}`, { cookie: adminCookie })).status).toBe(403);
    expect((await req("DELETE", `/${n.id}`, { cookie: carolCookie })).status).toBe(404);
    expect((await req("DELETE", "/local", { cookie: adminCookie })).status).toBe(400);
  });

  it("delete: running sessions → 409; ?force=true while offline → 200, sessions untouched", async () => {
    const n = await mkNode(aliceId, `del-run-${crypto.randomUUID().slice(0, 8)}`);
    await new SessionsRepository(db).create({
      id: `s_${n.id}`,
      userId: aliceId,
      profileId: "p",
      harnessId: "claude-code",
      name: "on-the-node",
      workingDir: "/tmp",
      tmuxSocket: null,
      nodeId: n.id,
    });
    createdSessionIds.push(`s_${n.id}`);

    const blocked = await req("DELETE", `/${n.id}`, { cookie: aliceCookie });
    expect(blocked.status).toBe(409);
    const err = (await blocked.json()) as { code: string; message: string };
    expect(err.code).toBe("NODE_RUNNING_SESSIONS");
    expect(err.message).toContain("1");

    const forced = await req("DELETE", `/${n.id}?force=true`, { cookie: aliceCookie });
    expect(forced.status).toBe(200);
    expect(await nodes.findById(n.id)).toBeUndefined();
    // The session row rides the normal reconcile path — force delete leaves it alone.
    expect(await new SessionsRepository(db).findById(`s_${n.id}`)).toBeDefined();
  });

  it("delete: ?force=true while ONLINE → 409 with the phase-2 message", async () => {
    const n = await mkNode(aliceId, `del-online-${crypto.randomUUID().slice(0, 8)}`);
    const sock = fakeSocket();
    attachConnection(n.id, sock);
    const res = await req("DELETE", `/${n.id}?force=true`, { cookie: aliceCookie });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { message: string }).message).toMatch(/online/i);
    expect(await nodes.findById(n.id)).toBeDefined(); // nothing was deleted
    resetNodeRegistryForTests();
  });

  it("delete: owner cascade — api key deleted, live socket closed 4401 + detached, row gone", async () => {
    const n = await mkNode(aliceId, `del-happy-${crypto.randomUUID().slice(0, 8)}`);
    const sock = fakeSocket();
    attachConnection(n.id, sock);

    const res = await req("DELETE", `/${n.id}`, { cookie: aliceCookie });
    expect(res.status).toBe(200);
    expect(await nodes.findById(n.id)).toBeUndefined();
    expect(apikeyRow(n.keyRowId)).toBeNull(); // key row removed entirely
    expect(sock.closed.some((c) => c.code === 4401)).toBe(true);
    expect(getLive(n.id)).toBeUndefined();
  });

  // ── rotate ────────────────────────────────────────────────────────────────

  it("rotate: new key verifies, old key fails, apiKeyId flipped, live socket closed 4401", async () => {
    const n = await mkNode(aliceId, `rot-${crypto.randomUUID().slice(0, 8)}`);
    const sock = fakeSocket();
    attachConnection(n.id, sock);

    const res = await req("POST", `/${n.id}/rotate-key`, { cookie: aliceCookie });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { nodeKey: string; message: string };
    expect(body.nodeKey.startsWith("mote_")).toBe(true);
    expect(body.message).toMatch(/re-configur/i);

    expect(await keyIsValid(body.nodeKey)).toBe(true);
    expect(await keyIsValid(n.key)).toBe(false); // old key revoked
    const row = await nodes.findById(n.id);
    expect(row?.apiKeyId).toBeTruthy();
    expect(row?.apiKeyId).not.toBe(n.keyRowId);

    expect(sock.closed.some((c) => c.code === 4401)).toBe(true);
    expect(getLive(n.id)).toBeUndefined();
    resetNodeRegistryForTests();
  });

  it("rotate: view-grantee 403, admin on an agent node 403", async () => {
    const n = await mkNode(aliceId, `rot-gate-${crypto.randomUUID().slice(0, 8)}`);
    await nodeShares.replaceForNode(n.id, [{ granteeUserId: bobId, permission: "edit" }], aliceId);
    expect((await req("POST", `/${n.id}/rotate-key`, { cookie: bobCookie })).status).toBe(403);
    expect((await req("POST", `/${n.id}/rotate-key`, { cookie: adminCookie })).status).toBe(403);
  });

  it("rotate of `local` by admin works (old=null skipped; phase-1 local has no key)", async () => {
    const res = await req("POST", "/local/rotate-key", { cookie: adminCookie });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { nodeKey: string };
    expect(body.nodeKey.startsWith("mote_")).toBe(true);
    // Cleanup: the rotated local key is tracked so afterAll can delete it.
    const row = await nodes.findById("local");
    if (row?.apiKeyId) createdApiKeyIds.push(row.apiKeyId);
    await nodes.setApiKeyId("local", null);
  });
});
