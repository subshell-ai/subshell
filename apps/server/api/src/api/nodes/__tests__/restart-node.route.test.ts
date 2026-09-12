import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
  NODE_RESULT_KILLS_PANES,
  NODE_RESULT_NOT_SUPERVISED,
  type NodeRuntimeReport,
} from "@internal/subshell-protocol";
import { hashPassword } from "better-auth/crypto";
import { Elysia } from "elysia";
import { nodesRoutes } from "@/api/nodes/index.js";
import { db } from "@/db/index.js";
import { AuditRepository } from "@/db/repositories/audit.repository.js";
import { NodeSharesRepository } from "@/db/repositories/node-shares.repository.js";
import { NodesRepository } from "@/db/repositories/nodes.repository.js";
import { SubshellsRepository } from "@/db/repositories/subshells.repository.js";
import { UsersRepository } from "@/db/repositories/users.repository.js";
import { errorHandlerPlugin } from "@/plugins/error-handler.plugin.js";
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
 * `POST /api/nodes/:id/restart` (spec 2026-09-12 § 6.3) and the `runtime`
 * block `GET /api/nodes/:id` carries (§ 6.2).
 *
 * The two live together because they are two halves of one fact: `runtime` is
 * what the agent reported about its own process at `ready`, and the restart is
 * what the plane does with it. Both are CONNECTION state — when the node is
 * offline there is nothing to report and nothing to restart.
 */

const app = new Elysia().use(errorHandlerPlugin).use(nodesRoutes);
const nodes = new NodesRepository(db);
const nodeShares = new NodeSharesRepository(db);

/** A plausible report from a healthy systemd agent. */
const runtime: NodeRuntimeReport = {
  startedAt: "2026-09-12T00:00:00.000Z",
  supervised: true,
  service: {
    manager: "systemd",
    installed: true,
    definitionPath: "/x/subshell.service",
    state: "running",
    pid: 1,
    enabled: true,
    paneSafety: "keeps",
  },
  configPath: "/c/config.json",
  logPath: null,
  logHint: "journalctl --user -u subshell.service -f",
  tmuxPath: "/usr/bin/tmux",
  binaryPath: "/b/subshell",
};

describe("/api/nodes restart + runtime", () => {
  const pw = "node-restart-1";
  const emails = {
    alice: `nr-alice-${crypto.randomUUID()}@subshell.local`,
    carol: `nr-carol-${crypto.randomUUID()}@subshell.local`,
  };
  let aliceId: string;
  let carolId: string;
  let aliceCookie = "";
  let carolCookie = "";
  let subshellKey = "";
  const createdNodeIds: string[] = [];
  const createdSubshellIds: string[] = [];

  /** An offline agent node owned by alice. */
  async function mkAgent(): Promise<string> {
    const id = crypto.randomUUID();
    await nodes.create({ id, ownerUserId: aliceId, name: `nr-${id.slice(0, 8)}`, kind: "agent", status: "offline" });
    createdNodeIds.push(id);
    return id;
  }

  beforeAll(async () => {
    await setupAuthTables();
    const users = new UsersRepository(db);
    aliceId = await users.createUser({ email: emails.alice, passwordHash: await hashPassword(pw), role: "user" });
    carolId = await users.createUser({ email: emails.carol, passwordHash: await hashPassword(pw), role: "user" });
    aliceCookie = await signIn(emails.alice, pw);
    carolCookie = await signIn(emails.carol, pw);
    await ensureLocalNode(db);
    const sid = `s_nr_${crypto.randomUUID().slice(0, 8)}`;
    await new SubshellsRepository(db).create({
      id: sid,
      userId: aliceId,
      profileId: "p",
      harnessId: "claude-code",
      name: sid,
      workingDir: "/tmp",
      tmuxSocket: null,
    });
    createdSubshellIds.push(sid);
    subshellKey = await issueSubshellToken(sid, aliceId);
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

  /** The registry connection for a node, asserted live by the caller first. */
  function liveConn(nodeId: string): NonNullable<ReturnType<typeof getLive>> {
    const conn = getLive(nodeId);
    if (!conn) throw new Error(`node ${nodeId} must have a live connection`);
    return conn;
  }

  /**
   * Attach a live connection reporting `facts` as its agent runtime. `null`
   * means "this agent reported none" — and it is `null` rather than
   * `undefined` because a default parameter treats an explicitly passed
   * `undefined` as absent, which silently handed the default report to the
   * one case that exists to prove the absence.
   */
  function goOnline(nodeId: string, facts: NodeRuntimeReport | null = runtime): ReturnType<typeof fakeSocket> {
    const sock = fakeSocket();
    const conn = attachConnection(nodeId, sock);
    conn.agent = {
      dataDir: "/d",
      capabilities: [],
      hostname: "h",
      agentVersion: "0.2.0",
      ...(facts ? { runtime: facts } : {}),
    };
    return sock;
  }

  /** Fire a restart and answer its one command with what the agent would send. */
  async function restartWithAnswer(
    nodeId: string,
    cookie: string,
    body: unknown,
    answer: { ok: true } | { ok: false; error: string },
    facts: NodeRuntimeReport | null = runtime,
  ): Promise<Response> {
    const sock = goOnline(nodeId, facts);
    try {
      const resP = req("POST", `/api/nodes/${nodeId}/restart`, { cookie, body });
      await waitFor(() => sock.sent.length > 0, "restart command on the wire");
      const frame = JSON.parse(sock.sent[0] as string) as { jws: string };
      const claim = JSON.parse(Buffer.from((frame.jws.split(".")[1] ?? "") as string, "base64url").toString()) as {
        jti: string;
        aud: string;
        cmd: { type: string; force?: boolean };
      };
      expect(claim.cmd.type).toBe("restart");
      expect(claim.aud).toBe(`node:${nodeId}`);
      expect(claim.cmd.force).toBe((body as { force?: boolean }).force);
      const ev = answer.ok
        ? ({ type: "result", ref: claim.jti, ok: true } as const)
        : ({ type: "result", ref: claim.jti, ok: false, error: answer.error } as const);
      expect(resolveResult(liveConn(nodeId), ev)).toBe(true);
      return await resP;
    } finally {
      resetNodeRegistryForTests();
    }
  }

  /** The `code` of an error response. */
  async function codeOf(res: Response): Promise<string> {
    return ((await res.json()) as { code: string }).code;
  }

  // ── POST /api/nodes/:id/restart ─────────────────────────────────────────

  it("offline → 409 NODE_OFFLINE", async () => {
    const id = await mkAgent();
    const res = await req("POST", `/api/nodes/${id}/restart`, { cookie: aliceCookie, body: {} });
    expect(res.status).toBe(409);
    expect(await codeOf(res)).toBe("NODE_OFFLINE");
  });

  it("view grantee 403, local 400, unknown 404, bearer 403, anon 401", async () => {
    const id = await mkAgent();
    // A `view` grantee may LAUNCH on this node; restarting the machine's agent
    // is a configure act, so `nodeCanConfigure` and not `canAccess`.
    await nodeShares.replaceForNode(id, [{ granteeUserId: carolId, permission: "view" }], aliceId);
    expect((await req("POST", `/api/nodes/${id}/restart`, { cookie: carolCookie, body: {} })).status).toBe(403);
    expect((await req("POST", "/api/nodes/local/restart", { cookie: aliceCookie, body: {} })).status).toBe(400);
    expect(
      (await req("POST", `/api/nodes/nope-${crypto.randomUUID()}/restart`, { cookie: aliceCookie, body: {} })).status,
    ).toBe(404);
    expect((await req("POST", `/api/nodes/${id}/restart`, { bearer: subshellKey, body: {} })).status).toBe(403);
    expect((await req("POST", `/api/nodes/${id}/restart`, { body: {} })).status).toBe(401);
  });

  it("online: sends the signed restart, answers {ok:true}, audits node.restart", async () => {
    const id = await mkAgent();
    const res = await restartWithAnswer(id, aliceCookie, {}, { ok: true });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    const events = await new AuditRepository(db).listLatest(5);
    const ev = events.find((e) => e.action === "node.restart" && e.targetId === id);
    expect(ev).toBeDefined();
    expect(ev?.metadataJson ?? "").toContain("false");
  });

  it("carries force through to the signed claim", async () => {
    const id = await mkAgent();
    const res = await restartWithAnswer(id, aliceCookie, { force: true }, { ok: true });
    expect(res.status).toBe(200);
  });

  it("maps the agent's refusals: not supervised, kills panes, unsupported", async () => {
    const id = await mkAgent();
    let res = await restartWithAnswer(id, aliceCookie, {}, { ok: false, error: NODE_RESULT_NOT_SUPERVISED });
    expect(res.status).toBe(409);
    expect(await codeOf(res)).toBe("NODE_NOT_SUPERVISED");

    res = await restartWithAnswer(id, aliceCookie, {}, { ok: false, error: NODE_RESULT_KILLS_PANES });
    expect(res.status).toBe(409);
    expect(await codeOf(res)).toBe("NODE_RESTART_KILLS_PANES");

    res = await restartWithAnswer(id, aliceCookie, { force: true }, { ok: false, error: "unsupported" });
    expect(res.status).toBe(409);
    expect(await codeOf(res)).toBe("NODE_AGENT_TOO_OLD");
  });

  /**
   * The agent refuses `paneSafety: "unknown"` with the same wire string as
   * `"kills"` — its destructive verbs fail closed on a definition they could
   * not read. The code is the same; the MESSAGE must not assert that panes
   * would die, because nobody knows that.
   */
  it("says the definition could not be read when pane safety is unknown", async () => {
    const id = await mkAgent();
    const unknownSafety: NodeRuntimeReport = {
      ...runtime,
      service: { ...runtime.service, paneSafety: "unknown" },
    };
    const res = await restartWithAnswer(
      id,
      aliceCookie,
      {},
      { ok: false, error: NODE_RESULT_KILLS_PANES },
      unknownSafety,
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as { code: string; message: string };
    expect(body.code).toBe("NODE_RESTART_KILLS_PANES");
    expect(body.message).toMatch(/could not be read/i);
  });

  /**
   * The mapping matches the protocol's exact wire strings, so an agent error
   * nobody enumerated degrades to the generic unreachable code instead of
   * being read as one of the two known refusals.
   */
  it("maps an unrecognized agent error to NODE_UNREACHABLE", async () => {
    const id = await mkAgent();
    const res = await restartWithAnswer(id, aliceCookie, {}, { ok: false, error: "not supervised enough, honestly" });
    expect(res.status).toBe(409);
    expect(await codeOf(res)).toBe("NODE_UNREACHABLE");
  });

  // ── GET /api/nodes/:id runtime ──────────────────────────────────────────

  it("runtime is present for an online node's owner, absent for a view grantee and when offline", async () => {
    const id = await mkAgent();
    await nodeShares.replaceForNode(id, [{ granteeUserId: carolId, permission: "view" }], aliceId);
    const offline = (await (await req("GET", `/api/nodes/${id}`, { cookie: aliceCookie })).json()) as {
      runtime?: unknown;
    };
    expect(offline.runtime).toBeUndefined();
    goOnline(id);
    try {
      const asOwner = (await (await req("GET", `/api/nodes/${id}`, { cookie: aliceCookie })).json()) as {
        runtime?: NodeRuntimeReport;
      };
      expect(asOwner.runtime).toEqual(runtime);
      const asViewer = (await (await req("GET", `/api/nodes/${id}`, { cookie: carolCookie })).json()) as {
        runtime?: unknown;
      };
      expect(asViewer.runtime).toBeUndefined();
    } finally {
      resetNodeRegistryForTests();
    }
  });

  it("runtime is absent when an online agent reported none", async () => {
    const id = await mkAgent();
    goOnline(id, null);
    try {
      const view = (await (await req("GET", `/api/nodes/${id}`, { cookie: aliceCookie })).json()) as {
        runtime?: unknown;
      };
      expect(view.runtime).toBeUndefined();
    } finally {
      resetNodeRegistryForTests();
    }
  });
});
