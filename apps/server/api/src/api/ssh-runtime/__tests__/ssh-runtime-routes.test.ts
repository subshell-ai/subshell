import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { SSH_RUNTIME_PROTOCOL } from "@internal/subshell-protocol";
import { hashPassword } from "better-auth/crypto";
import { Elysia } from "elysia";
import { ensureMigratedTestDb } from "@/__tests__/helpers/test-database.js";
import { deleteUserByEmailOrId, setupAuthTables, signIn } from "@/api/__tests__/helpers/auth-tables.js";
import { sshRuntimeRoutes } from "@/api/ssh-runtime/index.js";
import { db } from "@/db/index.js";
import { NodesRepository } from "@/db/repositories/nodes.repository.js";
import { PresetsRepository } from "@/db/repositories/presets.repository.js";
import { SubshellsRepository } from "@/db/repositories/subshells.repository.js";
import { UsersRepository } from "@/db/repositories/users.repository.js";
import { errorHandlerPlugin } from "@/plugins/error-handler.plugin.js";
import { resetNodeRegistryForTests } from "@/services/nodes/node-registry.js";
import { ensureLocalNode } from "@/services/nodes/seed-local.js";
import { SshRuntimeSessionsRepository } from "@/services/ssh-runtime/sessions.repository.js";
import { issueSubshellToken } from "@/services/subshell-tokens.js";
import { attachScriptedNode, type ScriptedNode } from "@/test-helpers/scripted-node.js";

/**
 * The widened auth of `/api/ssh-runtime` (workstream U; design 2026-10-05
 * §1/§7): this surface belongs to every signed-in HUMAN acting on their OWN
 * machines and their OWN sessions. The rules this suite pins:
 *
 * - A plain member (NOT admin) who owns the connecting node reaches the whole
 *   family: discovery, resolve, open, list, detail, by-pane identity, close.
 * - Ownership is REAL ownership, no admin shortcut and no share: an admin who
 *   does not own the node and a foreign member get the SAME 404 (same code,
 *   same message - no enumeration oracle) for node-scoped and session-scoped
 *   acts, while their own lists answer 200 with their own (empty) rows.
 * - Machine credentials are refused outright on the family: a bearer 403s at
 *   every endpoint (there is no MCP door for this surface yet).
 * - `by-pane` identity is the session owner's read: an ordinary pane (and a
 *   foreign pane) reads the same 404.
 *
 * The node is the scripted agent on the real registry: the open really rides
 * `sendCommand`, the hello really parses, and the session really settles
 * active, so the member-owner path is proven through the production door and
 * not around it.
 */

const app = new Elysia().use(errorHandlerPlugin).use(sshRuntimeRoutes);

const nodes = new NodesRepository(db);
const subshells = new SubshellsRepository(db);

const memberEmail = `rtmember-${crypto.randomUUID()}@subshell.local`;
const foreignEmail = `rtforeign-${crypto.randomUUID()}@subshell.local`;
const adminEmail = `rtadmin-${crypto.randomUUID()}@subshell.local`;
const pw = "rtroute-pass-1";
let memberId: string;
let memberCookie: string;
let foreignId: string;
let foreignCookie: string;
let adminCookie: string;
let node = "";
let scripted: ScriptedNode;

/** One answer, read ONCE (a Response body is single-use; this holds both views). */
interface Answer {
  status: number;
  body: Record<string, unknown>;
}

async function call(path: string, init: RequestInit, opts: { cookie?: string; bearer?: string } = {}): Promise<Answer> {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json");
  headers.set("origin", "http://localhost:3080");
  if (opts.cookie) headers.set("cookie", `better-auth.session_token=${opts.cookie}`);
  if (opts.bearer) headers.set("authorization", `Bearer ${opts.bearer}`);
  const res = await app.fetch(new Request(`http://localhost:3080${path}`, { ...init, headers }));
  const text = await res.text();
  let body: Record<string, unknown> = {};
  try {
    body = text === "" ? {} : (JSON.parse(text) as Record<string, unknown>);
  } catch {
    body = { raw: text };
  }
  return { status: res.status, body };
}
const get = (path: string, opts: { cookie?: string; bearer?: string } = {}) => call(path, { method: "GET" }, opts);
const post = (path: string, body: unknown, opts: { cookie?: string; bearer?: string } = {}) =>
  call(path, { method: "POST", body: JSON.stringify(body) }, opts);

/** The refusal's identity: everything the no-oracle claim is about, minus the per-occurrence errId. */
function refusalOf(answer: Answer): string {
  const { status, body } = answer;
  return JSON.stringify({
    status,
    code: body.code,
    message: body.message,
    metadataSafe: body.metadataSafe ?? null,
  });
}

const HELLO = {
  type: "hello" as const,
  runtimeProtocol: SSH_RUNTIME_PROTOCOL,
  agentVersion: "1.5.0",
  os: "linux",
  arch: "x64",
  capabilities: [],
  homeDir: "/home/x",
  dataDir: "/home/x/.local/share/subshell/runtime",
  tmuxSocket: "subshell-ssh-ab12cd34ef56",
  paneCount: 0,
};

const SNAPSHOT = {
  alias: "rtbox",
  host: "10.9.8.7",
  user: "theo",
  port: 22,
  identityFiles: ["/home/x/.ssh/id_ed25519"],
  certificateFiles: [],
  knownHostsFiles: ["/home/x/.ssh/known_hosts"],
  authAgentSocket: null,
  hostKeyAlias: null,
  proxyJumps: [],
  proxyCommand: null,
  forwards: null,
  tunnels: null,
  localCommands: null,
  remoteCommand: null,
  sendEnv: null,
  setEnv: null,
  escapes: null,
};

/** The open body the wizard sends for the scripted destination. */
function openBody(): Record<string, unknown> {
  return {
    connectingNodeId: node,
    target: { alias: "rtbox", host: "10.9.8.7", port: 22, user: "theo", identityFile: "/home/x/.ssh/id_ed25519" },
  };
}

const cleanup: string[] = [];

beforeAll(async () => {
  await ensureMigratedTestDb();
  await setupAuthTables();
  resetNodeRegistryForTests();
  await ensureLocalNode(db);
  const users = new UsersRepository(db);
  memberId = await users.createUser({
    email: memberEmail,
    name: memberEmail,
    passwordHash: await hashPassword(pw),
    role: "user",
  });
  foreignId = await users.createUser({
    email: foreignEmail,
    name: foreignEmail,
    passwordHash: await hashPassword(pw),
    role: "user",
  });
  await users.createUser({ email: adminEmail, name: adminEmail, passwordHash: await hashPassword(pw), role: "admin" });
  memberCookie = await signIn(memberEmail, pw);
  foreignCookie = await signIn(foreignEmail, pw);
  adminCookie = await signIn(adminEmail, pw);

  node = crypto.randomUUID();
  cleanup.push(node);
  await nodes.create({ id: node, ownerUserId: memberId, name: `rt-${node.slice(0, 8)}`, kind: "agent" });
  scripted = attachScriptedNode(node, {
    ssh_discover_aliases: () => ({ aliases: ["rtbox", "other"], includeCycle: false, truncated: false }),
    ssh_resolve_config: () => ({ accepted: true, snapshot: SNAPSHOT, connectingAccount: "x" }),
    ssh_session_open: (cmd) => {
      if (cmd.type !== "ssh_session_open") throw new Error("wrong cmd");
      return { hello: HELLO, host: cmd.target.host, port: cmd.target.port, user: cmd.target.user };
    },
    ssh_session_send: () => undefined,
    ssh_session_close: () => ({ state: "closed" }),
  });
});

afterAll(async () => {
  scripted.detach();
  for (const id of cleanup)
    await db
      .deleteFrom("nodes")
      .where("id", "=", id)
      .execute()
      .catch(() => {});
  await deleteUserByEmailOrId(memberEmail).catch(() => {});
  await deleteUserByEmailOrId(foreignEmail).catch(() => {});
  await deleteUserByEmailOrId(adminEmail).catch(() => {});
});

describe("the member-owner door (the widening)", () => {
  it("lists sessions for a NON-admin member (200, own rows)", async () => {
    const res = await get("/api/ssh-runtime/sessions", { cookie: memberCookie });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.sessions).toEqual([]);
  });

  it("discovers aliases on the caller's own node", async () => {
    const res = await get(`/api/ssh-runtime/discovery?nodeId=${node}`, { cookie: memberCookie });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.aliases).toEqual(["rtbox", "other"]);
  });

  it("resolves an alias into reviewable destination facts", async () => {
    const res = await post("/api/ssh-runtime/resolve", { nodeId: node, alias: "rtbox" }, { cookie: memberCookie });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.accepted).toBe(true);
    expect(res.body.connectingAccount).toBe("x");
  });

  it("opens a session through its own node and reads it back", async () => {
    const opened = await post("/api/ssh-runtime/sessions", openBody(), { cookie: memberCookie });
    expect(opened.status, JSON.stringify(opened.body)).toBe(200);
    const view = opened.body as unknown as { id: string; status: string; runtimeNodeId: string };
    expect(view.status).toBe("active");
    cleanup.push(view.runtimeNodeId);

    const list = await get("/api/ssh-runtime/sessions", { cookie: memberCookie });
    const sessions = list.body.sessions as { id: string }[];
    expect(sessions.map((s) => s.id)).toContain(view.id);

    const detail = await get(`/api/ssh-runtime/sessions/${view.id}`, { cookie: memberCookie });
    expect(detail.status).toBe(200);

    // An unknown pane reads the 404 like a foreign one (the hidden runtime
    // row is never listed; by-pane is the only door to its facts).
    const byPaneMissing = await get(`/api/ssh-runtime/sessions/by-pane/${crypto.randomUUID()}`, {
      cookie: memberCookie,
    });
    expect(byPaneMissing.status, "an unknown pane reads the 404 like a foreign one").toBe(404);

    // An ordinary pane on the runtime node answers the identity line from the
    // session row (server facts: host, port, user, connecting machine name).
    const paneId = crypto.randomUUID();
    await subshells.create({
      id: paneId,
      userId: memberId,
      harnessId: "terminal",
      name: "rt pane",
      workingDir: "/home/x",
      nodeId: view.runtimeNodeId,
      status: "running",
      alive: 1,
      tmuxSocket: `sock-${paneId}`,
      presetId: null,
    });
    const identity = await get(`/api/ssh-runtime/sessions/by-pane/${paneId}`, { cookie: memberCookie });
    expect(identity.status, JSON.stringify(identity.body)).toBe(200);
    expect(identity.body.sessionId).toBe(view.id);
    expect(identity.body.status).toBe("active");
    expect(identity.body.host).toBe("10.9.8.7");
    expect(identity.body.port).toBe(22);
    expect(identity.body.user).toBe("theo");
    expect(identity.body.connectingNodeName).toBe(`rt-${node.slice(0, 8)}`);

    // Closing the session is the owner's act; the row settles closed.
    const closed = await post(`/api/ssh-runtime/sessions/${view.id}/close`, {}, { cookie: memberCookie });
    expect(closed.status, JSON.stringify(closed.body)).toBe(200);
    const after = await get(`/api/ssh-runtime/sessions/${view.id}`, { cookie: memberCookie });
    expect(after.body.status).toBe("closed");
  }, 20_000);
});

describe("the harnesses family (cached mirror, detect, preset launch)", () => {
  let liveSessionId = "";
  let claudePresetId = "";

  beforeAll(async () => {
    const opened = await post("/api/ssh-runtime/sessions", openBody(), { cookie: memberCookie });
    expect(opened.status, JSON.stringify(opened.body)).toBe(200);
    const view = opened.body as unknown as { id: string; runtimeNodeId: string };
    liveSessionId = view.id;
    cleanup.push(view.runtimeNodeId);
    const preset = await new PresetsRepository(db).create({
      id: crypto.randomUUID(), // the repository does not mint ids; the create route does
      userId: memberId,
      harnessId: "claude-code",
      name: `rt-preset-${crypto.randomUUID().slice(0, 8)}`,
      description: null,
      envJson: JSON.stringify({ ANTHROPIC_MODEL: "route-test-model" }),
      flagsJson: JSON.stringify([]),
      settingsJson: null,
      configIsolation: 0,
    });
    claudePresetId = preset.id;
  }, 20_000);

  // The close rides the 15 s command deadline against the scripted node (the
  // sibling tests budget the same); the hook default would time it out.
  afterAll(async () => {
    if (liveSessionId !== "")
      await post(`/api/ssh-runtime/sessions/${liveSessionId}/close`, {}, { cookie: memberCookie });
    if (claudePresetId !== "")
      await db
        .deleteFrom("presets")
        .where("id", "=", claudePresetId)
        .execute()
        .catch(() => {});
  }, 30_000);

  it("owner reads the cached mirror (empty on a fresh destination, online true)", async () => {
    const res = await get(`/api/ssh-runtime/sessions/${liveSessionId}/harnesses`, { cookie: memberCookie });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.sessionId).toBe(liveSessionId);
    expect(res.body.online).toBe(true);
    expect(res.body.harnesses).toEqual([]);
    expect(res.body.env).toEqual({});
  });

  it("detect names its refusal: a runtime without the capability answers 409 detect_unsupported", async () => {
    const res = await post(`/api/ssh-runtime/sessions/${liveSessionId}/harnesses/detect`, {}, { cookie: memberCookie });
    // The service refuses 409 (the capability fact); the house SSH-refusal
    // convention renders destination refusals on the wire as 403 with the
    // named sshCode (spec 23 pins the same shape for runtime_missing).
    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body.metadataSafe).toEqual({ sshCode: "detect_unsupported" });
  });

  it("launch-harness refuses bad input BEFORE any row is written (unknown harness 409, foreign preset 404, mismatch 409)", async () => {
    const unknown = await post(
      `/api/ssh-runtime/sessions/${liveSessionId}/launch-harness`,
      { harnessId: "not-a-harness", cwd: "/home/x" },
      { cookie: memberCookie },
    );
    // 403 like every named refusal on this family (the flat mapper, module doc).
    expect(unknown.status, JSON.stringify(unknown.body)).toBe(403);

    const foreignPreset = await post(
      `/api/ssh-runtime/sessions/${liveSessionId}/launch-harness`,
      { harnessId: "claude-code", presetId: crypto.randomUUID(), cwd: "/home/x" },
      { cookie: memberCookie },
    );
    expect(foreignPreset.status, JSON.stringify(foreignPreset.body)).toBe(404);

    // A claude preset on the TERMINAL harness: same shape as the manager's
    // create door ("Preset harness mismatch"), and nothing was written.
    const mismatch = await post(
      `/api/ssh-runtime/sessions/${liveSessionId}/launch-harness`,
      { harnessId: "terminal", presetId: claudePresetId, cwd: "/home/x" },
      { cookie: memberCookie },
    );
    expect(mismatch.status, JSON.stringify(mismatch.body)).toBe(403);

    const sessionRow = await new SshRuntimeSessionsRepository(db).findById(liveSessionId);
    const panes = await db
      .selectFrom("subshells")
      .selectAll()
      .where("userId", "=", memberId)
      .where("nodeId", "=", sessionRow?.runtimeNodeId ?? "no-such-node")
      .execute();
    expect(sessionRow, "the session row exists for the node id the panes must not have").not.toBeNull();
    expect(panes.length).toBe(0);
  });

  it("foreign member and non-owning admin answer the same 404 on all three verbs", async () => {
    const probes: Promise<Answer>[] = [
      get(`/api/ssh-runtime/sessions/${liveSessionId}/harnesses`, { cookie: foreignCookie }),
      post(`/api/ssh-runtime/sessions/${liveSessionId}/harnesses/detect`, {}, { cookie: foreignCookie }),
      post(
        `/api/ssh-runtime/sessions/${liveSessionId}/launch-harness`,
        { harnessId: "claude-code", cwd: "/home/x" },
        { cookie: foreignCookie },
      ),
    ];
    const byAdmin: Promise<Answer>[] = [
      get(`/api/ssh-runtime/sessions/${liveSessionId}/harnesses`, { cookie: adminCookie }),
      post(`/api/ssh-runtime/sessions/${liveSessionId}/harnesses/detect`, {}, { cookie: adminCookie }),
      post(
        `/api/ssh-runtime/sessions/${liveSessionId}/launch-harness`,
        { harnessId: "claude-code", cwd: "/home/x" },
        { cookie: adminCookie },
      ),
    ];
    const f = await Promise.all(probes);
    const a = await Promise.all(byAdmin);
    for (let i = 0; i < 3; i++) {
      expect(f[i]?.status).toBe(404);
      expect(a[i]?.status).toBe(404);
      expect(refusalOf(a[i] as Answer)).toBe(refusalOf(f[i] as Answer));
    }
  });
});

describe("no-oracle refusals (foreign 404, admin-without-ownership 404)", () => {
  it("refuses node-scoped acts identically for an admin without ownership and a foreign member", async () => {
    const byAdmin = await get(`/api/ssh-runtime/discovery?nodeId=${node}`, { cookie: adminCookie });
    const byForeign = await get(`/api/ssh-runtime/discovery?nodeId=${node}`, { cookie: foreignCookie });
    expect(byAdmin.status).toBe(404);
    expect(byForeign.status).toBe(404);
    expect(refusalOf(byAdmin)).toBe(refusalOf(byForeign));
    // The admin's OWN surface stays theirs: the empty list answers 200, so the
    // 404 above is invisibility of someone else's machine, not a locked page.
    const adminList = await get("/api/ssh-runtime/sessions", { cookie: adminCookie });
    expect(adminList.status).toBe(200);
  });

  it("refuses open identically (no ownership oracle) and foreign session reads 404", async () => {
    // Open a member session to have a foreign id to aim at.
    const opened = await post("/api/ssh-runtime/sessions", openBody(), { cookie: memberCookie });
    expect(opened.status).toBe(200);
    const view = opened.body as unknown as { id: string; runtimeNodeId: string };
    cleanup.push(view.runtimeNodeId);

    const byAdmin = await post("/api/ssh-runtime/sessions", openBody(), { cookie: adminCookie });
    const byForeign = await post("/api/ssh-runtime/sessions", openBody(), { cookie: foreignCookie });
    expect(byAdmin.status).toBe(404);
    expect(byForeign.status).toBe(404);
    expect(refusalOf(byAdmin)).toBe(refusalOf(byForeign));

    expect((await get(`/api/ssh-runtime/sessions/${view.id}`, { cookie: foreignCookie })).status).toBe(404);
    expect((await post(`/api/ssh-runtime/sessions/${view.id}/close`, {}, { cookie: foreignCookie })).status).toBe(404);
    expect(
      (await post(`/api/ssh-runtime/sessions/${view.id}/list-dirs`, { path: "" }, { cookie: foreignCookie })).status,
    ).toBe(404);
    // by-pane for a FOREIGN pane: the session owner cannot read another
    // account's identity line (and cannot tell the row exists).
    const foreignPane = crypto.randomUUID();
    await subshells.create({
      id: foreignPane,
      userId: foreignId,
      harnessId: "terminal",
      name: "foreign pane",
      workingDir: "/home/y",
      nodeId: view.runtimeNodeId,
      status: "running",
      alive: 1,
      tmuxSocket: `sock-${foreignPane}`,
      presetId: null,
    });
    expect((await get(`/api/ssh-runtime/sessions/by-pane/${foreignPane}`, { cookie: memberCookie })).status).toBe(404);

    // Clean up the surviving session so the registry holds nothing for teardown.
    const closed = await post(`/api/ssh-runtime/sessions/${view.id}/close`, {}, { cookie: memberCookie });
    expect(closed.status, JSON.stringify(closed.body)).toBe(200);
  }, 20_000);
});

describe("machine credentials stay refused on the whole family", () => {
  let bearer = "";
  beforeAll(async () => {
    const paneId = crypto.randomUUID();
    await subshells.create({
      id: paneId,
      userId: memberId,
      harnessId: "claude-code",
      name: "rt bearer probe",
      workingDir: "/srv",
      nodeId: node,
      status: "running",
      alive: 1,
      tmuxSocket: `sock-${paneId}`,
      presetId: null,
    });
    bearer = await issueSubshellToken(paneId, memberId);
  });

  it("403s every endpoint of the family, before any ownership read", async () => {
    const probes: Promise<Answer>[] = [
      get("/api/ssh-runtime/sessions", { bearer }),
      get(`/api/ssh-runtime/discovery?nodeId=${node}`, { bearer }),
      post("/api/ssh-runtime/resolve", { nodeId: node, alias: "rtbox" }, { bearer }),
      post("/api/ssh-runtime/sessions", openBody(), { bearer }),
      get("/api/ssh-runtime/sessions/whatever", { bearer }),
      post("/api/ssh-runtime/sessions/whatever/close", {}, { bearer }),
      post("/api/ssh-runtime/sessions/whatever/list-dirs", { path: "" }, { bearer }),
      post("/api/ssh-runtime/sessions/whatever/launch-terminal", { cwd: "/" }, { bearer }),
      get(`/api/ssh-runtime/sessions/by-pane/${crypto.randomUUID()}`, { bearer }),
      get("/api/ssh-runtime/sessions/whatever/harnesses", { bearer }),
      post("/api/ssh-runtime/sessions/whatever/harnesses/detect", {}, { bearer }),
      post("/api/ssh-runtime/sessions/whatever/launch-harness", { harnessId: "claude-code", cwd: "/" }, { bearer }),
    ];
    for (const probe of probes) {
      const answer = await probe;
      expect(answer.status, JSON.stringify(answer.body)).toBe(403);
    }
  });
});
