import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { BackendErrorCodes } from "@internal/backend-errors";
import { NODE_RESULT_SSH_GENERATION_STALE } from "@internal/subshell-protocol";
import { hashPassword } from "better-auth/crypto";
import { Elysia } from "elysia";
/**
 * The REAL Gate B hooks (`ssh-pane-hooks.ts`) against a scripted node - the
 * composition the gate tests could only script around. What this suite pins:
 *
 * 1. `sendManagedInput` dispatches the ORDINARY `input` verb carrying the
 *    EXACT `inputGeneration` the service froze; a node answering the frozen
 *    stale spelling is refused (403 SSH_ACCESS_DENIED) and the Enter frame is
 *    never sent - the write never reaches an unstamped/ordinary path.
 * 2. `applyControlTransition` dispatches `ssh_input_control` with the RAISED
 *    generation (takeover through the real `POST /:id/ssh-control` route).
 * 3. `restartManagedPane` dispatches `ssh_terminal_launch` (never a plain
 *    `launch`) built from the stored connection snapshot, returns the socket,
 *    and a missing `ssh_panes`/connection row refuses (no local-shell fallback).
 * 4. An ordinary pane still takes input byte-identically: two unstamped `input`
 *    frames and NO `ssh_*` traffic - the hooks are consulted for managed
 *    panes only (the deny default for managed acts stays pinned by the gate
 *    suite; this suite proves the EFFECT half).
 *
 * The policy installed here is the same dumb per-surface table as the gate
 * suite (grant math is D's own suite): this file's subject is the hooks.
 */
import { subshellRoutes } from "@/api/subshells/index.js";
import { db } from "@/db/index.js";
import { NodesRepository } from "@/db/repositories/nodes.repository.js";
import { SubshellsRepository } from "@/db/repositories/subshells.repository.js";
import { UsersRepository } from "@/db/repositories/users.repository.js";
import { errorHandlerPlugin } from "@/plugins/error-handler.plugin.js";
import { resetNodeRegistryForTests } from "@/services/nodes/node-registry.js";
import { DENY_EVERYTHING_SSH_POLICY, setSshPaneHooksForTests, setSshPolicyForTests } from "@/services/pane-ssh-gate.js";
import { SshConnectionsRepository } from "@/services/ssh/ssh-connections.repository.js";
import { sshPaneHooks } from "@/services/ssh/ssh-pane-hooks.js";
import type { SshPolicy } from "@/services/ssh/ssh-policy.js";
import { issueSubshellToken } from "@/services/subshell-tokens.js";
import { attachScriptedNode, ok, type ScriptedHandler, type ScriptedNode } from "@/test-helpers/scripted-node.js";
import { deleteUserByEmailOrId, setupAuthTables, signIn } from "../../../api/__tests__/helpers/auth-tables.js";

const app = new Elysia().use(errorHandlerPlugin).use(subshellRoutes);

const nodes = new NodesRepository(db);
const subshells = new SubshellsRepository(db);
const connections = new SshConnectionsRepository(db);

/** A snapshot the WIRE grammar accepts (the scripted node re-parses every frame). */
const SNAPSHOT = {
  alias: "staging",
  host: "app-02.example.net",
  user: "deploy",
  port: 22,
  identityFiles: ["/home/deploy/.ssh/id_ed25519"],
  certificateFiles: [],
  authAgentSocket: null,
  knownHostsFiles: ["/home/deploy/.ssh/known_hosts"],
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

/** The per-surface allow table (the gate suite's shape; decisions are not this suite). */
function allowPolicy(): SshPolicy {
  return {
    ...DENY_EVERYTHING_SSH_POLICY,
    gatePaneSurface: async () => ({ allow: true }),
    gateHumanConfig: async () => ({ allow: true }),
  };
}

describe("the real SshPaneHooks on the node wire", () => {
  const ownerEmail = `hooks-owner-${crypto.randomUUID()}@subshell.local`;
  const pw = "hooks-pass-1";
  let ownerId: string;
  let ownerCookie: string;

  let node: string;
  let sim: ScriptedNode;
  let inputAnswer: ScriptedHandler;
  const cleanup: Array<() => Promise<void>> = [];

  /** A RUNNING terminal row on the scripted agent node. */
  async function seedPane(name: string, over: { controlGeneration?: number } = {}): Promise<string> {
    const id = crypto.randomUUID();
    await subshells.create({
      id,
      userId: ownerId,
      harnessId: "terminal",
      name,
      workingDir: "/tmp",
      tmuxSocket: `sock-${id.slice(0, 8)}`,
      nodeId: node,
      status: "running",
      alive: 1,
      startedAt: "2026-10-05T00:00:00.000Z",
    });
    const conn = await connections.create({
      id: crypto.randomUUID(),
      userId: ownerId,
      nodeId: node,
      displayName: "hooks-conn",
      configSnapshot: JSON.stringify(SNAPSHOT),
      remoteDir: null,
      revision: 1,
    });
    await db
      .insertInto("sshPanes")
      .values({
        subshellId: id,
        connectionId: conn.id,
        connectionRevision: 1,
        initiatedBy: "human",
        grantId: null,
        apiKeyId: null,
        controlOwner: "agent",
        controlGeneration: over.controlGeneration ?? 1,
        logGeneration: 1,
        createdAt: new Date().toISOString(),
      })
      .execute();
    cleanup.push(async () => {
      await db.deleteFrom("sshPanes").where("subshellId", "=", id).execute();
      await db.deleteFrom("sshConnections").where("id", "=", conn.id).execute();
      await db.deleteFrom("subshells").where("id", "=", id).execute();
    });
    return id;
  }

  /** An ordinary pane: the subshell row only, no `ssh_panes` marker. */
  async function seedOrdinary(name: string): Promise<string> {
    const id = crypto.randomUUID();
    await subshells.create({
      id,
      userId: ownerId,
      harnessId: "terminal",
      name,
      workingDir: "/tmp",
      tmuxSocket: `sock-${id.slice(0, 8)}`,
      nodeId: node,
      status: "running",
      alive: 1,
      startedAt: "2026-10-05T00:00:00.000Z",
    });
    cleanup.push(async () => {
      await db.deleteFrom("subshells").where("id", "=", id).execute();
    });
    return id;
  }

  function headers(cookie?: string, bearer?: string): Headers {
    const h = new Headers({ "content-type": "application/json" });
    if (cookie) h.set("cookie", `better-auth.session_token=${cookie}`);
    if (bearer) h.set("authorization", `Bearer ${bearer}`);
    return h;
  }

  async function call(
    path: string,
    opts: { method?: string; body?: unknown; cookie?: string | null; bearer?: string } = {},
  ): Promise<Response> {
    let cookie: string | undefined = opts.cookie ?? ownerCookie;
    if (opts.bearer || opts.cookie === null) cookie = undefined;
    return app.fetch(
      new Request(`http://localhost:3080/api/subshells${path}`, {
        method: opts.method ?? "GET",
        headers: headers(cookie, opts.bearer),
        ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
      }),
    );
  }

  beforeAll(async () => {
    await setupAuthTables();
    ownerId = await new UsersRepository(db).createUser({
      email: ownerEmail,
      passwordHash: await hashPassword(pw),
      name: "Hooks Owner",
      role: "user",
    });
    ownerCookie = await signIn(ownerEmail, pw);
    node = crypto.randomUUID();
    await nodes.create({ id: node, ownerUserId: ownerId, name: `hooks-${node.slice(0, 8)}`, kind: "agent" });
  });

  afterAll(async () => {
    resetNodeRegistryForTests();
    await deleteUserByEmailOrId(ownerEmail);
  });

  beforeEach(() => {
    inputAnswer = ok;
    setSshPolicyForTests(allowPolicy());
    // THE REAL HOOKS under test (the gate suite swaps these for recorders).
    setSshPaneHooksForTests(sshPaneHooks);
    sim = attachScriptedNode(node, {
      input: (cmd) => inputAnswer(cmd),
      ssh_input_control: (cmd) =>
        cmd.type === "ssh_input_control"
          ? { subshellId: cmd.subshellId, mode: cmd.mode, generation: cmd.generation }
          : new Error("wrong cmd"),
      ssh_terminal_launch: ok,
      terminate: ok,
      kill: ok,
    });
  });

  afterEach(async () => {
    setSshPolicyForTests(null);
    setSshPaneHooksForTests(null);
    sim.detach();
    resetNodeRegistryForTests();
    for (const fn of cleanup.splice(0).reverse()) await fn().catch(() => {});
  });

  describe("sendManagedInput", () => {
    it("stamps EVERY frame with the exact frozen generation (text + Enter, two frames)", async () => {
      const pane = await seedPane("hooks-input", { controlGeneration: 3 });
      const res = await call(`/${pane}/input`, { method: "POST", body: { text: "ls" } });
      expect(res.status).toBe(200);
      const frames = sim.cmdsOf("input");
      expect(frames.length).toBe(2);
      expect(frames[0]).toEqual({ type: "input", subshellId: pane, data: "ls", inputGeneration: 3 });
      expect(frames[1]).toEqual({ type: "input", subshellId: pane, data: "\r", inputGeneration: 3 });
    });

    it("a node answering the frozen stale spelling refuses 403, and the Enter never goes out", async () => {
      const pane = await seedPane("hooks-input-stale", { controlGeneration: 4 });
      inputAnswer = () => new Error(NODE_RESULT_SSH_GENERATION_STALE);
      const res = await call(`/${pane}/input`, { method: "POST", body: { text: "ls", submit: true } });
      expect(res.status).toBe(403);
      expect(((await res.json()) as { code: string }).code).toBe(BackendErrorCodes.SSH_ACCESS_DENIED);
      // The refusal is the wire answer: exactly one stamped frame reached the
      // machine; the write never continued onto an ordinary (unstamped) path.
      const frames = sim.cmdsOf("input");
      expect(frames.length).toBe(1);
      expect(frames[0]?.inputGeneration).toBe(4);
      expect(sim.cmdTypes().filter((t) => t.startsWith("ssh_"))).toEqual([]);
    });
  });

  describe("applyControlTransition", () => {
    it("the takeover route dispatches ssh_input_control with the RAISED generation", async () => {
      const pane = await seedPane("hooks-control", { controlGeneration: 1 });
      const res = await call(`/${pane}/ssh-control`, { method: "POST", body: { mode: "human" } });
      expect(res.status).toBe(200);
      const view = (await res.json()) as { subshellId: string; controlOwner: string; controlGeneration: number };
      expect(view).toEqual({ subshellId: pane, controlOwner: "human", controlGeneration: 2 });
      expect(sim.cmdsOf("ssh_input_control")).toEqual([
        { type: "ssh_input_control", subshellId: pane, mode: "human", generation: 2 },
      ]);
      const row = await db.selectFrom("sshPanes").selectAll().where("subshellId", "=", pane).executeTakeFirstOrThrow();
      expect(row.controlOwner).toBe("human");
      expect(row.controlGeneration).toBe(2);
    });
  });

  describe("restartManagedPane", () => {
    it("re-launches over ssh_terminal_launch with the stored snapshot, never a plain shell launch", async () => {
      const pane = await seedPane("hooks-restart");
      const res = await call(`/${pane}/restart`, { method: "POST", body: {} });
      expect(res.status).toBe(200);
      const row = await subshells.findById(pane);
      const socket = row?.tmuxSocket ?? "";
      expect(socket).not.toBe("");
      expect(await res.json()).toEqual({ id: pane, tmuxSocket: socket, promptDelivered: false });
      const launches = sim.cmdsOf("ssh_terminal_launch");
      expect(launches.length).toBe(1);
      expect(launches[0]?.subshellId).toBe(pane);
      expect(launches[0]?.socket).toBe(socket);
      expect(launches[0]?.remoteDir).toBeNull();
      expect(launches[0]?.snapshot.host).toBe("app-02.example.net");
      expect(launches[0]?.snapshot.alias).toBe("staging");
      // The forbidden fallback: no harness `launch` frame, no local shell.
      expect(sim.countOf("launch")).toBe(0);
    });

    it("a pane whose ssh_panes marker is gone refuses - never a degraded relaunch", async () => {
      const pane = await seedPane("hooks-restart-nomarker");
      await db.deleteFrom("sshPanes").where("subshellId", "=", pane).execute();
      await expect(sshPaneHooks.restartManagedPane({ subshellId: pane })).rejects.toMatchObject({
        statusCode: 404,
        code: BackendErrorCodes.NOT_FOUND_ERROR,
      });
      expect(sim.countOf("ssh_terminal_launch")).toBe(0);
      expect(sim.countOf("launch")).toBe(0);
    });

    it("a marker whose connection row is gone refuses too", async () => {
      const pane = await seedPane("hooks-restart-noconn");
      const marker = await db
        .selectFrom("sshPanes")
        .select("connectionId")
        .where("subshellId", "=", pane)
        .executeTakeFirstOrThrow();
      await db.deleteFrom("sshConnections").where("id", "=", marker.connectionId).execute();
      await expect(sshPaneHooks.restartManagedPane({ subshellId: pane })).rejects.toMatchObject({
        statusCode: 404,
        code: BackendErrorCodes.NOT_FOUND_ERROR,
      });
      expect(sim.countOf("ssh_terminal_launch")).toBe(0);
    });
  });

  describe("ordinary panes are untouched by the hooks", () => {
    it("input to a non-managed pane stays byte-identical and triggers NO ssh_* command", async () => {
      const pane = await seedOrdinary("hooks-ordinary");
      const res = await call(`/${pane}/input`, { method: "POST", body: { text: "hi", submit: true } });
      expect(res.status).toBe(200);
      const frames = sim.cmdsOf("input");
      // The pre-SSH shape, verbatim: no generation member on either frame.
      expect(frames[0]).toEqual({ type: "input", subshellId: pane, data: "hi" });
      expect(frames[1]).toEqual({ type: "input", subshellId: pane, data: "\r" });
      expect("inputGeneration" in (frames[0] as object)).toBe(false);
      expect(sim.cmdTypes().filter((t) => t.startsWith("ssh_"))).toEqual([]);
      // The hooks' other doors refuse for ordinary panes too (managed-only):
      // a bearer cannot type through them, and ssh-control 404s the ordinary row.
      const sibling = await seedOrdinary("hooks-ordinary-sibling");
      const token = await issueSubshellToken(sibling, ownerId);
      const control = await call(`/${pane}/ssh-control`, { method: "POST", body: { mode: "human" }, bearer: token });
      expect(control.status).toBe(403);
    });
  });
});
