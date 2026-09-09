import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { getHarness } from "@internal/pane-runtime";
import { hashPassword } from "better-auth/crypto";
import { Elysia } from "elysia";
import { nodesRoutes } from "@/api/nodes/index.js";
import { setupRoutes } from "@/api/setup.route.js";
import { db } from "@/db/index.js";
import { HarnessPluginsRepository } from "@/db/repositories/harness-plugins.repository.js";
import { NodeHarnessesRepository } from "@/db/repositories/node-harnesses.repository.js";
import { NodeSharesRepository } from "@/db/repositories/node-shares.repository.js";
import { NodesRepository } from "@/db/repositories/nodes.repository.js";
import { SubshellsRepository } from "@/db/repositories/subshells.repository.js";
import { UsersRepository } from "@/db/repositories/users.repository.js";
import { errorHandlerPlugin } from "@/plugins/error-handler.plugin.js";
import { DEFAULT_PROFILE_NAME } from "@/services/default-profiles.js";
import { INVENTORY_TTL_MS } from "@/services/nodes/inventory.js";
import {
  attachConnection,
  getLive,
  type NodeSocket,
  resetNodeRegistryForTests,
} from "@/services/nodes/node-registry.js";
import { resolveResult } from "@/services/nodes/node-rpc.js";
import { ensureLocalNode } from "@/services/nodes/seed-local.js";
import { issueSubshellToken } from "@/services/subshell-tokens.js";
import { deleteUserByEmailOrId, setupAuthTables, signIn } from "../../__tests__/helpers/auth-tables.js";

/**
 * Task 10 (spec 2026-08-31 §6.2): per-node harness state on the node view
 * (inventory-backed for agents, live probe for `local`), the
 * `PATCH /api/nodes/:id/harnesses/:harnessId` toggle (409 not-installed ONLY
 * on a FRESH inventory that explicitly says absent — stale and never-reported
 * snapshots are lenient), `POST /api/nodes/:id/recheck` (signed inventory RPC;
 * 409 NODE_OFFLINE / NODE_UNREACHABLE), and the local-node path agreement with
 * `PATCH /api/setup/harnesses/:id` — one store (`harness_plugins`), never a
 * `node_harnesses` row for `local`.
 */

const H0 = "claude-code";
const H1 = "opencode";
const H2 = "hermes";

type HarnessEntry = {
  harnessId: string;
  enabled: boolean;
  installed: boolean;
  version?: string;
  reason?: "not-on-path" | "override-invalid";
  checkedAt?: string;
};
type View = {
  id: string;
  kind: string;
  access: string;
  inventoryStale: boolean;
  harnesses: HarnessEntry[];
};

const app = new Elysia().use(errorHandlerPlugin).use(nodesRoutes).use(setupRoutes);
const nodes = new NodesRepository(db);
const nodeHarnesses = new NodeHarnessesRepository(db);
const nodeShares = new NodeSharesRepository(db);

/** The plugin instance (its `isInstalled` is the per-test probe seam). */
function pluginOf(id: string): NonNullable<ReturnType<typeof getHarness>> {
  const p = getHarness(id);
  if (!p) throw new Error(`built-in plugin ${id} must exist`);
  return p;
}

/** The registry connection for a node, asserted live by the caller first. */
function liveConn(nodeId: string): NonNullable<ReturnType<typeof getLive>> {
  const conn = getLive(nodeId);
  if (!conn) throw new Error(`node ${nodeId} must have a live connection`);
  return conn;
}

function freshAt(): string {
  return new Date().toISOString();
}
function staleAt(): string {
  return new Date(Date.now() - INVENTORY_TTL_MS - 60_000).toISOString();
}

function entry(harnessId: string, installed: boolean, version?: string): Record<string, unknown> {
  return version ? { harnessId, installed, version } : { harnessId, installed };
}

describe("/api/nodes harness state + recheck", () => {
  const pw = "node-harness-1";
  const emails = {
    alice: `nh-alice-${crypto.randomUUID()}@subshell.local`,
    bob: `nh-bob-${crypto.randomUUID()}@subshell.local`,
    carol: `nh-carol-${crypto.randomUUID()}@subshell.local`,
    out: `nh-out-${crypto.randomUUID()}@subshell.local`,
  };
  let aliceId: string;
  let bobId: string;
  let carolId: string;
  let outCookie = "";
  let aliceCookie = "";
  let bobCookie = "";
  let carolCookie = "";
  let subshellKey = "";

  const createdNodeIds: string[] = [];
  const createdSubshellIds: string[] = [];

  /** Agent node row optionally carrying a cached inventory snapshot. */
  async function mkAgent(inv?: { json: unknown[]; at: string | null }): Promise<string> {
    const id = crypto.randomUUID();
    await nodes.create({
      id,
      ownerUserId: aliceId,
      name: `nh-${id.slice(0, 8)}`,
      kind: "agent",
      status: "offline",
      ...(inv ? { inventoryJson: JSON.stringify(inv.json), inventoryAt: inv.at } : {}),
    });
    createdNodeIds.push(id);
    return id;
  }

  /** User ids that already had a profile for `harnessId` (default-seeding audit). */
  async function usersWithProfiles(harnessId: string): Promise<Set<string>> {
    const rows = await db.selectFrom("profiles").select("userId").where("harnessId", "=", harnessId).execute();
    return new Set(rows.map((r) => r.userId));
  }

  /** Remove the Default rows the enable-path seeding created for `harnessId`. */
  async function cleanupSeeded(harnessId: string, before: Set<string>): Promise<void> {
    const rows = await db.selectFrom("profiles").select(["id", "userId"]).where("harnessId", "=", harnessId).execute();
    const ids = rows.filter((r) => !before.has(r.userId)).map((r) => r.id);
    if (ids.length > 0) await db.deleteFrom("profiles").where("id", "in", ids).execute();
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
    aliceCookie = await signIn(emails.alice, pw);
    bobCookie = await signIn(emails.bob, pw);
    carolCookie = await signIn(emails.carol, pw);
    await new UsersRepository(db).createUser({
      email: emails.out,
      passwordHash: await hashPassword(pw),
      role: "user",
    });
    outCookie = await signIn(emails.out, pw);
    await ensureLocalNode(db);

    // A real subshell bearer key owned by alice — proves cookie-only enforcement.
    await new SubshellsRepository(db).create({
      id: "s_nh10",
      userId: aliceId,
      profileId: "p",
      harnessId: H0,
      name: "s_nh10",
      workingDir: "/tmp",
      tmuxSocket: null,
    });
    createdSubshellIds.push("s_nh10");
    subshellKey = await issueSubshellToken("s_nh10", aliceId);
  });

  afterAll(async () => {
    resetNodeRegistryForTests();
    for (const id of createdNodeIds) await nodes.deleteById(id);
    await db.deleteFrom("subshells").where("id", "in", createdSubshellIds).execute();
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
      new Request(`http://localhost:3080${path}`, {
        method,
        headers,
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      }),
    );
  }

  async function setupEnabled(harnessId: string): Promise<boolean | undefined> {
    const res = await req("GET", "/api/setup/harnesses", { cookie: aliceCookie });
    expect(res.status).toBe(200);
    const list = (await res.json()) as { id: string; enabled: boolean }[];
    return list.find((h) => h.id === harnessId)?.enabled;
  }

  async function getNodeView(nodeId: string, cookie: string = aliceCookie): Promise<View> {
    const res = await req("GET", `/api/nodes/${nodeId}`, { cookie });
    expect(res.status).toBe(200);
    return (await res.json()) as View;
  }

  function harnessOf(view: View, harnessId: string): HarnessEntry {
    const e = view.harnesses.find((h) => h.harnessId === harnessId);
    expect(e, `harness ${harnessId} present`).toBeDefined();
    return e as HarnessEntry;
  }

  // ── agent node view: inventory-backed harness states ─────────────────────

  it("view: fresh inventory drives installed/version; node_harnesses rows override enabled", async () => {
    const id = await mkAgent({ json: [entry(H0, true, "9.9.9"), entry(H1, false)], at: freshAt() });
    await nodeHarnesses.setEnabled(id, H0, false);

    const view = await getNodeView(id);
    expect(view.inventoryStale).toBe(false);
    const e0 = harnessOf(view, H0);
    expect(e0.installed).toBe(true);
    expect(e0.version).toBe("9.9.9");
    expect(e0.enabled).toBe(false); // explicit row overrides the plugin default
    const e1 = harnessOf(view, H1);
    expect(e1.installed).toBe(false);
    expect(e1.enabled).toBe(true); // absent row → plugin default
    expect(harnessOf(view, H2).installed).toBe(false); // never reported → false
  });

  it("view: inventoryStale is true for an aged AND for a never-reported snapshot", async () => {
    const aged = await mkAgent({ json: [entry(H0, true, "1.0")], at: staleAt() });
    const v1 = await getNodeView(aged);
    expect(v1.inventoryStale).toBe(true);
    // Stale values are still REPORTED — the view is informational; only the
    // strict launch gate (harnessUsable) treats stale as not-installed.
    expect(harnessOf(v1, H0).installed).toBe(true);

    const never = await mkAgent();
    const v2 = await getNodeView(never);
    expect(v2.inventoryStale).toBe(true);
    expect(harnessOf(v2, H0).installed).toBe(false);
  });

  // ── PATCH /api/nodes/:id/harnesses/:harnessId on an agent ─────────────────

  it("agent enable: fresh not-installed → 409; disable never gates; stale → 200; never-reported → 200", async () => {
    const fresh = await mkAgent({ json: [entry(H0, false)], at: freshAt() });
    const blocked = await req("PATCH", `/api/nodes/${fresh}/harnesses/${H0}`, {
      cookie: aliceCookie,
      body: { enabled: true },
    });
    expect(blocked.status).toBe(409);
    expect(((await blocked.json()) as { message: string }).message).toMatch(/not installed/i);
    // Disabling never consults the inventory (mirrors the setup route).
    expect(
      (await req("PATCH", `/api/nodes/${fresh}/harnesses/${H0}`, { cookie: aliceCookie, body: { enabled: false } }))
        .status,
    ).toBe(200);

    // Stale ≠ absent: an aged snapshot saying "not installed" does NOT block.
    const aged = await mkAgent({ json: [entry(H0, false)], at: staleAt() });
    expect(
      (await req("PATCH", `/api/nodes/${aged}/harnesses/${H0}`, { cookie: aliceCookie, body: { enabled: true } }))
        .status,
    ).toBe(200);

    // No inventory at all is also lenient (it may simply not have run yet).
    const bare = await mkAgent();
    const ok = await req("PATCH", `/api/nodes/${bare}/harnesses/${H0}`, {
      cookie: aliceCookie,
      body: { enabled: true },
    });
    expect(ok.status).toBe(200);
    const view = (await ok.json()) as View;
    expect(harnessOf(view, H0).enabled).toBe(true);
    expect(await nodeHarnesses.enabledStates(bare)).toEqual(new Map([[H0, true]]));
  });

  it("agent enable seeds Default profiles (mirrors the setup route's enable seam)", async () => {
    await db.deleteFrom("profiles").where("userId", "=", aliceId).where("harnessId", "=", H1).execute();
    const before = await usersWithProfiles(H1);
    try {
      const id = await mkAgent({ json: [entry(H1, true)], at: freshAt() });
      const res = await req("PATCH", `/api/nodes/${id}/harnesses/${H1}`, {
        cookie: aliceCookie,
        body: { enabled: true },
      });
      expect(res.status).toBe(200);
      const rows = await db
        .selectFrom("profiles")
        .select(["name", "isDefault"])
        .where("userId", "=", aliceId)
        .where("harnessId", "=", H1)
        .execute();
      expect(rows.length).toBe(1);
      expect(rows[0]?.name).toBe(DEFAULT_PROFILE_NAME);
      expect(rows[0]?.isDefault).toBe(1);
    } finally {
      await cleanupSeeded(H1, before);
    }
  });

  it("PATCH harness gates: view-grantee 403, edit-grantee 200, foreign 404", async () => {
    const id = await mkAgent({ json: [entry(H0, true)], at: freshAt() });
    await nodeShares.replaceForNode(
      id,
      [
        { granteeUserId: bobId, permission: "edit" },
        { granteeUserId: carolId, permission: "view" },
      ],
      aliceId,
    );
    expect(
      (await req("PATCH", `/api/nodes/${id}/harnesses/${H0}`, { cookie: bobCookie, body: { enabled: false } })).status,
    ).toBe(200);
    expect(
      (await req("PATCH", `/api/nodes/${id}/harnesses/${H0}`, { cookie: carolCookie, body: { enabled: true } })).status,
    ).toBe(403);
    expect(
      (await req("PATCH", `/api/nodes/${id}/harnesses/${H0}`, { cookie: outCookie, body: { enabled: true } })).status,
    ).toBe(404);
  });

  it("PATCH harness: unknown node 404, unknown harness 404, unauthenticated 401, bearer 403", async () => {
    const id = await mkAgent();
    expect(
      (
        await req("PATCH", `/api/nodes/nope-${crypto.randomUUID()}/harnesses/${H0}`, {
          cookie: aliceCookie,
          body: { enabled: true },
        })
      ).status,
    ).toBe(404);
    expect(
      (await req("PATCH", `/api/nodes/${id}/harnesses/not-a-harness`, { cookie: aliceCookie, body: { enabled: true } }))
        .status,
    ).toBe(404);
    expect((await req("PATCH", `/api/nodes/${id}/harnesses/${H0}`, { body: { enabled: true } })).status).toBe(401);
    expect(
      (await req("PATCH", `/api/nodes/${id}/harnesses/${H0}`, { bearer: subshellKey, body: { enabled: true } })).status,
    ).toBe(403);
  });

  // ── POST /api/nodes/:id/recheck ────────────────────────────────────────────

  function fakeSocket(): NodeSocket & { sent: string[] } {
    return {
      sent: [],
      send(data: string) {
        this.sent.push(data);
        return data.length;
      },
      close() {},
    };
  }

  async function waitFor(cond: () => boolean, what: string, budgetMs = 2000): Promise<void> {
    for (let waited = 0; ; waited += 5) {
      if (cond()) return;
      if (waited > budgetMs) throw new Error(`timed out waiting for ${what}`);
      await new Promise((r) => setTimeout(r, 5));
    }
  }

  /** Fire a recheck and settle its in-flight command with the given agent answer. */
  async function recheckWithAnswer(
    nodeId: string,
    answer: { ok: true } | { ok: false; error: string },
  ): Promise<Response> {
    const sock = fakeSocket();
    attachConnection(nodeId, sock);
    try {
      const resP = req("POST", `/api/nodes/${nodeId}/recheck`, { cookie: aliceCookie });
      await waitFor(() => sock.sent.length > 0, "inventory command on the wire");
      const frame = JSON.parse(sock.sent[0]) as { jws: string };
      const claims = JSON.parse(Buffer.from(frame.jws.split(".")[1], "base64url").toString("utf8")) as {
        jti: string;
        aud: string;
        cmd: { type: string };
      };
      expect(claims.cmd.type).toBe("inventory");
      expect(claims.aud).toBe(`node:${nodeId}`);
      const conn = getLive(nodeId);
      expect(conn).toBeDefined();
      const ev = answer.ok
        ? ({ type: "result", ref: claims.jti, ok: true } as const)
        : ({ type: "result", ref: claims.jti, ok: false, error: answer.error } as const);
      expect(resolveResult(liveConn(nodeId), ev)).toBe(true);
      return await resP;
    } finally {
      resetNodeRegistryForTests();
    }
  }

  it("recheck offline → 409 NODE_OFFLINE", async () => {
    const id = await mkAgent();
    const res = await req("POST", `/api/nodes/${id}/recheck`, { cookie: aliceCookie });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe("NODE_OFFLINE");
  });

  it("recheck: view-grantee 403, local 400 (live probe needs no refresh), unknown 404, bearer 403, anon 401", async () => {
    const id = await mkAgent();
    await nodeShares.replaceForNode(id, [{ granteeUserId: carolId, permission: "view" }], aliceId);
    expect((await req("POST", `/api/nodes/${id}/recheck`, { cookie: carolCookie })).status).toBe(403);
    expect((await req("POST", `/api/nodes/local/recheck`, { cookie: aliceCookie })).status).toBe(400);
    expect((await req("POST", `/api/nodes/nope-${crypto.randomUUID()}/recheck`, { cookie: aliceCookie })).status).toBe(
      404,
    );
    expect((await req("POST", `/api/nodes/${id}/recheck`, { bearer: subshellKey })).status).toBe(403);
    expect((await req("POST", `/api/nodes/${id}/recheck`)).status).toBe(401);
  });

  it("recheck online: sends the signed inventory command; resolves {ok:true} on the agent's answer", async () => {
    const id = await mkAgent();
    const res = await recheckWithAnswer(id, { ok: true });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("recheck online: an agent-reported failure maps to 409 NODE_UNREACHABLE", async () => {
    const id = await mkAgent();
    const res = await recheckWithAnswer(id, { ok: false, error: "scan failed" });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { code: string; message: string };
    expect(body.code).toBe("NODE_UNREACHABLE");
    expect(body.message).toContain("scan failed");
  });

  // ── local node: thin alias over the setup-route store ─────────────────────

  it("local PATCH ↔ setup PATCH agree on ONE store (harness_plugins; never node_harnesses)", async () => {
    const prior = (await new HarnessPluginsRepository(db).getEnabledStates([H0])).get(H0);
    const before = await usersWithProfiles(H0);
    const stub = pluginOf(H0);
    const origInstalled = stub.isInstalled.bind(stub);
    stub.isInstalled = async () => true; // enable re-probes — this machine may lack the binary
    try {
      // 1) disable via the NODE route (carol: Everyone/edit on `local` — any
      //    cookie user, matching today's setup-route semantics) → setup GET sees it
      expect(
        (await req("PATCH", `/api/nodes/local/harnesses/${H0}`, { cookie: carolCookie, body: { enabled: false } }))
          .status,
      ).toBe(200);
      expect(await setupEnabled(H0)).toBe(false);
      expect(harnessOf(await getNodeView("local"), H0).enabled).toBe(false);

      // 2) enable via the SETUP route → the node view sees it
      expect(
        (await req("PATCH", `/api/setup/harnesses/${H0}`, { cookie: aliceCookie, body: { enabled: true } })).status,
      ).toBe(200);
      expect(harnessOf(await getNodeView("local"), H0).enabled).toBe(true);

      // 3) enable via the NODE route → setup GET sees it (idempotent re-enable)
      expect(
        (await req("PATCH", `/api/nodes/local/harnesses/${H0}`, { cookie: bobCookie, body: { enabled: true } })).status,
      ).toBe(200);
      expect(await setupEnabled(H0)).toBe(true);

      // ONE store: the node route wrote harness_plugins, NOT a node_harnesses row.
      expect((await nodeHarnesses.enabledStates("local")).size).toBe(0);
    } finally {
      stub.isInstalled = origInstalled;
      if (prior === undefined) await db.deleteFrom("harnessPlugins").where("id", "=", H0).execute();
      else await new HarnessPluginsRepository(db).setEnabled(H0, prior);
      await cleanupSeeded(H0, before);
    }
  });

  it("local view: live probe drives installed, inventoryStale is always false", async () => {
    const stub = pluginOf(H2);
    // `detect`, not `isInstalled`: the local branch resolves through `scanOne`,
    // which asks the plugin once for path-and-reason. A stub on `isInstalled`
    // is never consulted and silently probes the real machine instead.
    const origDetect = stub.detect.bind(stub);
    const origVersion = stub.getVersion.bind(stub);
    stub.detect = async () => ({ path: `/usr/bin/${H2}` });
    stub.getVersion = async () => "3.3.3";
    try {
      const view = await getNodeView("local");
      expect(view.inventoryStale).toBe(false);
      const row = harnessOf(view, H2);
      expect(row.installed).toBe(true);
      expect(row.version).toBe("3.3.3");
      expect(typeof row.checkedAt).toBe("string");
      expect(row.reason).toBeUndefined();
    } finally {
      stub.detect = origDetect;
      stub.getVersion = origVersion;
    }
  });

  it("local view: a not-found harness says which kind of not-found", async () => {
    const stub = pluginOf(H2);
    const origDetect = stub.detect.bind(stub);
    stub.detect = async () => ({ path: null, reason: "override-invalid" as const });
    try {
      const row = harnessOf(await getNodeView("local"), H2);
      expect(row.installed).toBe(false);
      expect(row.reason).toBe("override-invalid");
    } finally {
      stub.detect = origDetect;
    }
  });
});
