import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
  NODE_RESULT_KILLS_PANES,
  NODE_RESULT_NO_SERVICE,
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
 * `POST /api/nodes/:id/service` (spec 2026-09-12 § 6.3) and the `runtime`
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
    // Enabled but NOT lingering: the pair that reads "comes back at login,
    // not at boot" — the interesting case, and the one the round-trip below
    // proves survives the schema.
    linger: false,
    paneSafety: "keeps",
  },
  configPath: "/c/config.json",
  agentLogPath: "/c/logs/agent.log",
  logPath: null,
  logHint: "journalctl --user -u subshell.service -f",
  tmuxPath: "/usr/bin/tmux",
  binaryPath: "/b/subshell",
  logging: { debug: false, source: "default" as const },
};

describe("/api/nodes service + runtime", () => {
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
  async function mkNode(): Promise<string> {
    const id = crypto.randomUUID();
    await nodes.create({ id, ownerUserId: aliceId, name: `nr-${id.slice(0, 8)}`, kind: "agent", status: "offline" });
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
    const sid = `s_nr_${crypto.randomUUID().slice(0, 8)}`;
    await new SubshellsRepository(db).create({
      id: sid,
      userId: aliceId,
      presetId: "p",
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

  /** Fire a service verb and answer its one command with what the agent would send. */
  async function serviceWithAnswer(
    nodeId: string,
    cookie: string,
    body: unknown,
    answer: { ok: true } | { ok: false; error: string },
    facts: NodeRuntimeReport | null = runtime,
  ): Promise<Response> {
    const sock = goOnline(nodeId, facts);
    try {
      const resP = req("POST", `/api/nodes/${nodeId}/service`, { cookie, body });
      await waitFor(() => sock.sent.length > 0, "service command on the wire");
      const frame = JSON.parse(sock.sent[0] as string) as { jws: string };
      const claim = JSON.parse(Buffer.from((frame.jws.split(".")[1] ?? "") as string, "base64url").toString()) as {
        jti: string;
        aud: string;
        cmd: { type: string; verb?: string; force?: boolean };
      };
      expect(claim.cmd.type).toBe("service");
      expect(claim.cmd.verb).toBe((body as { verb?: string }).verb);
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

  // ── POST /api/nodes/:id/service ─────────────────────────────────────────

  it("offline → 409 NODE_OFFLINE", async () => {
    const id = await mkNode();
    const res = await req("POST", `/api/nodes/${id}/service`, { cookie: aliceCookie, body: { verb: "restart" } });
    expect(res.status).toBe(409);
    expect(await codeOf(res)).toBe("NODE_OFFLINE");
  });

  it("view grantee 403, local 400, unknown 404, bearer 403, anon 401", async () => {
    const id = await mkNode();
    // A `view` grantee may LAUNCH on this node; restarting the machine's agent
    // is a configure act, so `nodeCanConfigure` and not `canAccess`.
    await nodeShares.replaceForNode(id, [{ granteeUserId: carolId, permission: "view" }], aliceId);
    expect(
      (await req("POST", `/api/nodes/${id}/service`, { cookie: carolCookie, body: { verb: "restart" } })).status,
    ).toBe(403);
    expect(
      (await req("POST", "/api/nodes/local/service", { cookie: aliceCookie, body: { verb: "restart" } })).status,
    ).toBe(400);
    expect(
      (
        await req("POST", `/api/nodes/nope-${crypto.randomUUID()}/service`, {
          cookie: aliceCookie,
          body: { verb: "restart" },
        })
      ).status,
    ).toBe(404);
    expect(
      (await req("POST", `/api/nodes/${id}/service`, { bearer: subshellKey, body: { verb: "restart" } })).status,
    ).toBe(403);
    expect((await req("POST", `/api/nodes/${id}/service`, { body: { verb: "restart" } })).status).toBe(401);
  });

  /**
   * The two one-way verbs. A command reaches a node over the AGENT'S OWN
   * socket, so the plane can never start an agent that is not running:
   * `stop` and `uninstall` end the connection that would carry the verb
   * undoing them. An `edit` grantee is trusted to interrupt a machine they
   * were shared (a restart comes back); making it unreachable until somebody
   * walks to it is a different act, so those two are the owner's.
   */
  it("stop and uninstall are owner-only, even for an edit grantee", async () => {
    const id = await mkNode();
    await nodeShares.replaceForNode(id, [{ granteeUserId: carolId, permission: "edit" }], aliceId);
    for (const verb of ["stop", "uninstall"] as const) {
      expect((await req("POST", `/api/nodes/${id}/service`, { cookie: carolCookie, body: { verb } })).status).toBe(403);
    }
    // The reachable verbs stay with `nodeCanConfigure`, so the same grantee
    // may still drive them — offline here, which is a 409 and not a 403.
    for (const verb of ["restart", "start", "install"] as const) {
      expect((await req("POST", `/api/nodes/${id}/service`, { cookie: carolCookie, body: { verb } })).status).toBe(409);
    }
  });

  it("refuses a verb it does not know", async () => {
    const id = await mkNode();
    const res = await req("POST", `/api/nodes/${id}/service`, { cookie: aliceCookie, body: { verb: "reload" } });
    expect(res.status).toBe(400);
  });

  /**
   * `force` means "act even though live panes will die", so it is meaningless
   * on the two verbs that cannot end one. Refused rather than ignored: a flag
   * silently accepted where it does nothing is how a caller learns it is
   * noise, and then passes it where it is not.
   */
  it("refuses force on a verb that cannot close a subshell", async () => {
    const id = await mkNode();
    for (const verb of ["start", "install"] as const) {
      const res = await req("POST", `/api/nodes/${id}/service`, { cookie: aliceCookie, body: { verb, force: true } });
      expect(res.status).toBe(400);
      expect(await codeOf(res)).toBe("BAD_REQUEST");
    }
  });

  it("maps the agent's no-definition refusal to NODE_NO_SERVICE", async () => {
    const id = await mkNode();
    const res = await serviceWithAnswer(
      id,
      aliceCookie,
      { verb: "start" },
      { ok: false, error: NODE_RESULT_NO_SERVICE },
    );
    expect(res.status).toBe(409);
    expect(await codeOf(res)).toBe("NODE_NO_SERVICE");
  });

  it("online: sends the signed service command, answers {ok:true}, audits node.service", async () => {
    const id = await mkNode();
    const res = await serviceWithAnswer(id, aliceCookie, { verb: "restart" }, { ok: true });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    const events = await new AuditRepository(db).listLatest(5);
    const ev = events.find((e) => e.action === "node.service" && e.targetId === id);
    expect(ev).toBeDefined();
    expect(ev?.metadataJson ?? "").toContain("false");
  });

  it("carries force through to the signed claim", async () => {
    const id = await mkNode();
    const res = await serviceWithAnswer(id, aliceCookie, { verb: "restart", force: true }, { ok: true });
    expect(res.status).toBe(200);
  });

  it("maps the agent's refusals: not supervised, kills panes, unsupported", async () => {
    const id = await mkNode();
    let res = await serviceWithAnswer(
      id,
      aliceCookie,
      { verb: "restart" },
      { ok: false, error: NODE_RESULT_NOT_SUPERVISED },
    );
    expect(res.status).toBe(409);
    expect(await codeOf(res)).toBe("NODE_NOT_SUPERVISED");

    res = await serviceWithAnswer(id, aliceCookie, { verb: "restart" }, { ok: false, error: NODE_RESULT_KILLS_PANES });
    expect(res.status).toBe(409);
    expect(await codeOf(res)).toBe("NODE_RESTART_KILLS_PANES");

    res = await serviceWithAnswer(
      id,
      aliceCookie,
      { verb: "restart", force: true },
      { ok: false, error: "unsupported" },
    );
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
    const id = await mkNode();
    const unknownSafety: NodeRuntimeReport = {
      ...runtime,
      service: { ...runtime.service, paneSafety: "unknown" },
    };
    const res = await serviceWithAnswer(
      id,
      aliceCookie,
      { verb: "restart" },
      { ok: false, error: NODE_RESULT_KILLS_PANES },
      unknownSafety,
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as { code: string; message: string };
    expect(body.code).toBe("NODE_RESTART_KILLS_PANES");
    expect(body.message).toMatch(/could not be read/i);
  });

  it("says the same when there is NO runtime report at all — `undefined` is not evidence of kills", async () => {
    // The degraded case the `=== "unknown"` branch silently asserted over:
    // an agent whose frozen `ready` facts never landed gives the plane
    // `undefined`, which is a THIRD state — nobody answered — and belongs on
    // the hedge side of the wording rule, not the certain one.
    const id = await mkNode();
    const res = await serviceWithAnswer(
      id,
      aliceCookie,
      { verb: "stop" },
      { ok: false, error: NODE_RESULT_KILLS_PANES },
      null,
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as { code: string; message: string };
    expect(body.code).toBe("NODE_RESTART_KILLS_PANES");
    expect(body.message).toMatch(/could not be read/i);
    expect(body.message).not.toMatch(/would close/i);
  });

  /**
   * The mapping matches the protocol's exact wire strings, so an agent error
   * nobody enumerated degrades to the generic unreachable code instead of
   * being read as one of the two known refusals.
   */
  it("maps an unrecognized agent error to NODE_UNREACHABLE", async () => {
    const id = await mkNode();
    const res = await serviceWithAnswer(
      id,
      aliceCookie,
      { verb: "restart" },
      { ok: false, error: "not supervised enough, honestly" },
    );
    expect(res.status).toBe(409);
    expect(await codeOf(res)).toBe("NODE_UNREACHABLE");
  });

  // ── GET /api/nodes/:id runtime ──────────────────────────────────────────

  it("runtime is present for an online node's owner, absent for a view grantee and when offline", async () => {
    const id = await mkNode();
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
    const id = await mkNode();
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
