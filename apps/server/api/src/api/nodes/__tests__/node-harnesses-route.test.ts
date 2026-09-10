import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { getHarness } from "@internal/pane-runtime";
import { hashPassword } from "better-auth/crypto";
import { Elysia } from "elysia";
import { nodesRoutes } from "@/api/nodes/index.js";
import { setupRoutes } from "@/api/setup.route.js";
import { db } from "@/db/index.js";
import { AuditRepository } from "@/db/repositories/audit.repository.js";
import { NodeSharesRepository } from "@/db/repositories/node-shares.repository.js";
import { NodesRepository } from "@/db/repositories/nodes.repository.js";
import { SubshellsRepository } from "@/db/repositories/subshells.repository.js";
import { UsersRepository } from "@/db/repositories/users.repository.js";
import { errorHandlerPlugin } from "@/plugins/error-handler.plugin.js";
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
 * Per-node harness state on the node view (inventory-backed for agents, live
 * probe for `local`), `POST /api/nodes/:id/recheck` (signed inventory RPC; 409
 * NODE_OFFLINE / NODE_UNREACHABLE), and `local`'s agreement with
 * `PATCH /api/setup/harnesses/:id` — one store (`harness_plugins`).
 *
 * The per-node toggle these cases were written around is GONE (spec 2026-09-09
 * §6): an agent offers what it has installed, so there is no enable state to
 * flip. Installing and removing it are here instead, sharing this file's
 * fake-socket harness.
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
    if (inv) {
      // An inventory alone offers nothing since phase 2: the node must also
      // DECLARE the plugin. These fixtures declare whatever they inventory.
      const ids = inv.json
        .map((e) => (e as { harnessId?: string }).harnessId)
        .filter((h): h is string => typeof h === "string");
      await nodes.recordPluginReport(
        id,
        ids.map((h) => ({
          id: h,
          name: h,
          type: "agent-harness",
          version: "1.0.0",
          description: "",
          capabilities: [],
        })),
      );
    }
    return id;
  }

  /** User ids that already had a profile for `harnessId` (default-seeding audit). */
  async function _usersWithProfiles(harnessId: string): Promise<Set<string>> {
    const rows = await db.selectFrom("profiles").select("userId").where("harnessId", "=", harnessId).execute();
    return new Set(rows.map((r) => r.userId));
  }

  /** Remove the Default rows the enable-path seeding created for `harnessId`. */
  async function _cleanupSeeded(harnessId: string, before: Set<string>): Promise<void> {
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

  async function _setupEnabled(harnessId: string): Promise<boolean | undefined> {
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

  it("view: the rows are what the NODE declared, crossed with its inventory", async () => {
    const id = await mkAgent({ json: [entry(H0, true, "9.9.9"), entry(H1, false)], at: freshAt() });

    const view = await getNodeView(id);
    expect(view.inventoryStale).toBe(false);

    // Declared and its binary found.
    const e0 = harnessOf(view, H0);
    expect(e0.installed).toBe(true);
    expect(e0.version).toBe("9.9.9");
    // Every row that exists is offered: the node having the plugin IS that.
    expect(e0.enabled).toBe(true);

    // Declared, binary absent. Two different facts, deliberately separate: a
    // node can have the plugin and not the program it drives.
    const e1 = harnessOf(view, H1);
    expect(e1.installed).toBe(false);
    expect(e1.enabled).toBe(true);

    // Not declared: no row at all, rather than a row saying "off".
    expect(view.harnesses.find((h) => h.harnessId === H2)).toBeUndefined();
  });

  it("view: inventoryStale is true for an aged AND for a never-reported snapshot", async () => {
    const aged = await mkAgent({ json: [entry(H0, true, "1.0")], at: staleAt() });
    const v1 = await getNodeView(aged);
    expect(v1.inventoryStale).toBe(true);
    // Stale values are still REPORTED — the view is informational; only the
    // strict launch gate (harnessUsable) treats stale as not-installed.
    expect(harnessOf(v1, H0).installed).toBe(true);

    // A node that has never reported has no rows at all. That is the honest
    // rendering: it has not been asked, which is neither "offers nothing" nor
    // "offers everything", and inventing rows would assert one of them.
    const never = await mkAgent();
    const v2 = await getNodeView(never);
    expect(v2.inventoryStale).toBe(true);
    expect(v2.harnesses).toEqual([]);
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

  /* --------------------------------------------------------------- */
  /* Plugin management (spec 2026-09-09 §6). The node OWNS its set:    */
  /* the server sends a command and mirrors the answer.                */
  /* --------------------------------------------------------------- */

  it("plugin install/uninstall on an OFFLINE node is refused, not queued", async () => {
    // Deliberately unlike allowed-dirs, which queues and replays on reconnect:
    // there the control plane owns a security control, so a node running stale
    // rules must be corrected. Here the node owns the setting, so queueing
    // would let this page show a plugin the node is not running.
    const id = await mkAgent();

    const install = await req("POST", `/api/nodes/${id}/plugins`, {
      cookie: aliceCookie,
      body: { pluginId: "claude-code" },
    });
    expect(install.status).toBe(409);
    expect(JSON.stringify(await install.json())).toMatch(/offline/i);

    const remove = await req("DELETE", `/api/nodes/${id}/plugins/claude-code`, { cookie: aliceCookie });
    expect(remove.status).toBe(409);
  });

  /** Settle one in-flight plugin command with the answer an agent would send. */
  async function pluginCommandWithAnswer(
    nodeId: string,
    fire: () => Promise<Response>,
    expectType: string,
    data: unknown,
  ): Promise<Response> {
    const sock = fakeSocket();
    attachConnection(nodeId, sock);
    try {
      const resP = fire();
      await waitFor(() => sock.sent.length > 0, `${expectType} command on the wire`);
      const frame = JSON.parse(sock.sent[0]) as { jws: string };
      const claims = JSON.parse(Buffer.from(frame.jws.split(".")[1], "base64url").toString("utf8")) as {
        jti: string;
        cmd: { type: string; id: string };
      };
      expect(claims.cmd.type).toBe(expectType);
      expect(resolveResult(liveConn(nodeId), { type: "result", ref: claims.jti, ok: true, data: data as never })).toBe(
        true,
      );
      return await resP;
    } finally {
      resetNodeRegistryForTests();
    }
  }

  /** The actions this suite's audit assertions care about, newest last. */
  async function pluginAuditFor(nodeId: string): Promise<string[]> {
    const events = await new AuditRepository(db).listLatest(200);
    return events
      .filter((e) => e.targetId === nodeId && e.action.startsWith("node.plugin."))
      .map((e) => e.action)
      .reverse();
  }

  it("an accepted install is mirrored from the node's own answer, and audited", async () => {
    // The node OWNS the set, so the row the server keeps is whatever the node
    // reported back — not what was asked for.
    const id = await mkAgent();
    const res = await pluginCommandWithAnswer(
      id,
      () => req("POST", `/api/nodes/${id}/plugins`, { cookie: aliceCookie, body: { pluginId: "claude-code" } }),
      "plugin_install",
      {
        plugins: [
          {
            id: "claude-code",
            name: "Claude Code",
            type: "agent-harness",
            version: "1.2.3",
            description: "",
            capabilities: [],
          },
        ],
      },
    );
    expect(res.status).toBe(200);
    const view = (await res.json()) as { harnesses: { harnessId: string; version?: string }[] };
    expect(view.harnesses.map((h) => h.harnessId)).toEqual(["claude-code"]);

    expect(await pluginAuditFor(id)).toEqual(["node.plugin.install"]);
  });

  it("an accepted uninstall empties the mirror, and is audited too", async () => {
    const id = await mkAgent();
    await pluginCommandWithAnswer(
      id,
      () => req("POST", `/api/nodes/${id}/plugins`, { cookie: aliceCookie, body: { pluginId: "claude-code" } }),
      "plugin_install",
      {
        plugins: [
          {
            id: "claude-code",
            name: "Claude Code",
            type: "agent-harness",
            version: "1",
            description: "",
            capabilities: [],
          },
        ],
      },
    );
    const res = await pluginCommandWithAnswer(
      id,
      () => req("DELETE", `/api/nodes/${id}/plugins/claude-code`, { cookie: aliceCookie }),
      "plugin_uninstall",
      { removed: true, plugins: [] },
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as { harnesses: unknown[] }).harnesses).toEqual([]);
    expect(await pluginAuditFor(id)).toEqual(["node.plugin.install", "node.plugin.uninstall"]);
  });

  it("writes no audit line for a change the node never heard", async () => {
    // The audit call sits AFTER the node accepts. A line for an offline
    // refusal would record an install onto a machine that was switched off.
    const id = await mkAgent();
    await req("POST", `/api/nodes/${id}/plugins`, { cookie: aliceCookie, body: { pluginId: "claude-code" } });
    expect(await pluginAuditFor(id)).toEqual([]);
  });

  it("plugin management is OWNER-only, not merely configure-capable", async () => {
    // Any node share, even `view`, already lets a grantee launch there. An
    // `edit` grantee who could install a plugin would face no restriction at
    // all, which is why this is gated like the directory allowlist.
    const id = await mkAgent();
    await nodeShares.replaceForNode(id, [{ granteeUserId: bobId, permission: "edit" }], aliceId);

    const asEdit = await req("POST", `/api/nodes/${id}/plugins`, {
      cookie: bobCookie,
      body: { pluginId: "claude-code" },
    });
    expect(asEdit.status).toBe(403);

    // And an invisible node is 404, never 403: ids must not be probeable.
    const asOutsider = await req("POST", `/api/nodes/${id}/plugins`, {
      cookie: outCookie,
      body: { pluginId: "claude-code" },
    });
    expect(asOutsider.status).toBe(404);
  });

  it("plugin management refuses machine credentials and anonymous callers", async () => {
    const id = await mkAgent();
    const anon = await req("POST", `/api/nodes/${id}/plugins`, { body: { pluginId: "claude-code" } });
    expect(anon.status).toBe(401);

    const bearer = await req("POST", `/api/nodes/${id}/plugins`, {
      bearer: subshellKey,
      body: { pluginId: "claude-code" },
    });
    expect(bearer.status).toBe(403);
  });

  it("the control-plane host is not managed through this route by a non-admin", async () => {
    // `local`'s manage gate is admin-only, so an ordinary owner never reaches
    // the command path at all. (An admin gets 400 instead: `local` has no
    // socket to send a command over, and phase 2 leaves its plugin set to the
    // seeding step rather than pretending this route can reach it.)
    const res = await req("POST", "/api/nodes/local/plugins", {
      cookie: aliceCookie,
      body: { pluginId: "claude-code" },
    });
    expect(res.status).toBe(403);
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
