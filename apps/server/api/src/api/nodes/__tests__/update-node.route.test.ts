import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import {
  NODE_PROTOCOL_VERSION,
  NODE_RESULT_DIGEST_MISMATCH,
  NODE_RESULT_DOWNLOAD_FAILED,
  NODE_RESULT_KILLS_PANES,
  NODE_RESULT_NOT_COMPILED,
  NODE_RESULT_NOT_SUPERVISED,
  NODE_RESULT_VERSION_MISMATCH,
  type NodeRuntimeReport,
} from "@internal/subshell-protocol";
import { hashPassword } from "better-auth/crypto";
import { Elysia } from "elysia";
import { nodesRoutes } from "@/api/nodes/index.js";
import { db } from "@/db/index.js";
import { AuditRepository } from "@/db/repositories/audit.repository.js";
import { NodeSharesRepository } from "@/db/repositories/node-shares.repository.js";
import { NodesRepository } from "@/db/repositories/nodes.repository.js";
import { UsersRepository } from "@/db/repositories/users.repository.js";
import { errorHandlerPlugin } from "@/plugins/error-handler.plugin.js";
import {
  attachConnection,
  getHeld,
  getLive,
  holdConnection,
  type NodeSocket,
  resetNodeRegistryForTests,
} from "@/services/nodes/node-registry.js";
import { failConnPendings, resolveResult } from "@/services/nodes/node-rpc.js";
import { ensureLocalNode } from "@/services/nodes/seed-local.js";
import { resetUpdateTokensForTests } from "@/services/nodes/update-tokens.js";
import { resetReleaseCacheForTests, setReleaseUrlForTests } from "@/services/releases.js";
import { deleteUserByEmailOrId, setupAuthTables, signIn } from "../../__tests__/helpers/auth-tables.js";

/**
 * `POST /api/nodes/:id/update` (spec 2026-09-15 §5.3).
 *
 * The cases fall in two groups, and the split matters. The refusals BEFORE the
 * release lookup are gates on who and what: cookie-only, `local`, the
 * configure grant, and whether anything is connected at all. Those run against
 * a plane with no release source, because none of them should need one — a
 * gate that reached the network to say "you may not" would be a gate that
 * fails differently when the network does.
 *
 * The rest drive the command end to end against a FAKE RELEASE SOURCE served
 * by `Bun.serve`, so the release index, the manifest and the digest are read
 * exactly as they are in production.
 */

const app = new Elysia().use(errorHandlerPlugin).use(nodesRoutes);
const nodes = new NodesRepository(db);
const nodeShares = new NodeSharesRepository(db);

/** A healthy systemd agent's report — pane-safe and supervised. */
const runtime: NodeRuntimeReport = {
  startedAt: "2026-09-15T00:00:00.000Z",
  supervised: true,
  service: {
    manager: "systemd",
    installed: true,
    definitionPath: "/x/subshell.service",
    state: "running",
    pid: 1,
    enabled: true,
    linger: true,
    paneSafety: "keeps",
  },
  configPath: "/c/config.json",
  agentLogPath: "/c/logs/agent.log",
  logPath: null,
  logHint: null,
  tmuxPath: "/usr/bin/tmux",
  binaryPath: "/b/subshell",
  logging: { debug: false, source: "default" as const },
};

/** The version the fake release publishes, chosen above any real one. */
const RELEASE_VERSION = "9.9.9";
const RELEASE_TAG = `node-v${RELEASE_VERSION}`;

describe("POST /api/nodes/:id/update", () => {
  const pw = "node-update-1";
  const emails = {
    alice: `nu-alice-${crypto.randomUUID()}@subshell.local`,
    carol: `nu-carol-${crypto.randomUUID()}@subshell.local`,
  };
  let aliceId: string;
  let carolId: string;
  let aliceCookie = "";
  let carolCookie = "";
  const createdNodeIds: string[] = [];
  let release: ReturnType<typeof Bun.serve> | undefined;

  /** An offline agent node owned by alice, reporting a linux-x64 platform. */
  async function mkAgent(): Promise<string> {
    const id = crypto.randomUUID();
    await nodes.create({ id, ownerUserId: aliceId, name: `nu-${id.slice(0, 8)}`, kind: "agent", status: "offline" });
    await nodes.applyReady(id, {
      agentVersion: "0.8.0",
      protocolVersion: NODE_PROTOCOL_VERSION,
      os: "linux",
      arch: "x64",
      hostname: "box",
      capabilities: [],
    });
    await nodes.setStatus(id, "offline");
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

    // The fake release source. It answers the LIST endpoint the real service
    // reads, a manifest declaring THIS server's protocol, and a sidecar — the
    // three reads `compatibleNodeRelease` + `fetchDigest` make.
    release = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === "/releases") {
          const base = `http://127.0.0.1:${release?.port}`;
          return Response.json([
            {
              tag_name: RELEASE_TAG,
              draft: false,
              published_at: "2026-09-15T00:00:00Z",
              assets: [
                { name: "release-manifest.json", browser_download_url: `${base}/manifest` },
                { name: "subshell-node-cli-linux-x64", browser_download_url: `${base}/bin` },
                { name: "subshell-node-cli-linux-x64.sha256", browser_download_url: `${base}/sha` },
              ],
            },
          ]);
        }
        if (url.pathname === "/manifest") {
          return Response.json({
            component: "node",
            version: RELEASE_VERSION,
            nodeProtocol: NODE_PROTOCOL_VERSION,
            minAgentVersion: "0.9.0",
            commit: "deadbeef",
          });
        }
        if (url.pathname === "/sha") return new Response(`${"a".repeat(64)}\n`);
        return new Response("no", { status: 404 });
      },
    });
  });

  afterAll(async () => {
    resetNodeRegistryForTests();
    setReleaseUrlForTests(null);
    resetReleaseCacheForTests();
    release?.stop(true);
    for (const id of createdNodeIds) await nodes.deleteById(id);
    for (const email of Object.values(emails)) await deleteUserByEmailOrId(email);
  });

  afterEach(() => {
    resetNodeRegistryForTests();
    resetUpdateTokensForTests();
  });

  /** Point the release service at the fake source and drop its memo. */
  function useFakeRelease(): void {
    setReleaseUrlForTests(`http://127.0.0.1:${release?.port}/releases`);
    resetReleaseCacheForTests();
  }

  /** Point it at nothing — the air-gapped configuration. */
  function useNoRelease(): void {
    setReleaseUrlForTests(null);
    resetReleaseCacheForTests();
  }

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

  function fakeSocket(): NodeSocket & { sent: string[]; closed: number[] } {
    return {
      sent: [],
      closed: [],
      send(data: string) {
        this.sent.push(data);
        return data.length;
      },
      close(code?: number) {
        this.closed.push(code ?? 1000);
      },
    };
  }

  async function waitFor(cond: () => boolean, what: string, budgetMs = 3000): Promise<void> {
    for (let waited = 0; ; waited += 5) {
      if (cond()) return;
      if (waited > budgetMs) throw new Error(`timed out waiting for ${what}`);
      await new Promise((r) => setTimeout(r, 5));
    }
  }

  /** Attach a live connection reporting `facts`. */
  function goOnline(nodeId: string, facts: NodeRuntimeReport | null = runtime): ReturnType<typeof fakeSocket> {
    const sock = fakeSocket();
    const conn = attachConnection(nodeId, sock);
    conn.agent = {
      dataDir: "/d",
      capabilities: [],
      hostname: "h",
      agentVersion: "0.8.0",
      ...(facts ? { runtime: facts } : {}),
    };
    return sock;
  }

  /** Attach a socket and HOLD it, as the ws handler does for a refused agent. */
  function goHeld(nodeId: string): ReturnType<typeof fakeSocket> {
    const sock = fakeSocket();
    const conn = attachConnection(nodeId, sock);
    holdConnection(nodeId, conn, {
      reason: "below-floor",
      agentVersion: "0.8.0",
      protocolVersion: NODE_PROTOCOL_VERSION,
      os: "linux",
      arch: "x64",
      onIdle: () => undefined,
    });
    return sock;
  }

  /**
   * Fire the update and answer its one command with what the agent would send.
   *
   * It asserts the frame the plane put on the wire as it goes — the version,
   * the digest, and that the url carries a token — because those are the
   * fields the agent acts on and a route test that only checked the status
   * code would pass with any of them wrong.
   */
  async function updateWithAnswer(
    nodeId: string,
    cookie: string,
    body: unknown,
    answer: { ok: true } | { ok: false; error: string },
    conn: "live" | "held" = "live",
    facts: NodeRuntimeReport | null = runtime,
  ): Promise<{ res: Response; cmd: Record<string, unknown> }> {
    const sock = conn === "held" ? goHeld(nodeId) : goOnline(nodeId, facts);
    const record = conn === "held" ? getHeld(nodeId)?.conn : getLive(nodeId);
    if (!record) throw new Error("no connection record");
    const resP = req("POST", `/api/nodes/${nodeId}/update`, { cookie, body });
    await waitFor(() => sock.sent.length > 0, "update command on the wire");
    const frame = JSON.parse(sock.sent[0] as string) as { jws: string };
    const claim = JSON.parse(Buffer.from((frame.jws.split(".")[1] ?? "") as string, "base64url").toString()) as {
      jti: string;
      aud: string;
      cmd: Record<string, unknown>;
    };
    expect(claim.aud).toBe(`node:${nodeId}`);
    const ev = answer.ok
      ? ({ type: "result", ref: claim.jti, ok: true } as const)
      : ({ type: "result", ref: claim.jti, ok: false, error: answer.error } as const);
    expect(resolveResult(record, ev)).toBe(true);
    return { res: await resP, cmd: claim.cmd };
  }

  /** The `code` of an error response. */
  async function codeOf(res: Response): Promise<string> {
    return ((await res.json()) as { code: string }).code;
  }

  // ── gates, none of which should need a release source ───────────────────

  it("401 anonymous, 404 unknown node", async () => {
    useNoRelease();
    const id = await mkAgent();
    expect((await req("POST", `/api/nodes/${id}/update`, { body: {} })).status).toBe(401);
    const missing = await req("POST", `/api/nodes/${crypto.randomUUID()}/update`, { cookie: aliceCookie, body: {} });
    expect(missing.status).toBe(404);
  });

  it("local → 400, BEFORE the permission check", async () => {
    // A statement about the ROUTE rather than about the caller: the
    // control-plane host updates with the server, and a 403 would send
    // someone looking for an owner to ask.
    useNoRelease();
    const res = await req("POST", "/api/nodes/local/update", { cookie: aliceCookie, body: {} });
    expect(res.status).toBe(400);
    expect(await codeOf(res)).toBe("BAD_REQUEST");
  });

  it("a view grantee is refused; an edit grantee is not", async () => {
    // The same gate `service restart` carries, because that is what this is.
    useNoRelease();
    const id = await mkAgent();
    await nodeShares.replaceForNode(id, [{ granteeUserId: carolId, permission: "view" }], aliceId);
    expect((await req("POST", `/api/nodes/${id}/update`, { cookie: carolCookie, body: {} })).status).toBe(403);

    await nodeShares.replaceForNode(id, [{ granteeUserId: carolId, permission: "edit" }], aliceId);
    const res = await req("POST", `/api/nodes/${id}/update`, { cookie: carolCookie, body: {} });
    // Past the gate, refused for being disconnected — which is the next check.
    expect(res.status).toBe(409);
    expect(await codeOf(res)).toBe("NODE_OFFLINE");
  });

  it("neither live nor held → 409 NODE_OFFLINE", async () => {
    useNoRelease();
    const id = await mkAgent();
    const res = await req("POST", `/api/nodes/${id}/update`, { cookie: aliceCookie, body: {} });
    expect(res.status).toBe(409);
    expect(await codeOf(res)).toBe("NODE_OFFLINE");
  });

  it("no release source → 409 NODE_UPDATE_UNAVAILABLE naming the reason", async () => {
    useNoRelease();
    const id = await mkAgent();
    goOnline(id);
    const res = await req("POST", `/api/nodes/${id}/update`, { cookie: aliceCookie, body: {} });
    expect(res.status).toBe(409);
    expect(await codeOf(res)).toBe("NODE_UPDATE_UNAVAILABLE");
  });

  it("a platform with no published artifact → 409 NODE_UPDATE_UNAVAILABLE", async () => {
    useFakeRelease();
    const id = await mkAgent();
    // An Intel Mac: a real platform this project publishes nothing for.
    await nodes.applyReady(id, {
      agentVersion: "0.8.0",
      protocolVersion: NODE_PROTOCOL_VERSION,
      os: "darwin",
      arch: "x64",
      hostname: "box",
      capabilities: [],
    });
    goOnline(id);
    const res = await req("POST", `/api/nodes/${id}/update`, { cookie: aliceCookie, body: {} });
    expect(res.status).toBe(409);
    const err = (await res.json()) as { code: string; message: string };
    expect(err.code).toBe("NODE_UPDATE_UNAVAILABLE");
    expect(err.message).toContain("darwin/x64");
  });

  // ── the command, end to end ─────────────────────────────────────────────

  it("202 on success, with the version, a tokenless url, and an audit row", async () => {
    useFakeRelease();
    const id = await mkAgent();
    const { res, cmd } = await updateWithAnswer(id, aliceCookie, {}, { ok: true });
    expect(res.status).toBe(202);
    const body = (await res.json()) as { ok: true; from: string; to: string; url: string };
    expect(body).toMatchObject({ ok: true, from: "0.8.0", to: RELEASE_VERSION });
    // The url the PAGE sees carries no credential — it is echoed so a loopback
    // APP_BASE_URL can be warned about, not so anyone can re-use the download.
    expect(body.url).not.toContain("update_token");
    expect(body.url).toContain("/api/downloads/node/linux-x64");

    // The command the AGENT sees is the frozen shape, with the token baked in.
    expect(cmd.type).toBe("update");
    expect(cmd.version).toBe(RELEASE_VERSION);
    expect(cmd.sha256).toBe("a".repeat(64));
    expect(String(cmd.url)).toMatch(/[?&]update_token=nut_/);
    // No `force` unless asked: an absent flag must not arrive as `false`,
    // which the agent would read the same but which widens the frozen shape.
    expect(cmd).not.toHaveProperty("force");

    const rows = await new AuditRepository(db).listLatest(20);
    const row = rows.find((r) => r.action === "node.update" && r.targetId === id);
    expect(row).toBeDefined();
    expect(JSON.parse(row?.metadataJson ?? "{}")).toEqual({ from: "0.8.0", to: RELEASE_VERSION, forced: false });
  });

  it("reaches a HELD node — the case this route exists for", async () => {
    // A node the plane refuses for its version is offline for every other
    // purpose. Being able to update it from a browser is the whole point of
    // holding the socket instead of closing it.
    useFakeRelease();
    const id = await mkAgent();
    const { res, cmd } = await updateWithAnswer(id, aliceCookie, {}, { ok: true }, "held");
    expect(res.status).toBe(202);
    expect(cmd.type).toBe("update");
  });

  it("passes force through, and the audit row records it", async () => {
    useFakeRelease();
    const id = await mkAgent();
    const { res, cmd } = await updateWithAnswer(id, aliceCookie, { force: true }, { ok: true });
    expect(res.status).toBe(202);
    expect(cmd.force).toBe(true);
    const rows = await new AuditRepository(db).listLatest(20);
    const row = rows.find((r) => r.action === "node.update" && r.targetId === id);
    expect(JSON.parse(row?.metadataJson ?? "{}").forced).toBe(true);
  });

  /**
   * A TIMEOUT is the one failure that may not be one, and it leaves a row of
   * its own.
   *
   * Every other refusal here is the agent SAYING it did nothing. A timeout is
   * the agent saying nothing at all — and this command's deadline contains a
   * ~70 MB download, so a node on a slow link installs the binary, restarts,
   * and comes back on the new version while this request answers 409. Without
   * the row, a real binary replacement would have no audit trail and an error
   * on the admin's screen; with it, "why is that machine on a version nothing
   * recorded" has an answer.
   *
   * Its own action name, because `node.update` and "nobody knows" are two
   * different claims and a reader must not have to guess which one a row is.
   */
  it("records node.update.unknown when the agent never answers", async () => {
    useFakeRelease();
    const id = await mkAgent();
    const sock = goOnline(id);
    const record = getLive(id);
    if (!record) throw new Error("no connection record");
    const resP = req("POST", `/api/nodes/${id}/update`, { cookie: aliceCookie, body: {} });
    await waitFor(() => sock.sent.length > 0, "update command on the wire");
    // The deadline firing, without waiting five real minutes for it.
    expect(failConnPendings(record, "timeout", "the node did not answer in time")).toBe(1);
    const res = await resP;
    expect(res.status).toBe(409);

    const rows = await new AuditRepository(db).listLatest(20);
    expect(rows.find((r) => r.action === "node.update" && r.targetId === id)).toBeUndefined();
    const unknown = rows.find((r) => r.action === "node.update.unknown" && r.targetId === id);
    expect(unknown).toBeDefined();
    expect(JSON.parse(unknown?.metadataJson ?? "{}")).toEqual({
      from: "0.8.0",
      to: RELEASE_VERSION,
      forced: false,
    });
    // And no token in it, like every other row this route writes.
    expect(unknown?.metadataJson ?? "").not.toContain("nut_");
  });

  it("writes NO unknown row for a refusal the agent actually spoke", async () => {
    // The distinction the extra action name exists to keep: an agent that said
    // "not supervised" did nothing, and a row claiming its state is unknown
    // would be worse than no row at all.
    useFakeRelease();
    const id = await mkAgent();
    const { res } = await updateWithAnswer(id, aliceCookie, {}, { ok: false, error: NODE_RESULT_NOT_SUPERVISED });
    expect(res.status).toBe(409);
    const rows = await new AuditRepository(db).listLatest(20);
    expect(rows.find((r) => r.action === "node.update.unknown" && r.targetId === id)).toBeUndefined();
  });

  // ── every refusal the AGENT raises, mapped by `detail` equality ──────────

  it("maps each of the agent's own refusals onto its own code", async () => {
    useFakeRelease();
    const cases: { error: string; code: string }[] = [
      { error: NODE_RESULT_NOT_SUPERVISED, code: "NODE_NOT_SUPERVISED" },
      { error: NODE_RESULT_KILLS_PANES, code: "NODE_RESTART_KILLS_PANES" },
      { error: NODE_RESULT_NOT_COMPILED, code: "NODE_UPDATE_FAILED" },
      { error: NODE_RESULT_DOWNLOAD_FAILED, code: "NODE_UPDATE_FAILED" },
      { error: NODE_RESULT_DIGEST_MISMATCH, code: "NODE_UPDATE_FAILED" },
      { error: NODE_RESULT_VERSION_MISMATCH, code: "NODE_UPDATE_FAILED" },
      // Anything the route does not recognize is a failure rather than a guess.
      { error: "the disk is full", code: "NODE_UPDATE_FAILED" },
    ];
    for (const c of cases) {
      const id = await mkAgent();
      const { res } = await updateWithAnswer(id, aliceCookie, {}, { ok: false, error: c.error });
      expect(res.status).toBe(409);
      expect(await codeOf(res)).toBe(c.code);
      resetNodeRegistryForTests();
    }
  });

  it("an agent too old to know the command answers `unsupported` → NODE_AGENT_TOO_OLD, naming the CLI verb", async () => {
    // The ordinary answer from exactly the machines this feature is for: an
    // agent below the floor has no `update` executor at all, and the only
    // remedy left is somebody typing at that keyboard.
    useFakeRelease();
    const id = await mkAgent();
    const { res } = await updateWithAnswer(id, aliceCookie, {}, { ok: false, error: "unsupported" }, "held");
    expect(res.status).toBe(409);
    const err = (await res.json()) as { code: string; message: string };
    expect(err.code).toBe("NODE_AGENT_TOO_OLD");
    expect(err.message).toContain("subshell update");
  });

  it("says whether panes WOULD die or nobody could tell, in the wording and never the code", async () => {
    // The agent sends one string for `kills` and `unknown`, because its
    // destructive verbs fail closed on a definition they could not read. Only
    // the plane can tell the two apart, and telling someone their panes will
    // die when nobody could tell is how warnings get ignored.
    useFakeRelease();
    const unknown: NodeRuntimeReport = { ...runtime, service: { ...runtime.service, paneSafety: "unknown" } };
    const id = await mkAgent();
    const { res } = await updateWithAnswer(
      id,
      aliceCookie,
      {},
      { ok: false, error: NODE_RESULT_KILLS_PANES },
      "live",
      unknown,
    );
    expect(await codeOf(res)).toBe("NODE_RESTART_KILLS_PANES");
    resetNodeRegistryForTests();

    const id2 = await mkAgent();
    const second = await updateWithAnswer(id2, aliceCookie, {}, { ok: false, error: NODE_RESULT_KILLS_PANES });
    expect(((await second.res.json()) as { message: string }).message).toContain("would close every subshell");
  });
});
