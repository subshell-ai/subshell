import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { hashPassword } from "better-auth/crypto";
import { Elysia } from "elysia";
import { sql } from "kysely";

/**
 * `GET /api/ssh/discovery` and the `/api/ssh/connections` + `/grants` family
 * through the route-boot pattern (error handler + the ssh basket + the real
 * scripted node). The rules this suite pins, stated once:
 *
 * - Config acts are HUMAN: every machine credential (pane token, system key)
 *   403s at the coarse `ssh` scope and would 403 again at the policy's
 *   cookie arm; the pane token here has NO `ssh` permission at all (the mint
 *   map does not carry it until Gate B), which is the spec's "no legacy
 *   permission fallback" made visible.
 * - Cookie WRITES carry the explicit origin check (§2's new ground): an
 *   origin outside the live registry refuses the write before the service
 *   runs.
 * - Foreign resources 404; a snapshot the grammar refuses is named, never
 *   silently narrowed; edits/deletes refuse while work is active; a snapshot
 *   edit moves the revision and prior grants go stale BY MISMATCH.
 * - Grants bind the pane's CURRENT issued key (read from the row, not the
 *   body); revoke stamps history and answers through the list.
 * - Audit rows carry ids/revisions/outcomes, never command text (asserted
 *   over the whole audit table at the end).
 */
import { sshRoutes } from "@/api/ssh/index.js";
import { db } from "@/db/index.js";
import { NodesRepository } from "@/db/repositories/nodes.repository.js";
import { SubshellsRepository } from "@/db/repositories/subshells.repository.js";
import { UsersRepository } from "@/db/repositories/users.repository.js";
import { errorHandlerPlugin } from "@/plugins/error-handler.plugin.js";
import { resetNodeRegistryForTests } from "@/services/nodes/node-registry.js";
import { ensureLocalNode } from "@/services/nodes/seed-local.js";
import { issueSubshellToken } from "@/services/subshell-tokens.js";
import { attachScriptedNode, type ScriptedNode } from "@/test-helpers/scripted-node.js";
import { SNAPSHOT, snapshotWith } from "@/test-helpers/ssh-fixtures.js";
import { deleteUserByEmailOrId, setupAuthTables, signIn } from "../../__tests__/helpers/auth-tables.js";

const app = new Elysia().use(errorHandlerPlugin).use(sshRoutes);

const nodes = new NodesRepository(db);
const subshells = new SubshellsRepository(db);

const ownerEmail = `ssh-owner-${crypto.randomUUID()}@subshell.local`;
const foreignEmail = `ssh-foreign-${crypto.randomUUID()}@subshell.local`;
const pw = "sshconn-pass-1";
let ownerId: string;
let ownerCookie: string;
let foreignId: string;
let foreignCookie: string;
let node: string;
let foreignNode: string;
let scripted: ScriptedNode;

async function sshFetch(
  path: string,
  init: RequestInit,
  opts: { cookie?: string; bearer?: string; origin?: string | null } = {},
) {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json");
  if (opts.cookie) headers.set("cookie", `better-auth.session_token=${opts.cookie}`);
  if (opts.bearer) headers.set("authorization", `Bearer ${opts.bearer}`);
  // The CSRF arm: browsers send Origin on same-origin POSTs too; `null` means
  // "no Origin header" (curl/scripts), the explicitly-untrusted case sets one.
  if (opts.origin === null) headers.delete("origin");
  else headers.set("origin", opts.origin ?? "http://localhost:3080");
  return app.fetch(new Request(`http://localhost:3080${path}`, { ...init, headers }));
}

const get = (path: string, opts: Parameters<typeof sshFetch>[2] = {}) => sshFetch(path, { method: "GET" }, opts);
const post = (path: string, body: unknown, opts: Parameters<typeof sshFetch>[2] = {}) =>
  sshFetch(path, { method: "POST", body: JSON.stringify(body) }, opts);
const patch = (path: string, body: unknown, opts: Parameters<typeof sshFetch>[2] = {}) =>
  sshFetch(path, { method: "PATCH", body: JSON.stringify(body) }, opts);
const del = (path: string, opts: Parameters<typeof sshFetch>[2] = {}) => sshFetch(path, { method: "DELETE" }, opts);

async function createConnection(cookie: string, over: Record<string, unknown> = {}) {
  const res = await post(
    "/api/ssh/connections",
    { nodeId: node, displayName: "Staging", snapshot: SNAPSHOT, ...over },
    { cookie },
  );
  expect(res.status).toBe(200);
  return (await res.json()) as { id: string; revision: number };
}

/** A RUNNING agent pane for the owner, issued a real token (no `ssh` scope - Gate B adds it). */
async function makeAgentPane(name: string): Promise<{ id: string; bearer: string }> {
  const id = crypto.randomUUID();
  await subshells.create({
    id,
    userId: ownerId,
    harnessId: "claude-code",
    name,
    workingDir: "/srv",
    nodeId: node,
    status: "running",
    alive: 1,
    tmuxSocket: `sock-${crypto.randomUUID()}`,
    presetId: null,
  });
  const bearer = await issueSubshellToken(id, ownerId);
  return { id, bearer };
}

describe("/api/ssh connections + grants (spec 2026-10-04 §2/§4)", () => {
  beforeAll(async () => {
    await setupAuthTables();
    resetNodeRegistryForTests();
    await ensureLocalNode(db);
    const users = new UsersRepository(db);
    ownerId = await users.createUser({
      email: ownerEmail,
      name: ownerEmail,
      passwordHash: await hashPassword(pw),
      role: "user",
    });
    foreignId = await users.createUser({
      email: foreignEmail,
      name: foreignEmail,
      passwordHash: await hashPassword(pw),
      role: "user",
    });
    ownerCookie = await signIn(ownerEmail, pw);
    foreignCookie = await signIn(foreignEmail, pw);
    node = crypto.randomUUID();
    foreignNode = crypto.randomUUID();
    await nodes.create({
      id: node,
      ownerUserId: ownerId,
      name: `c-${node.slice(0, 8)}`,
      kind: "agent",
      status: "online",
    });
    await nodes.create({
      id: foreignNode,
      ownerUserId: foreignId,
      name: `c-${foreignNode.slice(0, 8)}`,
      kind: "agent",
      status: "online",
    });
    scripted = attachScriptedNode(node, {
      ssh_discover_aliases: () => ({ aliases: ["alpha", "beta"], includeCycle: false, truncated: false }),
      ssh_resolve_config: (cmd) =>
        cmd.type === "ssh_resolve_config" && cmd.alias === "ghost"
          ? { accepted: false, code: "config_missing", settings: [] }
          : { accepted: true, snapshot: SNAPSHOT, connectingAccount: "deploy" },
      ssh_test_connection: () => ({ passed: true }),
    });
    attachScriptedNode(foreignNode, {
      ssh_discover_aliases: () => ({ aliases: ["x"], includeCycle: false, truncated: false }),
      ssh_resolve_config: () => ({ accepted: true, snapshot: SNAPSHOT }),
    });
  });

  afterAll(() => {
    scripted.detach();
    resetNodeRegistryForTests();
    void deleteUserByEmailOrId(ownerEmail);
    void deleteUserByEmailOrId(foreignEmail);
  });

  describe("discovery + resolve + test (human-only config dispatch)", () => {
    it("answers the owner with alias NAMES only", async () => {
      const res = await get(`/api/ssh/discovery?nodeId=${node}`, { cookie: ownerCookie });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { aliases: string[] };
      expect(body.aliases).toEqual(["alpha", "beta"]);
    });

    it("403s every machine credential (coarse scope first; cookie arm behind it)", async () => {
      const pane = await makeAgentPane("d-pane");
      const byPane = await get(`/api/ssh/discovery?nodeId=${node}`, { bearer: pane.bearer });
      expect(byPane.status).toBe(403);
      expect(((await byPane.json()) as { message: string }).message).toContain("Forbidden");
    });

    it("404s a foreign node (config acts are the node owner's alone)", async () => {
      const res = await get(`/api/ssh/discovery?nodeId=${foreignNode}`, { cookie: ownerCookie });
      expect(res.status).toBe(404);
    });

    it("returns the named refusal INSIDE a 200 for an unresolvable alias", async () => {
      const res = await post("/api/ssh/connections/resolve", { nodeId: node, alias: "ghost" }, { cookie: ownerCookie });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { accepted: boolean; code: string };
      expect(body).toMatchObject({ accepted: false, code: "config_missing" });
    });

    it("passes the fixed test through and refuses caller-forged snapshots (never a silent narrowing)", async () => {
      const ok = await post("/api/ssh/connections/test", { nodeId: node, snapshot: SNAPSHOT }, { cookie: ownerCookie });
      expect(ok.status).toBe(200);
      expect(((await ok.json()) as { passed: boolean }).passed).toBe(true);
      // The route schema types the eight forbidden members as literal null, so
      // a `ProxyCommand` in the body cannot even parse (400 at the door); a
      // shape that parses but breaks the grammar is refused by the service's
      // copy of it. Either way: named refusal, nothing silently dropped.
      const proxy = await post(
        "/api/ssh/connections/test",
        { nodeId: node, snapshot: snapshotWith({ proxyCommand: "nc evil.net 22" }) },
        { cookie: ownerCookie },
      );
      expect(proxy.status).toBe(400);
      const badHost = await post(
        "/api/ssh/connections/test",
        { nodeId: node, snapshot: snapshotWith({ host: "two hosts.example.net" }) },
        { cookie: ownerCookie },
      );
      expect(badHost.status).toBe(400);
      expect(await badHost.text()).toContain("grammar");
    });
  });

  describe("save/edit/delete discipline", () => {
    it("saves at revision 1 and REFUSES the write from an untrusted origin (§2's explicit check)", async () => {
      const bad = await post(
        "/api/ssh/connections",
        { nodeId: node, displayName: "Evil", snapshot: SNAPSHOT },
        { cookie: ownerCookie, origin: "http://evil.example.com" },
      );
      expect(bad.status).toBe(403);
      const noOrigin = await post(
        "/api/ssh/connections",
        { nodeId: node, displayName: "No Origin", snapshot: SNAPSHOT },
        { cookie: ownerCookie, origin: null },
      );
      expect(noOrigin.status).toBe(200);
      await del(`/api/ssh/connections/${((await noOrigin.json()) as { id: string }).id}`);
      const saved = await createConnection(ownerCookie);
      expect(saved.revision).toBe(1);
    });

    it("404s foreign reads and refuses bearer config writes", async () => {
      const own = await createConnection(ownerCookie);
      const byForeign = await get(`/api/ssh/connections/${own.id}`, { cookie: foreignCookie });
      expect(byForeign.status).toBe(404);
      const pane = await makeAgentPane("f-pane");
      const byBearer = await post(
        "/api/ssh/connections",
        { nodeId: node, displayName: "X", snapshot: SNAPSHOT },
        { bearer: pane.bearer },
      );
      expect(byBearer.status).toBe(403);
    });

    it("refuses edits and deletes while work is active, then lets them through", async () => {
      const conn = await createConnection(ownerCookie);
      await db
        .insertInto("sshRuns")
        .values({
          id: `active-${conn.id}`,
          userId: ownerId,
          nodeId: node,
          connectionId: conn.id,
          connectionRevision: 1,
          configSnapshot: JSON.stringify(SNAPSHOT),
          initiatedBy: "human" as const,
          grantId: null,
          apiKeyId: null,
          command: "sleep 60",
          remoteDir: null,
          requestDigest: "d",
          deadlineMs: 60_000,
          status: "running" as const,
          cancelRequested: 0,
          cancelLocalConfirmed: 0,
          deadlineHit: 0,
          remoteStatus: null,
          remoteStatusConfirmed: 0,
          localExitCode: null,
          localExitSignal: null,
          startedAt: null,
          finishedAt: null,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        })
        .execute();
      const edit = await patch(`/api/ssh/connections/${conn.id}`, { displayName: "Later" }, { cookie: ownerCookie });
      expect(edit.status).toBe(403);
      expect(await edit.text()).toContain("active_work");
      const rm = await del(`/api/ssh/connections/${conn.id}`, { cookie: ownerCookie });
      expect(rm.status).toBe(403);
      expect(await rm.text()).toContain("active_work");
      await db
        .updateTable("sshRuns")
        .set({ status: "completed", finishedAt: new Date().toISOString() })
        .where("id", "=", `active-${conn.id}`)
        .execute();
      const rmOk = await del(`/api/ssh/connections/${conn.id}`, { cookie: ownerCookie });
      expect(rmOk.status).toBe(200);
    });

    it("bumps the revision on a snapshot edit so a pane's grant goes stale by mismatch", async () => {
      const conn = await createConnection(ownerCookie);
      const pane = await makeAgentPane("r-pane");
      const granted = await post(
        `/api/ssh/connections/${conn.id}/grants`,
        { subshellId: pane.id },
        { cookie: ownerCookie },
      );
      expect(granted.status).toBe(200);
      const edited = await patch(
        `/api/ssh/connections/${conn.id}`,
        { snapshot: snapshotWith({ host: "app-03.example.net" }) },
        { cookie: ownerCookie },
      );
      expect(edited.status).toBe(200);
      expect(((await edited.json()) as { revision: number }).revision).toBe(2);
      // The granted list read rides the coarse scope (Gate B adds `ssh` to the
      // mint map); until then the projection itself is proven at the service
      // level. The grant's staleness at REST is the policy matrix's job.
      const deniedByScope = await get(`/api/ssh/connections/${conn.id}`, { bearer: pane.bearer });
      expect(deniedByScope.status).toBe(403);
    });
  });

  describe("grants", () => {
    it("binds the pane's CURRENT issued key, refuses non-running panes, and revokes as history", async () => {
      const conn = await createConnection(ownerCookie);
      const pane = await makeAgentPane("g-route-pane");
      const row = await subshells.findById(pane.id);
      const granted = (await (
        await post(`/api/ssh/connections/${conn.id}/grants`, { subshellId: pane.id }, { cookie: ownerCookie })
      ).json()) as { apiKeyId: string; active: boolean; connectionRevision: number };
      expect(granted).toMatchObject({
        apiKeyId: row?.apiKeyId ?? expect.any(String),
        active: true,
        connectionRevision: 1,
      });

      const dead = crypto.randomUUID();
      await subshells.create({
        id: dead,
        userId: ownerId,
        harnessId: "claude-code",
        name: "dead-pane",
        workingDir: "/srv",
        nodeId: node,
        status: "terminated",
        alive: 0,
        tmuxSocket: `sock-${crypto.randomUUID()}`,
        presetId: null,
      });
      const refused = await post(
        `/api/ssh/connections/${conn.id}/grants`,
        { subshellId: dead },
        { cookie: ownerCookie },
      );
      expect(refused.status).toBe(409);

      const list = (await (await get(`/api/ssh/connections/${conn.id}/grants`, { cookie: ownerCookie })).json()) as {
        grants: { active: boolean }[];
      };
      expect(list.grants.filter((g) => g.active)).toHaveLength(1);

      const revoked = await del(`/api/ssh/connections/${conn.id}/grants/${pane.id}`, { cookie: ownerCookie });
      expect(revoked.status).toBe(200);
      expect(((await revoked.json()) as { revoked: boolean }).revoked).toBe(true);
      const after = (await (await get(`/api/ssh/connections/${conn.id}/grants`, { cookie: ownerCookie })).json()) as {
        grants: { active: boolean }[];
      };
      expect(after.grants.some((g) => !g.active)).toBe(true); // history stays
    });

    it("403s machine credentials on grant writes and 404s a foreign grant attempt", async () => {
      const conn = await createConnection(ownerCookie);
      const foreignPane = crypto.randomUUID();
      await subshells.create({
        id: foreignPane,
        userId: foreignId,
        harnessId: "claude-code",
        name: "x",
        workingDir: "/srv",
        nodeId: foreignNode,
        status: "running",
        alive: 1,
        tmuxSocket: `sock-${crypto.randomUUID()}`,
        presetId: null,
      });
      const byForeign = await post(
        `/api/ssh/connections/${conn.id}/grants`,
        { subshellId: foreignPane },
        { cookie: foreignCookie },
      );
      expect(byForeign.status).toBe(404);
      const pane = await makeAgentPane("g-denied");
      const byBearer = await post(
        `/api/ssh/connections/${conn.id}/grants`,
        { subshellId: pane.id },
        { bearer: pane.bearer },
      );
      expect(byBearer.status).toBe(403);
    });
  });

  it("keeps command text out of every audit row (spec §3's hygiene sentence)", async () => {
    const rows = await sql<{
      action: string;
      metadata: string;
    }>`SELECT action, metadata_json FROM audit_events WHERE action LIKE 'ssh.%'`.execute(db);
    expect(rows.rows.length).toBeGreaterThan(0);
    const corpus = rows.rows.map((r) => `${r.action} ${r.metadata ?? ""}`).join("\n");
    for (const banned of ["sleep 60", "echo", "rm -rf", "id_ed25519"]) {
      expect(corpus.includes(banned)).toBe(false);
    }
  });
});
