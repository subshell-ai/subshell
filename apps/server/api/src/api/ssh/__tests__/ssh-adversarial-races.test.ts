import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
  NODE_RESULT_SSH_GENERATION_STALE,
  type NodeCommandBody,
  SSH_OUTPUT_WINDOW_MAX_BYTES,
  SSH_READ_LONG_POLL_MAX_MS,
} from "@internal/subshell-protocol";
import { hashPassword } from "better-auth/crypto";
import { Elysia } from "elysia";

/**
 * WORKSTREAM G (Wave 2) - the §6 matrix "Races" rows the per-branch suites
 * could not see end to end (SSH-SUPPORT.md §2 "Revocation prevents new
 * dispatch, rejects queued input, closes affected streams, and cancels
 * runs/terminals initiated under that grant where reachable"; §3 takeover
 * fencing), plus the Grants-row case no suite names yet (disabled account)
 * and the server→node resource-bound clamps (spec §3's limits table).
 * The Gate C fix wave joined: revocation now also CLOSES the managed pane's
 * live attach sockets and TERMINATES its live terminals (reachable now, or
 * retired with the reconnect census as the pending kill offline) - the
 * "active streams" and "terminals where reachable" race rows are pinned here.
 *
 * The race machinery: the scripted node's `input` handler returns a promise
 * the test resolves later, so the WRITE is genuinely in flight on the wire
 * while the revocation or takeover lands - the frozen input generation the
 * plane stamped is then stale by the time the machine answers. The node's
 * answer is matched by EQUALITY on the frozen
 * {@link NODE_RESULT_SSH_GENERATION_STALE} spelling (AGENTS.md: node refusals
 * map by equality), and the refusal must arrive as the named 403 - while the
 * QUEUED SECOND frame (the submit Enter) never goes out at all: the plane's
 * send loop stops at the first refusal, which is the whole "rejects queued
 * input" sentence seen from the plane side. The node-side fence store for the
 * same race is the agent suite (`input-generation-fence.test.ts`); nobody
 * until now drove the plane's handling of a machine that refused mid-write.
 */
import { sshRoutes } from "@/api/ssh/index.js";
import { subshellRoutes } from "@/api/subshells/index.js";
import { db } from "@/db/index.js";
import { NodesRepository } from "@/db/repositories/nodes.repository.js";
import { PresetsRepository } from "@/db/repositories/presets.repository.js";
import { SubshellsRepository } from "@/db/repositories/subshells.repository.js";
import { UserMetaRepository } from "@/db/repositories/user-meta.repository.js";
import { UsersRepository } from "@/db/repositories/users.repository.js";
import { errorHandlerPlugin } from "@/plugins/error-handler.plugin.js";
import { resetNodeRegistryForTests } from "@/services/nodes/node-registry.js";
import { ensureLocalNode } from "@/services/nodes/seed-local.js";
import { setSshPaneHooksForTests, setSshPolicyForTests } from "@/services/pane-ssh-gate.js";
import { SshConnectionsRepository } from "@/services/ssh/ssh-connections.repository.js";
import { sshRevoke } from "@/services/ssh/ssh-grants.service.js";
import { sshPaneHooks } from "@/services/ssh/ssh-pane-hooks.js";
import type { SshCaller } from "@/services/ssh/ssh-policy.js";
import { getSshPolicy } from "@/services/ssh/ssh-policy-impl.js";
import { SubshellManagerService } from "@/services/subshell-manager.service.js";
import { issueSubshellToken } from "@/services/subshell-tokens.js";
import { attachScriptedNode, ok, type ScriptedHandlers, type ScriptedNode } from "@/test-helpers/scripted-node.js";
import { facts, readResult, SNAPSHOT } from "@/test-helpers/ssh-fixtures.js";
import { registerViewer, resetLiveViewersForTests, type WsSocket } from "@/ws/viewers.js";
import { deleteUserByEmailOrId, setupAuthTables, signIn } from "../../__tests__/helpers/auth-tables.js";

const app = new Elysia().use(errorHandlerPlugin).use(subshellRoutes).use(sshRoutes);

const nodes = new NodesRepository(db);
const subshells = new SubshellsRepository(db);
const connections = new SshConnectionsRepository(db);

const ownerEmail = `sshrace-owner-${crypto.randomUUID()}@subshell.local`;
const pw = "sshrace-pass-1";
let ownerId: string;
let ownerCookie: string;
let node: string;
let connId: string;

/** The pending `input` frame: the handler resolves only when the test says so. */
let holdInput: ((v: unknown) => void) | null = null;
let rejectInput: ((e: Error) => void) | null = null;
/**
 * The `ssh_input_control` arrival observer (ordering tests): called with the
 * frame the moment the machine RECEIVES the transition dispatch, so a test
 * can inspect plane-side state (a viewer's close, for one) from inside the
 * RPC window - the exact span the revocation ordering must not leave open.
 */
let observeInputControl: ((cmd: NodeCommandBody) => void) | null = null;
let scripted: ScriptedNode;

/** Wait until the machine has RECEIVED `n` input frames for `managed` (the write is on the wire). */
async function waitInputFrames(managed: string, n: number): Promise<void> {
  for (let i = 0; i < 400; i++) {
    if (scripted.cmdsOf("input").filter((c) => c.subshellId === managed).length >= n) return;
    await Bun.sleep(5);
  }
  throw new Error(`no ${n} input frames for ${managed} reached the wire`);
}

function fetchAs(path: string, method: string, auth: { cookie?: string; token?: string }, body?: unknown) {
  const headers = new Headers({ "content-type": "application/json", origin: "http://localhost:3080" });
  if (auth.cookie !== undefined) headers.set("cookie", `better-auth.session_token=${auth.cookie}`);
  if (auth.token !== undefined) headers.set("authorization", `Bearer ${auth.token}`);
  return app.fetch(
    new Request(`http://localhost:3080${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
}

function ownerCaller(): SshCaller {
  return {
    actor: "cookie",
    userId: ownerId,
    principal: `user:${ownerId}`,
    apiKeyId: null,
    subshellId: null,
    isAdmin: false,
  };
}

/**
 * The scripted agent's answer table, hoisted so the offline-cancellation case
 * can detach it (node down) and re-attach the identical agent (node back).
 * `kill` is the revocation-terminate frame (the manager's teardown verb);
 * the `input` handler is the in-flight race machinery (`holdInput`).
 */
function scriptedHandlers(): ScriptedHandlers {
  return {
    input: () =>
      new Promise((resolve, reject) => {
        if (holdInput !== null || rejectInput !== null) return resolve(undefined); // not held: answer ok
        holdInput = resolve;
        rejectInput = reject;
      }),
    ssh_terminal_launch: ok,
    kill: ok,
    ssh_input_control: (cmd) => {
      observeInputControl?.(cmd);
      return cmd.type === "ssh_input_control"
        ? { subshellId: cmd.subshellId, mode: cmd.mode, generation: cmd.generation }
        : new Error("wrong cmd");
    },
    ssh_run_start: (cmd) =>
      cmd.type === "ssh_run_start" ? facts({ runId: cmd.runId, lifecycle: "running" }) : new Error("wrong cmd"),
    ssh_run_read: (cmd) => (cmd.type === "ssh_run_read" ? readResult(cmd.runId) : new Error("wrong cmd")),
    ssh_run_status: (cmd) =>
      cmd.type === "ssh_run_status" ? facts({ runId: cmd.runId, lifecycle: "running" }) : new Error("wrong cmd"),
  };
}

/** A minimal stand-in for one ATTACHED terminal socket, registrable in the viewer registry. */
function fakeViewerSocket(subshellId: string) {
  const closed: Array<{ code: number; reason: string }> = [];
  const ws = {
    data: { viewerId: crypto.randomUUID(), subshellId, canInput: true },
    send: () => undefined,
    close: (code?: number, reason?: string) => {
      closed.push({ code: code ?? 0, reason: reason ?? "" });
    },
  } as unknown as WsSocket;
  return { ws, closed };
}

async function json(res: Response) {
  return (await res.json()) as Record<string, unknown>;
}

describe("SSH races + disabled account + server-side bound clamps (spec 2026-10-04 §6)", () => {
  beforeAll(async () => {
    await setupAuthTables();
    resetNodeRegistryForTests();
    await ensureLocalNode(db);
    setSshPolicyForTests(getSshPolicy());
    setSshPaneHooksForTests(sshPaneHooks);

    const users = new UsersRepository(db);
    ownerId = await users.createUser({
      email: ownerEmail,
      name: ownerEmail,
      passwordHash: await hashPassword(pw),
      role: "user",
    });
    ownerCookie = await signIn(ownerEmail, pw);

    node = crypto.randomUUID();
    await nodes.create({
      id: node,
      ownerUserId: ownerId,
      name: `rc-${node.slice(0, 8)}`,
      kind: "agent",
      status: "online",
    });
    scripted = attachScriptedNode(node, scriptedHandlers());

    const conn = await connections.create({
      id: crypto.randomUUID(),
      userId: ownerId,
      nodeId: node,
      displayName: "Race",
      configSnapshot: JSON.stringify(SNAPSHOT),
      remoteDir: null,
    });
    connId = conn.id;
  });

  afterAll(() => {
    setSshPolicyForTests(null);
    setSshPaneHooksForTests(null);
    scripted.detach();
    resetNodeRegistryForTests();
    void deleteUserByEmailOrId(ownerEmail);
  });

  /** Fresh running pane + grant + managed terminal for one race case. */
  async function openWorld(): Promise<{ pane: string; token: string; managed: string }> {
    const pane = crypto.randomUUID();
    await subshells.create({
      id: pane,
      userId: ownerId,
      harnessId: "claude-code",
      name: `race-pane-${pane.slice(0, 6)}`,
      workingDir: "/srv",
      nodeId: node,
      status: "running",
      alive: 1,
      tmuxSocket: `sock-${pane}`,
      presetId: null,
    });
    const token = await issueSubshellToken(pane, ownerId);
    const grant = await fetchAs(
      `/api/ssh/connections/${connId}/grants`,
      "POST",
      { cookie: ownerCookie },
      { subshellId: pane },
    );
    expect(grant.status).toBe(200);
    const opened = await fetchAs("/api/ssh/terminals", "POST", { token }, { connectionId: connId });
    expect(opened.status).toBe(200);
    const managed = String((await json(opened)).subshellId);
    holdInput = null;
    rejectInput = null;
    observeInputControl = null;
    return { pane, token, managed };
  }

  describe("revoke vs queued input (matrix: Races - the machine refuses a mid-write revocation)", () => {
    it("an in-flight stamped input is answered the named 403, the queued Enter never goes out, and the pane re-reads as revoked", async () => {
      const { pane, token, managed } = await openWorld();
      const inputCall = fetchAs(`/api/subshells/${managed}/input`, "POST", { token }, { text: "whoami", submit: true });
      await waitInputFrames(managed, 1); // the stamped text frame is on the wire

      const revoked = await sshRevoke(ownerCaller(), connId, pane);
      expect(revoked.revoked).toBe(true);

      // The machine's answer, delayed past the revocation: the generation the
      // plane stamped is stale at the node.
      const reject = rejectInput;
      expect(reject).not.toBeNull();
      reject?.(new Error(NODE_RESULT_SSH_GENERATION_STALE));
      const res = await inputCall;
      expect(res.status).toBe(403);
      expect(((await json(res)) as { code: string }).code).toBe("SSH_ACCESS_DENIED");

      // The revocation fenced the pane at the machine (generation raised) and
      // the plane stopped at the refusal: the submit-Enter frame was NEVER sent.
      const inputFrames = scripted.cmdsOf("input").filter((c) => c.subshellId === managed);
      expect(inputFrames).toHaveLength(1);
      expect(inputFrames[0]?.type === "input" && inputFrames[0].inputGeneration === 1).toBe(true);
      expect(
        scripted
          .cmdsOf("ssh_input_control")
          .filter((c) => c.subshellId === managed)
          .every((c) => c.type === "ssh_input_control" && c.generation >= 2),
      ).toBe(true);

      // And the pane itself is now fenced for that credential: every read the
      // opening credential tries answers the named 403 (visible-but-refused),
      // and its next input refuses BEFORE the wire (no new frame).
      const before = scripted.wire.length;
      const detail = await fetchAs(`/api/subshells/${managed}`, "GET", { token });
      expect(detail.status).toBe(403);
      expect(await detail.text()).toContain("grant_revoked");
      expect(
        (await fetchAs(`/api/subshells/${managed}/input`, "POST", { token }, { text: "ls", submit: false })).status,
      ).toBe(403);
      expect(scripted.wire.length).toBe(before); // refused gates dispatch nothing
      // Gate C (CRITICAL 1): revocation does not merely fence - it cancels
      // the TERMINAL initiated under that grant where reachable. The kill is
      // the ordinary lifecycle teardown frame, and the row ends `terminated`
      // exactly like a human's own terminate.
      expect(scripted.countOf("kill")).toBe(1);
      const row = await subshells.findById(managed);
      expect(row?.status).toBe("terminated");
    });
  });

  describe("revoke vs active streams (matrix: Races - a live attach socket dies with the grant)", () => {
    it("the revocation closes every terminal socket streaming the managed pane, so the reconnect must pass the gate fresh", async () => {
      const { pane, managed } = await openWorld();
      // A viewer watching the managed terminal - registered exactly as both
      // attach paths register (keyed by viewerId), with the socket the
      // grant-authenticated attach left open.
      const viewer = fakeViewerSocket(managed);
      registerViewer(viewer.ws, managed);
      // THE ORDERING CONTRACT (re-review round 1): the close must land on the
      // same beat the plane's generation raise commits and BEFORE the
      // `ssh_input_control` dispatch - while a stamped writer is live, an
      // open socket reads the RAISED generation and the node's
      // equal-or-higher rule accepts it, so any live-socket window across
      // the raise->RPC span is §2 "prevents new dispatch" violated for that
      // span. The scripted agent answers the transition RPC from inside the
      // revocation, and the arrival observer sees the viewer's close state at
      // that exact instant: 1 close already recorded = closed first.
      const closesAtRpcArrival: number[] = [];
      observeInputControl = () => closesAtRpcArrival.push(viewer.closed.length);
      try {
        const revoked = await sshRevoke(ownerCaller(), connId, pane);
        expect(revoked.revoked).toBe(true);
        // The socket authenticates once and is never re-checked, so closing
        // it is the ONLY thing that stops the stream (§2 "closes affected
        // streams"); 1012 is the below-4000 retry convention.
        expect(viewer.closed).toEqual([{ code: 1012, reason: "grant revoked" }]);
        // Deterministic ordering proof: when the machine received the
        // raised-generation dispatch, the socket had ALREADY been closed -
        // never zero (the close trailed the RPC, the round-1 shape).
        expect(closesAtRpcArrival).toEqual([1]);
        // And the terminate rode the same act (§2 "cancels terminals ...
        // where reachable"), LAST (it needs the row facts).
        expect((await subshells.findById(managed))?.status).toBe("terminated");
        expect(scripted.cmdTypes().lastIndexOf("kill")).toBeGreaterThan(
          scripted.cmdTypes().lastIndexOf("ssh_input_control"),
        );
      } finally {
        observeInputControl = null;
        resetLiveViewersForTests();
      }
    });
  });

  describe("revoke vs offline node (matrix: §2 - the pending terminate dispatches on reconnect)", () => {
    it("a revocation with the node down retires the row WITHOUT a kill frame, and the reconnect census then kills the surviving pane", async () => {
      const { pane, managed } = await openWorld();
      // The connecting node goes dark between the grant and the revocation.
      const oldWire = scripted.wire;
      const oldWireLen = oldWire.length;
      scripted.detach();
      resetNodeRegistryForTests();
      try {
        const revoked = await sshRevoke(ownerCaller(), connId, pane);
        expect(revoked.revoked).toBe(true);
        // The DURABLE fact lands while the node is down: the row retires
        // (kill UNVERIFIED, the lifecycle pass's own offline posture)...
        const row = await subshells.findById(managed);
        expect(row?.status).toBe("terminated");
        // ...and NOTHING is dispatched to the dead link (the detached
        // handle's wire grew by zero frames during the whole revocation).
        expect(oldWire).toHaveLength(oldWireLen);

        // The node reconnects and its census reports the pane still alive:
        // that is the pending terminate dispatching, before any new work on
        // the machine can be accepted.
        scripted = attachScriptedNode(node, scriptedHandlers());
        const manager = new SubshellManagerService({
          subshells: new SubshellsRepository(db),
          presets: new PresetsRepository(db),
        });
        await manager.applySubshellsReport(node, [{ subshellId: managed, alive: true, exitCode: null }]);
        expect(scripted.countOf("kill")).toBe(1);
        // The census never resurrects the retired row.
        expect((await subshells.findById(managed))?.status).toBe("terminated");
      } finally {
        // Leave the file's global handle attached and live for the suites
        // that follow, whether or not the body reached its re-attach.
        scripted.detach();
        resetNodeRegistryForTests();
        scripted = attachScriptedNode(node, scriptedHandlers());
      }
    });
  });

  describe("takeover vs queued input (matrix: Races - the fence store's mirror moved mid-write)", () => {
    it("a takeover that wins the race refuses the in-flight write by name and blocks the next one at the gate", async () => {
      const { token, managed } = await openWorld();
      const inputCall = fetchAs(
        `/api/subshells/${managed}/input`,
        "POST",
        { token },
        { text: "echo hi", submit: true },
      );
      await waitInputFrames(managed, 1);

      // A human takes over WHILE the write is in flight (spec §3: an explicit
      // takeover fences stale queued input using the node-enforced generation).
      const take = await fetchAs(
        `/api/subshells/${managed}/ssh-control`,
        "POST",
        { cookie: ownerCookie },
        { mode: "human" },
      );
      expect(take.status).toBe(200);
      expect((await json(take)) as Record<string, unknown>).toMatchObject({
        controlOwner: "human",
        controlGeneration: 2,
      });

      const reject = rejectInput;
      expect(reject).not.toBeNull();
      reject?.(new Error(NODE_RESULT_SSH_GENERATION_STALE));
      const res = await inputCall;
      expect(res.status).toBe(403);
      const inputFrames = scripted.cmdsOf("input").filter((c) => c.subshellId === managed);
      expect(inputFrames).toHaveLength(1); // the queued Enter never went out

      // Control state now fences the NEXT write at the gate, before dispatch.
      const before = scripted.wire.length;
      const next = await fetchAs(
        `/api/subshells/${managed}/input`,
        "POST",
        { token },
        { text: "echo again", submit: false },
      );
      expect(next.status).toBe(403);
      expect(await next.text()).toContain("human_control");
      expect(scripted.wire.length).toBe(before);
      // Agent READS are fenced too (spec §3: human mode blocks agent reads AND
      // writes on every API/stream), while the human owner reads normally.
      expect((await fetchAs(`/api/subshells/${managed}`, "GET", { token })).status).toBe(403);
      expect((await fetchAs(`/api/subshells/${managed}`, "GET", { cookie: ownerCookie })).status).toBe(200);
      // Only humans return control; a bearer cannot un-fence itself.
      expect(
        (await fetchAs(`/api/subshells/${managed}/ssh-control`, "POST", { token }, { mode: "agent" })).status,
      ).toBe(403);
      const back = await fetchAs(
        `/api/subshells/${managed}/ssh-control`,
        "POST",
        { cookie: ownerCookie },
        { mode: "agent" },
      );
      expect(back.status).toBe(200);
      expect(await json(back)).toMatchObject({ controlOwner: "agent", controlGeneration: 3 });
    });
  });

  describe("disabled account vs SSH (Grants row: the account flag beats every credential path)", () => {
    it("a disabled owner's cookie AND its pane tokens are refused before any SSH act, dispatching nothing", async () => {
      const { token, managed } = await openWorld();
      const before = scripted.wire.length;
      const cut = await new UserMetaRepository(db).setDisabled(ownerId, true);
      expect(cut.ok).toBe(true);
      try {
        // Cookie arm. Disabling revoked the sessions as the flag flipped (the
        // one-transaction rule), so the held cookie answers 401 for BOTH facts
        // at once: the session is gone AND the flag is set.
        expect((await fetchAs(`/api/ssh/connections`, "GET", { cookie: ownerCookie })).status).toBe(401);
        expect(
          (await fetchAs(`/api/ssh/runs`, "POST", { cookie: ownerCookie }, { connectionId: connId, command: "uptime" }))
            .status,
        ).toBe(401);
        expect(
          (await fetchAs(`/api/ssh/terminals`, "POST", { cookie: ownerCookie }, { connectionId: connId })).status,
        ).toBe(401);
        expect(
          (
            await fetchAs(
              `/api/subshells/${managed}/input`,
              "POST",
              { cookie: ownerCookie },
              { text: "ls", submit: false },
            )
          ).status,
        ).toBe(401);
        // Bearer arm (the accountDisabled half, since the api key itself is
        // still live): "a running subshell's token dies with its disabled
        // owner" - the guard's per-request read refuses it, before the SSH
        // policy, before any dispatch.
        expect(
          (await fetchAs(`/api/subshells/${managed}/input`, "POST", { token }, { text: "ls", submit: false })).status,
        ).toBe(401);
        expect(
          (await fetchAs("/api/ssh/runs", "POST", { token }, { connectionId: connId, command: "uptime" })).status,
        ).toBe(401);
        expect((await fetchAs(`/api/subshells/${managed}`, "GET", { token })).status).toBe(401);
        // Nothing reached the machine for any of it.
        expect(scripted.wire.length).toBe(before);
      } finally {
        const back = await new UserMetaRepository(db).setDisabled(ownerId, false);
        expect(back.ok).toBe(true);
      }
      // Re-enabling never resurrects the revoked sessions: the old cookie
      // stays dead (the revocation rode the disable, not the flag). A fresh
      // sign-in is the way back, and every arm works again - the pane, its
      // grant, and the terminal all survived the outage untouched.
      expect((await fetchAs(`/api/subshells/${managed}`, "GET", { cookie: ownerCookie })).status).toBe(401);
      ownerCookie = await signIn(ownerEmail, pw);
      expect((await fetchAs(`/api/subshells/${managed}`, "GET", { cookie: ownerCookie })).status).toBe(200);
    });
  });

  describe("server-side bound clamps (Resource limits row: the plane clamps before the wire)", () => {
    it("an output read asks within the frozen window: maxBytes <= 256 KiB, waitMs <= 30 s", async () => {
      const pane = crypto.randomUUID();
      await subshells.create({
        id: pane,
        userId: ownerId,
        harnessId: "claude-code",
        name: "clamp-pane",
        workingDir: "/srv",
        nodeId: node,
        status: "running",
        alive: 1,
        tmuxSocket: `sock-${pane}`,
        presetId: null,
      });
      const token = await issueSubshellToken(pane, ownerId);
      expect(
        (await fetchAs(`/api/ssh/connections/${connId}/grants`, "POST", { cookie: ownerCookie }, { subshellId: pane }))
          .status,
      ).toBe(200);
      const run = await fetchAs(
        "/api/ssh/runs",
        "POST",
        { token },
        { connectionId: connId, command: "sleep 1 && echo big" },
      );
      expect(run.status).toBe(200);
      const runId = String((await json(run)).id);

      const out = await fetchAs(`/api/ssh/runs/${runId}/output?maxBytes=99999999&waitMs=99999`, "GET", {
        cookie: ownerCookie,
      });
      expect(out.status).toBe(200);
      const asks = scripted.cmdsOf("ssh_run_read").filter((c) => c.runId === runId);
      expect(asks.length).toBeGreaterThanOrEqual(1);
      const last = asks.at(-1);
      expect(last?.type === "ssh_run_read" && last.maxBytes <= SSH_OUTPUT_WINDOW_MAX_BYTES).toBe(true);
      expect(last?.type === "ssh_run_read" && last.waitMs <= SSH_READ_LONG_POLL_MAX_MS).toBe(true);
      expect(last?.type === "ssh_run_read" && last.stdoutFromByte >= 0).toBe(true);
    });

    it("start refuses past the frozen quotas with the named code and no frame", async () => {
      // Fill the mirror to the per-owner-per-node ceiling (4 - the clamp test's
      // run already holds one slot), then ask for the next.
      for (let i = 0; i < 3; i += 1) {
        const r = await fetchAs(
          "/api/ssh/runs",
          "POST",
          { cookie: ownerCookie },
          { connectionId: connId, command: `q${i}` },
        );
        expect(r.status).toBe(200);
      }
      const before = scripted.cmdsOf("ssh_run_start").length;
      const fifth = await fetchAs(
        "/api/ssh/runs",
        "POST",
        { cookie: ownerCookie },
        { connectionId: connId, command: "q5" },
      );
      expect(fifth.status).toBe(409);
      expect(await fifth.text()).toContain("quota_runs");
      expect(scripted.cmdsOf("ssh_run_start").length).toBe(before);
    });

    it("six CONCURRENT starts admit exactly the ceiling: the per-owner count and the insert are one transaction (Gate C minor 6)", async () => {
      // Check-then-act on a FRESH (owner, node) pair, so only the race itself
      // can overshoot: the old two-counts-then-insert let interleaved starts
      // all read the same pre-insert count. Fresh node and connection because
      // the shared pair is already at its ceiling from the test above.
      const node2 = crypto.randomUUID();
      await nodes.create({
        id: node2,
        ownerUserId: ownerId,
        name: `q2-${node2.slice(0, 8)}`,
        kind: "agent",
        status: "online",
      });
      const sim2 = attachScriptedNode(node2, {
        ssh_run_start: (cmd) =>
          cmd.type === "ssh_run_start" ? facts({ runId: cmd.runId, lifecycle: "running" }) : new Error("wrong cmd"),
      });
      const conn2 = await connections.create({
        id: crypto.randomUUID(),
        userId: ownerId,
        nodeId: node2,
        displayName: "Quota Race",
        configSnapshot: JSON.stringify(SNAPSHOT),
        remoteDir: null,
      });
      try {
        const results = await Promise.all(
          Array.from({ length: 6 }, (_, i) =>
            fetchAs("/api/ssh/runs", "POST", { cookie: ownerCookie }, { connectionId: conn2.id, command: `race${i}` }),
          ),
        );
        const statuses = results.map((r) => r.status);
        const bodies = await Promise.all(results.map((r) => r.text()));
        expect(statuses.filter((s) => s === 200)).toHaveLength(4);
        expect(statuses.filter((s) => s === 409)).toHaveLength(2);
        expect(bodies.filter((t) => t.includes("quota_runs"))).toHaveLength(2);
        // The plane admitted 4 to its mirror AND its wire: the refused starts
        // dispatched nothing.
        expect(sim2.countOf("ssh_run_start")).toBe(4);
        const active = await db
          .selectFrom("sshRuns")
          .select("id")
          .where("nodeId", "=", node2)
          .where("status", "in", ["accepted", "running"])
          .execute();
        expect(active).toHaveLength(4);
      } finally {
        sim2.detach();
        await db.deleteFrom("sshRuns").where("nodeId", "=", node2).execute();
        await db.deleteFrom("sshConnections").where("id", "=", conn2.id).execute();
        await db.deleteFrom("nodes").where("id", "=", node2).execute();
      }
    });
  });
});
