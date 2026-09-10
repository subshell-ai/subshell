import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { getHarness } from "@internal/pane-runtime";
import { hashPassword } from "better-auth/crypto";
import { Elysia } from "elysia";
import { nodesRoutes } from "@/api/nodes/index.js";
import { setupRoutes } from "@/api/setup.route.js";
import { db } from "@/db/index.js";
import { NodeSharesRepository } from "@/db/repositories/node-shares.repository.js";
import { NodesRepository } from "@/db/repositories/nodes.repository.js";
import { PluginStateRepository } from "@/db/repositories/plugin-state.repository.js";
import { SubshellsRepository } from "@/db/repositories/subshells.repository.js";
import { UsersRepository } from "@/db/repositories/users.repository.js";
import type { NodeTable } from "@/db/types/nodes.db-types.js";
import { errorHandlerPlugin } from "@/plugins/error-handler.plugin.js";
import { INVENTORY_TTL_MS, readAgentInventory } from "@/services/nodes/inventory.js";
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
 * Per-node harness state on the node view, `POST /api/nodes/:id/recheck`
 * (signed inventory + detect RPC; 409 NODE_OFFLINE / NODE_UNREACHABLE), and
 * the node-page detect kick on GET.
 *
 * Since Task 9 (spec 2026-09-10) the rows are the INSTANCE catalog crossed
 * with per-node detection: the node declares nothing and manages nothing
 * here, which is exactly what these cases now pin. Plugin installation moved
 * to `/api/plugins` (`__tests__/plugins-route.test.ts`); the per-node route,
 * its remote command bridge, and this file's fake-socket plugin cases died
 * with it.
 */

const H0 = "claude-code";
const H1 = "opencode";
const H2 = "hermes";

type HarnessEntry = {
  harnessId: string;
  installed: boolean;
  version?: string;
  reason?: "not-on-path" | "override-invalid";
  broken?: string;
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
    carol: `nh-carol-${crypto.randomUUID()}@subshell.local`,
    admin: `nh-admin-${crypto.randomUUID()}@subshell.local`,
  };
  let aliceId: string;
  let carolId: string;
  let aliceCookie = "";
  let carolCookie = "";
  let adminCookie = "";
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

  beforeAll(async () => {
    await setupAuthTables();
    aliceId = await new UsersRepository(db).createUser({
      email: emails.alice,
      passwordHash: await hashPassword(pw),
      role: "user",
    });
    carolId = await new UsersRepository(db).createUser({
      email: emails.carol,
      passwordHash: await hashPassword(pw),
      role: "user",
    });
    aliceCookie = await signIn(emails.alice, pw);
    carolCookie = await signIn(emails.carol, pw);
    // `local`'s manage gate resolves to admin, and the disable-the-row case
    // reads the host view, so the suite needs one.
    await new UsersRepository(db).createUser({
      email: emails.admin,
      passwordHash: await hashPassword(pw),
      role: "admin",
    });
    adminCookie = await signIn(emails.admin, pw);
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

  // ── agent node view: instance catalog × cached detection ─────────────────

  it("view: the rows are the INSTANCE catalog, crossed with the node's inventory", async () => {
    const id = await mkAgent({ json: [entry(H0, true, "9.9.9"), entry(H1, false)], at: freshAt() });

    const view = await getNodeView(id);
    expect(view.inventoryStale).toBe(false);

    // Detected and its binary found.
    const e0 = harnessOf(view, H0);
    expect(e0.installed).toBe(true);
    expect(e0.version).toBe("9.9.9");
    // There is no per-node `enabled` on the wire: the instance flag removes
    // rows entirely when it is off (see the disabled case below), so a second
    // field could only ever disagree with the row's existence.
    expect("enabled" in e0).toBe(false);

    // Detected absent. Two different facts, deliberately separate: the
    // instance has the plugin, and this machine's binary probe found nothing.
    const e1 = harnessOf(view, H1);
    expect(e1.installed).toBe(false);

    // In the instance catalog, never detected HERE: the row exists (the
    // instance offers the plugin) with installed=false. The node declares
    // nothing any more — the catalog is the instance's, the answer per row
    // is the node's.
    expect(harnessOf(view, H2).installed).toBe(false);
  });

  it("view: a plugin the instance does not carry is absent, not shown broken — even with an inventory row", async () => {
    // The inversion's visible half on the node page: a stale/foreign
    // detection entry cannot mint a row.
    const id = await mkAgent({ json: [entry("ghost-tool", true)], at: freshAt() });
    const view = await getNodeView(id);
    expect(view.harnesses.find((h) => h.harnessId === "ghost-tool")).toBeUndefined();
  });

  it("view: inventoryStale is true for an aged AND for a never-detected snapshot", async () => {
    const aged = await mkAgent({ json: [entry(H0, true, "1.0")], at: staleAt() });
    const v1 = await getNodeView(aged);
    expect(v1.inventoryStale).toBe(true);
    // Stale values are still REPORTED — the view is informational; only the
    // strict launch gate (harnessUsable) treats stale as not-installed.
    expect(harnessOf(v1, H0).installed).toBe(true);

    // A node that has never been detected still carries every catalog row —
    // all saying installed=false, flagged stale. The rows state what the
    // INSTANCE offers; the stale flag states that this machine has not
    // answered about its binaries yet.
    const never = await mkAgent();
    const v2 = await getNodeView(never);
    expect(v2.inventoryStale).toBe(true);
    expect(v2.harnesses.length).toBeGreaterThan(0);
    expect(v2.harnesses.every((h) => h.installed === false)).toBe(true);
  });

  // ── POST /api/nodes/:id/recheck ────────────────────────────────────────────

  /** Decode the signed claims out of one wire frame. */
  function claimsOf(frameJson: string): { jti: string; aud: string; cmd: { type: string } } {
    const { jws } = JSON.parse(frameJson) as { jws: string };
    return JSON.parse(Buffer.from(jws.split(".")[1], "base64url").toString("utf8")) as {
      jti: string;
      aud: string;
      cmd: { type: string };
    };
  }

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

  /**
   * Fire a recheck and settle its ONE in-flight command: the plane's `detect`
   * pass (spec 2026-09-10 §4; R14c deleted the `inventory`-first rung — a
   * protocol-3 agent is the only agent that can hold this socket, and it
   * speaks detect). `detectAnswer` rides the command's result data — a RAW
   * node answer, parsed by the server's driver. `ok:false` simulates the
   * node refusing the command (`unsupported`, the dispatch switch's contract
   * answer) or failing it; both are 409 now, never swallowed.
   */
  async function recheckWithAnswer(
    nodeId: string,
    detectAnswer: { ok: true; data?: unknown } | { ok: false; error: string } = {
      ok: true,
      data: { results: [], env: {} },
    },
  ): Promise<Response> {
    const sock = fakeSocket();
    attachConnection(nodeId, sock);
    try {
      const resP = req("POST", `/api/nodes/${nodeId}/recheck`, { cookie: aliceCookie });
      await waitFor(() => sock.sent.length > 0, "detect command on the wire");
      const frame = JSON.parse(sock.sent[0] as string) as { jws: string };
      const det = JSON.parse(Buffer.from(frame.jws.split(".")[1], "base64url").toString("utf8")) as {
        jti: string;
        aud: string;
        cmd: { type: string };
      };
      // Exactly ONE frame on the wire: the deleted ladder was a second
      // signed round trip, so a second frame is itself the regression.
      expect(det.cmd.type).toBe("detect");
      expect(det.aud).toBe(`node:${nodeId}`);
      expect(getLive(nodeId)).toBeDefined();
      const ev = detectAnswer.ok
        ? ({ type: "result", ref: det.jti, ok: true, data: detectAnswer.data as never } as const)
        : ({ type: "result", ref: det.jti, ok: false, error: detectAnswer.error } as const);
      expect(resolveResult(liveConn(nodeId), ev)).toBe(true);
      const res = await resP;
      expect(sock.sent).toHaveLength(1); // no `inventory` command rides along
      return res;
    } finally {
      resetNodeRegistryForTests();
    }
  }

  /* --------------------------------------------------------------- */
  /* The per-node plugin route is GONE (spec 2026-09-10 Task 9): one   */
  /* instance store, one door (`/api/plugins`), no per-node install    */
  /* command to sign, mirror, or audit. These cases pin the death.     */
  /* --------------------------------------------------------------- */

  it("install/remove on a node's plugin path no longer exists (even for its owner or an admin)", async () => {
    const id = await mkAgent();
    // 404: the route module was deleted with its remote command bridge —
    // the `plugin_install`/`plugin_uninstall` frames left the protocol at v3,
    // and the interim cast that still sent them hung 10 s per attempt on
    // every live node. The instance door is `/api/plugins`.
    const install = await req("POST", `/api/nodes/${id}/plugins`, {
      cookie: aliceCookie,
      body: { pluginId: "claude-code" },
    });
    expect(install.status).toBe(404);
    expect((await req("DELETE", `/api/nodes/${id}/plugins/claude-code`, { cookie: aliceCookie })).status).toBe(404);
    // Not even an admin reaches a per-node install any more — `local`'s old
    // path is gone too, so this is absence, not a moved gate.
    expect(
      (await req("POST", "/api/nodes/local/plugins", { cookie: adminCookie, body: { pluginId: "codex" } })).status,
    ).toBe(404);
  });

  it("a disabled instance plugin vanishes from EVERY node view; re-enabling brings the rows back", async () => {
    // The §6.1 flag is a statement about the catalog, not about a node, so
    // one write removes the row from the host and from an agent alike.
    const id = await mkAgent({ json: [entry(H0, true, "1.0")], at: freshAt() });
    try {
      await new PluginStateRepository(db).setEnabled(H0, false);
      expect((await getNodeView(id)).harnesses.find((h) => h.harnessId === H0)).toBeUndefined();
      expect((await getNodeView("local", adminCookie)).harnesses.find((h) => h.harnessId === H0)).toBeUndefined();
    } finally {
      await new PluginStateRepository(db).clear(H0);
    }
    expect((await getNodeView(id)).harnesses.find((h) => h.harnessId === H0)).toBeDefined();
  });

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

  it("recheck online: sends the signed detect command and nothing else; resolves {ok:true} on the answer", async () => {
    const id = await mkAgent();
    const res = await recheckWithAnswer(id);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("recheck online: an agent-reported failure maps to 409 NODE_UNREACHABLE", async () => {
    const id = await mkAgent();
    const res = await recheckWithAnswer(id, { ok: false, error: "detect exploded" });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { code: string; message: string };
    expect(body.code).toBe("NODE_UNREACHABLE");
    expect(body.message).toContain("detect exploded");
  });

  it("recheck online: the detect answer is stored parsed (the node's raw banner became a version)", async () => {
    // Route-level half of the behavior move, through the REAL hermes plugin:
    // the fake node answers the banner text (what `--version` really prints)
    // and only "0.16.0" reaches the cache because the driver ran THIS
    // process's parseVersion. Nothing on this path can fabricate a version.
    const id = await mkAgent();
    const banner = "Hermes Agent v0.16.0 (2026.6.5) - upstream 5e01a5db";
    const res = await recheckWithAnswer(id, {
      ok: true,
      data: { results: [{ harnessId: H2, installed: true, binaryPath: "/x/hermes", rawVersion: banner }], env: {} },
    });
    expect(res.status).toBe(200);
    const stored = (await nodes.findById(id)) as NodeTable;
    const entries = readAgentInventory(stored).entries;
    expect(entries.get(H2)?.version).toBe("0.16.0");
    expect(entries.get(H2)?.binaryPath).toBe("/x/hermes");
    expect(stored.inventoryJson).not.toContain("upstream");
  });

  it("recheck: `unsupported` maps to 409 NODE_UNREACHABLE — the pre-detect-agent swallow is gone (R14c)", async () => {
    // The retired ladder swallowed this code on the detect pass, justified by
    // "a deployed v2 agent predates the handler". Gate 2 (exact protocol
    // match, both directions) means no such agent can hold this socket, so
    // an `unsupported` answer is a genuinely broken node, not a compat state.
    const id = await mkAgent();
    const res = await recheckWithAnswer(id, { ok: false, error: "unsupported" });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("NODE_UNREACHABLE");
  });

  it("recheck: a malformed detect answer propagates as a 500 (never a silent success)", async () => {
    // The driver THROWS on an answer it cannot parse; the route's error ladder
    // is NodeRpcError → 409 and everything else → global handler. A swallowed
    // garbage answer would make {ok:true} attest a snapshot that never
    // changed.
    const id = await mkAgent();
    const res = await recheckWithAnswer(id, { ok: true, data: { results: "not rows" } });
    expect(res.status).toBe(500);
  });

  it("node page load (GET /:id) fires detect best-effort and never waits for it", async () => {
    // The §4 request arm, page side: the GET resolves on cached values while
    // the detect frame is still in flight; the answer then lands in the cache.
    const id = await mkAgent();
    const sock = fakeSocket();
    attachConnection(id, sock);
    try {
      const view = (await req("GET", `/api/nodes/${id}`, { cookie: aliceCookie })) as Response;
      expect(view.status).toBe(200);
      await waitFor(() => sock.sent.some((f) => claimsOf(f).cmd.type === "detect"), "detect frame on the wire");
      const claims = claimsOf(sock.sent.find((f) => claimsOf(f).cmd.type === "detect") as string);
      expect(
        resolveResult(liveConn(id), {
          type: "result",
          ref: claims.jti,
          ok: true,
          data: { results: [], env: {} } as never,
        }),
      ).toBe(true);
      // applyInventory runs after the settle resolves the driver's await; poll
      // (waitFor's predicate is sync) until the snapshot lands.
      let storedAt: string | null | undefined;
      for (let waited = 0; waited <= 2000; waited += 10) {
        storedAt = ((await nodes.findById(id)) as { inventoryAt: string | null } | undefined)?.inventoryAt;
        if (storedAt !== null && storedAt !== undefined) break;
        await new Promise((r) => setTimeout(r, 10));
      }
      expect(storedAt).toBeTruthy();
    } finally {
      resetNodeRegistryForTests();
    }
  });

  // ── local node: thin alias over the setup-route store ─────────────────────

  it("local view: live probe drives installed, inventoryStale is always false", async () => {
    const stub = pluginOf(H2);
    // `detect`, not `isInstalled`: the local branch resolves through `scanOne`,
    // which asks the plugin once for path-and-reason. A stub on `isInstalled`
    // is never consulted and silently probes the real machine instead.
    const origDetect = stub.detect.bind(stub);
    const origVersion = stub.getVersion.bind(stub);
    const origVersionAt = stub.versionAt.bind(stub);
    stub.detect = async () => ({ path: `/usr/bin/${H2}` });
    stub.getVersion = async () => "3.3.3";
    stub.versionAt = async () => "3.3.3";
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
      stub.versionAt = origVersionAt;
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
