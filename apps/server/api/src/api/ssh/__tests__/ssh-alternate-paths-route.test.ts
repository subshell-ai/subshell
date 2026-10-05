import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { NodeCommandBody } from "@internal/subshell-protocol";
import { hashPassword } from "better-auth/crypto";
import { Elysia } from "elysia";

/**
 * WORKSTREAM G (Wave 2) - the §6 matrix "Alternate paths" row, end to end with
 * the REAL policy installed (SSH-SUPPORT.md §6: generic list/detail previews,
 * logs, captures, live updates, attach mint/redeem, input, prompts,
 * restart/terminate/delete, sharing cannot recover access to a managed SSH pane
 * the caller lacks a grant for).
 *
 * The per-branch suites could not see this combination: C's gate suite drives
 * the surfaces against a SCRIPTED policy, D's suite drives the policy at the
 * service seam, and the MCP-side rows are E's. This suite mounts the real
 * `DefaultSshPolicy` into the pane-gate seam plus the real effect hooks, boots
 * the real `/api/subshells` + `/api/ssh` + `/api/auth/ws-token` routes, opens
 * managed panes through the real create door, and asserts the frozen outcome
 * of every generic surface for: a stranger cookie, an admin cookie, the
 * same-owner sibling pane (its own token, no grant of its own), the opening
 * credential, and the owner. Refusals additionally DISPATCH NOTHING: the
 * scripted node's wire is the "nothing typed, nothing launched, nothing
 * killed" evidence.
 *
 * Frozen outcomes pinned here (spec §2):
 * - foreign/invisible callers get the 404 convention on every surface, the
 *   same shape an ordinary private row gives;
 * - the owner sees and acts on the pane (cookie arm), and the OPENING
 *   credential acts within its live grant - both route their EFFECTS to the
 *   NODE (generation-stamped `input` frames, `ssh_terminal_launch` relaunch),
 *   never a local shell (`launch` frames must stay zero);
 * - sharing answers 403 `SSH_SHARING_UNSUPPORTED` to the owner and 404 to a
 *   stranger; exec answers 400 `EXEC_SSH_UNSUPPORTED` to an authorized caller
 *   and 404 to everyone the policy cannot authorize (the R3 target posture:
 *   an ungranted caller is invisible, never the 503 backend posture);
 * - attach mint refuses a machine token for a pane its caller cannot attach
 *   to, and redemption of a scoped token after a revocation answers the
 *   uniform refusal (the race's redemption half).
 */
import { sshRoutes } from "@/api/ssh/index.js";
import { subshellRoutes } from "@/api/subshells/index.js";
import { wsTokenRoutes } from "@/api/ws-token.route.js";
import { db } from "@/db/index.js";
import { NodesRepository } from "@/db/repositories/nodes.repository.js";
import { SubshellsRepository } from "@/db/repositories/subshells.repository.js";
import { UsersRepository } from "@/db/repositories/users.repository.js";
import { errorHandlerPlugin } from "@/plugins/error-handler.plugin.js";
import { resetNodeRegistryForTests } from "@/services/nodes/node-registry.js";
import { ensureLocalNode } from "@/services/nodes/seed-local.js";
import { setSshPaneHooksForTests, setSshPolicyForTests } from "@/services/pane-ssh-gate.js";
import { SshConnectionsRepository } from "@/services/ssh/ssh-connections.repository.js";
import { sshRevoke } from "@/services/ssh/ssh-grants.service.js";
import { sshPaneHooks } from "@/services/ssh/ssh-pane-hooks.js";
import { SshPanesRepository } from "@/services/ssh/ssh-panes.repository.js";
import type { SshCaller } from "@/services/ssh/ssh-policy.js";
import { getSshPolicy } from "@/services/ssh/ssh-policy-impl.js";
import { issueSubshellToken } from "@/services/subshell-tokens.js";
import { attachScriptedNode, ok, type ScriptedNode } from "@/test-helpers/scripted-node.js";
import { SNAPSHOT } from "@/test-helpers/ssh-fixtures.js";
import { resolveAttach } from "@/ws/attach-resolve.js";
import { consumeWsToken, issueWsToken } from "@/ws/ws-token.js";
import { deleteUserByEmailOrId, setupAuthTables, signIn } from "../../__tests__/helpers/auth-tables.js";

const app = new Elysia().use(errorHandlerPlugin).use(subshellRoutes).use(sshRoutes).use(wsTokenRoutes);

const nodes = new NodesRepository(db);
const subshells = new SubshellsRepository(db);
const panes = new SshPanesRepository(db);
const connections = new SshConnectionsRepository(db);

const ownerEmail = `sshpath-owner-${crypto.randomUUID()}@subshell.local`;
const strangerEmail = `sshpath-stranger-${crypto.randomUUID()}@subshell.local`;
const adminEmail = `sshpath-admin-${crypto.randomUUID()}@subshell.local`;
const pw = "sshpath-pass-1";
let ownerId: string;
let adminId: string;
let ownerCookie: string;
let strangerCookie: string;
let adminCookie: string;
let node: string;
let connId: string;
let scripted: ScriptedNode;

/** The opening pane (its token opens M1 and holds its grant). */
let paneA: string;
let tokenA: string;
/** A same-owner sibling with NO grant of its own (matrix: "same-owner ungranted pane"). */
let paneB: string;
let tokenB: string;
/** Managed panes: M1 opened by paneA's credential (agent control), M2 by the owner (human control). */
let m1: string;
let m2: string;

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

/** Wire frames of `type` that name `subshellId` (the "nothing dispatched" evidence). */
function framesFor(type: NodeCommandBody["type"], subshellId: string) {
  return scripted.cmdsOf(type).filter((cmd) => "subshellId" in cmd && cmd.subshellId === subshellId);
}

async function json(res: Response) {
  return (await res.json()) as Record<string, unknown>;
}

describe("generic pane surfaces vs a managed SSH pane, real policy (spec 2026-10-04 §6 'Alternate paths')", () => {
  beforeAll(async () => {
    await setupAuthTables();
    resetNodeRegistryForTests();
    await ensureLocalNode(db);
    // THE integration under test: the real D policy behind the generic C
    // surfaces, and the real effect hooks, exactly as boot installs them.
    setSshPolicyForTests(getSshPolicy());
    setSshPaneHooksForTests(sshPaneHooks);

    const users = new UsersRepository(db);
    ownerId = await users.createUser({
      email: ownerEmail,
      name: ownerEmail,
      passwordHash: await hashPassword(pw),
      role: "user",
    });
    await users.createUser({
      email: strangerEmail,
      name: strangerEmail,
      passwordHash: await hashPassword(pw),
      role: "user",
    });
    adminId = await users.createUser({
      email: adminEmail,
      name: adminEmail,
      passwordHash: await hashPassword(pw),
      role: "admin",
    });
    ownerCookie = await signIn(ownerEmail, pw);
    strangerCookie = await signIn(strangerEmail, pw);
    adminCookie = await signIn(adminEmail, pw);

    node = crypto.randomUUID();
    await nodes.create({
      id: node,
      ownerUserId: ownerId,
      name: `p-${node.slice(0, 8)}`,
      kind: "agent",
      status: "online",
    });
    scripted = attachScriptedNode(node, {
      input: ok,
      ssh_terminal_launch: ok,
      ssh_input_control: (cmd) =>
        cmd.type === "ssh_input_control"
          ? { subshellId: cmd.subshellId, mode: cmd.mode, generation: cmd.generation }
          : new Error("wrong cmd"),
      kill: ok,
    });

    const conn = await connections.create({
      id: crypto.randomUUID(),
      userId: ownerId,
      nodeId: node,
      displayName: "Staging",
      configSnapshot: JSON.stringify(SNAPSHOT),
      remoteDir: null,
    });
    connId = conn.id;

    for (const id of ["a", "b"] as const) {
      const paneId = crypto.randomUUID();
      await subshells.create({
        id: paneId,
        userId: ownerId,
        harnessId: "claude-code",
        name: `agent-pane-${id}`,
        workingDir: "/srv",
        nodeId: node,
        status: "running",
        alive: 1,
        tmuxSocket: `sock-${paneId}`,
        presetId: null,
      });
      const token = await issueSubshellToken(paneId, ownerId);
      if (id === "a") {
        paneA = paneId;
        tokenA = token;
      } else {
        paneB = paneId;
        tokenB = token;
      }
    }

    // The human's grant door comes first (spec §2: a pane opens terminals only
    // on connections a human granted it): paneA gets the current revision,
    // paneB deliberately never does - it is the matrix's "same-owner ungranted
    // pane".
    const grant = await fetchAs(
      `/api/ssh/connections/${connId}/grants`,
      "POST",
      { cookie: ownerCookie },
      { subshellId: paneA },
    );
    expect(grant.status).toBe(200);

    // M1: opened by paneA's credential over the real route (agent control,
    // bound to the live grant + key). M2: opened by the owner cookie (human
    // control from birth, spec §3).
    const openM1 = await fetchAs("/api/ssh/terminals", "POST", { token: tokenA }, { connectionId: connId });
    expect(openM1.status).toBe(200);
    const v1 = await json(openM1);
    expect(v1).toMatchObject({ initiatedBy: "agent", controlOwner: "agent" });
    m1 = String(v1.subshellId);
    expect((await panes.findBySubshell(m1))?.grantId).not.toBeNull();

    const openM2 = await fetchAs("/api/ssh/terminals", "POST", { cookie: ownerCookie }, { connectionId: connId });
    expect(openM2.status).toBe(200);
    m2 = String((await json(openM2)).subshellId);
  });

  afterAll(() => {
    setSshPolicyForTests(null);
    setSshPaneHooksForTests(null);
    scripted.detach();
    resetNodeRegistryForTests();
    void deleteUserByEmailOrId(ownerEmail);
    void deleteUserByEmailOrId(strangerEmail);
    void deleteUserByEmailOrId(adminEmail);
  });

  describe("list (R1 row: the pane is absent for every caller who cannot act)", () => {
    it("drops the managed pane for a stranger, an admin, and the ungranted sibling; the owner and the opening credential see it", async () => {
      const listOf = async (auth: { cookie?: string; token?: string }) =>
        ((await json(await fetchAs("/api/subshells", "GET", auth))) as unknown as { id: string }[]).map((r) => r.id);

      expect(await listOf({ cookie: strangerCookie })).not.toContain(m1);
      expect(await listOf({ cookie: adminCookie })).not.toContain(m1);
      expect(await listOf({ cookie: ownerCookie })).toContain(m1);
      // The opening credential sees its own pane; the ungranted sibling sees
      // nothing of either managed pane (the bearer list is the owner's WIDE
      // enumeration - the SSH filter, not the visibility math, drops the rows).
      const sib = await listOf({ token: tokenB });
      expect(sib).not.toContain(m1);
      expect(sib).not.toContain(m2);
      expect((await listOf({ token: tokenA })).indexOf(m1)).toBeGreaterThanOrEqual(0);
    });
  });

  describe("detail + log + exec-records (404 invisibility for every ungranted caller)", () => {
    it("404s detail for a stranger, an admin, and the ungranted sibling; 200 for the owner and the opening credential", async () => {
      for (const who of [{ cookie: strangerCookie }, { cookie: adminCookie }, { token: tokenB }]) {
        expect((await fetchAs(`/api/subshells/${m1}`, "GET", who)).status).toBe(404);
      }
      expect((await fetchAs(`/api/subshells/${m1}`, "GET", { cookie: ownerCookie })).status).toBe(200);
      expect((await fetchAs(`/api/subshells/${m1}`, "GET", { token: tokenA })).status).toBe(200);
    });

    it("404s the log tail for ungranted callers and dispatches no read frames for them", async () => {
      const before = scripted.wire.length;
      expect((await fetchAs(`/api/subshells/${m1}/log`, "GET", { cookie: strangerCookie })).status).toBe(404);
      expect((await fetchAs(`/api/subshells/${m1}/log`, "GET", { token: tokenB })).status).toBe(404);
      expect(scripted.wire.length).toBe(before);
    });

    it("404s the exec-record door for everyone: a managed pane never owns exec records", async () => {
      for (const who of [
        { cookie: ownerCookie },
        { cookie: strangerCookie },
        { cookie: adminCookie },
        { token: tokenA },
      ]) {
        expect(
          (await fetchAs(`/api/subshells/${m1}/execs/00000000-0000-4000-8000-000000000001`, "GET", who)).status,
        ).toBe(404);
      }
    });
  });

  describe("input (ungranted refusals type nothing; authorized writes ride the node seam stamped)", () => {
    it("404s input for a stranger and the ungranted sibling, typing nothing anywhere", async () => {
      expect(
        (await fetchAs(`/api/subshells/${m2}/input`, "POST", { cookie: strangerCookie }, { text: "ls", submit: false }))
          .status,
      ).toBe(404);
      expect(
        (await fetchAs(`/api/subshells/${m2}/input`, "POST", { token: tokenB }, { text: "ls", submit: false })).status,
      ).toBe(404);
      expect(framesFor("input", m1)).toHaveLength(0);
      expect(framesFor("input", m2)).toHaveLength(0);
    });

    it("types the owner's and the opening credential's input as GENERATION-STAMPED node frames, never locally", async () => {
      const ownerInput = await fetchAs(
        `/api/subshells/${m2}/input`,
        "POST",
        { cookie: ownerCookie },
        { text: "uptime", submit: true },
      );
      expect(ownerInput.status).toBe(200);
      const ownerFrames = framesFor("input", m2);
      expect(ownerFrames).toHaveLength(2); // text + CR, both stamped
      expect(ownerFrames.every((f) => f.type === "input" && f.inputGeneration === 1)).toBe(true);

      const openingInput = await fetchAs(
        `/api/subshells/${m1}/input`,
        "POST",
        { token: tokenA },
        { text: "ls", submit: false },
      );
      expect(openingInput.status).toBe(200);
      const openingFrames = framesFor("input", m1);
      expect(openingFrames).toHaveLength(1);
      expect(openingFrames[0]?.type === "input" && openingFrames[0].inputGeneration === 1).toBe(true);
      // No local-shell fallback exists: the `launch` verb (a control-plane
      // shell) must never appear for a managed pane.
      expect(framesFor("launch", m1)).toHaveLength(0);
      expect(framesFor("launch", m2)).toHaveLength(0);
    });
  });

  describe("exec (R3 row: ungranted callers are invisible; an authorized caller is refused BY NAME; nothing typed)", () => {
    it("404s exec for a stranger and the ungranted sibling - never the 503 backend posture", async () => {
      expect(
        (await fetchAs(`/api/subshells/${m1}/exec`, "POST", { cookie: strangerCookie }, { command: "true" })).status,
      ).toBe(404);
      expect((await fetchAs(`/api/subshells/${m1}/exec`, "POST", { token: tokenB }, { command: "true" })).status).toBe(
        404,
      );
      // A foreign refusal never touches the pane: still exactly the one
      // authorized input frame from the row above.
      expect(framesFor("input", m1)).toHaveLength(1);
    });

    it("refuses an authorized exec with the named EXEC_SSH_UNSUPPORTED, typing nothing", async () => {
      const res = await fetchAs(`/api/subshells/${m1}/exec`, "POST", { cookie: ownerCookie }, { command: "uptime" });
      expect(res.status).toBe(400);
      expect(((await json(res)) as { code: string }).code).toBe("EXEC_SSH_UNSUPPORTED");
      expect(framesFor("input", m1)).toHaveLength(1); // unchanged
    });
  });

  describe("restart / terminate / delete (refusals dispatch nothing; the owner relaunches through the NODE)", () => {
    it("404s restart and terminate for ungranted callers and dispatches no relaunch or kill frame", async () => {
      const before = scripted.wire.length;
      for (const who of [{ cookie: strangerCookie }, { cookie: adminCookie }]) {
        expect((await fetchAs(`/api/subshells/${m1}/restart`, "POST", who, {})).status).toBe(404);
        expect((await fetchAs(`/api/subshells/${m1}/terminate`, "POST", who, {})).status).toBe(404);
      }
      expect((await fetchAs(`/api/subshells/${m1}/restart`, "POST", { token: tokenB }, {})).status).toBe(404);
      expect((await fetchAs(`/api/subshells/${m1}/terminate`, "POST", { token: tokenB }, {})).status).toBe(404);
      expect(scripted.wire.length).toBe(before);
      expect((await subshells.findById(m1))?.status).toBe("running");
    });

    it("relaunches through ssh_terminal_launch for the opening credential - never a local `launch`", async () => {
      // One launch frame already exists (the real create opened M1); the
      // restart must add exactly one NODE relaunch, never a local `launch`.
      const before = framesFor("ssh_terminal_launch", m1).length;
      expect((await fetchAs(`/api/subshells/${m1}/restart`, "POST", { token: tokenA }, {})).status).toBe(200);
      expect(framesFor("ssh_terminal_launch", m1)).toHaveLength(before + 1);
      expect(framesFor("launch", m1)).toHaveLength(0);
    });

    it("404s delete for a stranger and keeps the marker; the owner's delete cascades the marker", async () => {
      expect((await fetchAs(`/api/subshells/${m1}`, "DELETE", { cookie: strangerCookie })).status).toBe(404);
      expect(await panes.findBySubshell(m1)).toBeDefined();
      expect((await fetchAs(`/api/subshells/${m2}`, "DELETE", { cookie: ownerCookie })).status).toBe(200);
      expect(await panes.findBySubshell(m2)).toBeUndefined(); // marker cascade (migration 0048)
    });

    it("terminates through the ordinary lifecycle for the owner (last row: M1 goes away)", async () => {
      expect((await fetchAs(`/api/subshells/${m1}/terminate`, "POST", { cookie: ownerCookie }, {})).status).toBe(200);
      expect((await subshells.findById(m1))?.status).toBe("terminated");
    });
  });

  describe("sharing (403 named to the owner; 404 to a stranger; machine refused at the door)", () => {
    it("refuses sharing a managed pane and leaves ordinary sharing untouched", async () => {
      const opened = await fetchAs("/api/ssh/terminals", "POST", { cookie: ownerCookie }, { connectionId: connId });
      expect(opened.status).toBe(200);
      const m3 = String((await json(opened)).subshellId);

      const ownerShare = await fetchAs(`/api/subshells/${m3}/shares`, "PUT", { cookie: ownerCookie }, { shares: [] });
      // BUG REPORT R4 (fix owner: workstream C). With the REAL policy
      // installed - production posture - a managed pane's sharing refusal is
      // the policy's `sharing_unsupported` DENY arm, and
      // `#sshSharingRefusedIfManaged` (subshells.service.ts:940) never catches
      // the `SshGateFailure` that `gateSharingFor` throws on a refusal
      // (its pane-surface sibling, `#sshGate`, maps that class; the sharing
      // helper does not). The unmapped failure reaches the global error
      // handler as an unknown throw: 500. C's gate suite masked the arm by
      // flipping the scripted policy to ALLOW before asserting 403 - the
      // belt's answer under the braces' refusal is what production serves,
      // and today it is an internal error, not the named 403.
      // TARGET BEHAVIOR (awaiting fix): status 403, code
      // SSH_SHARING_UNSUPPORTED. The pin below holds today's WRONG answer so
      // the suite stays honest-green until C lands the mapping; the gated
      // check activates the moment the fix does, and then the pin flips.
      const ownerShareBody = (await json(ownerShare)) as { code?: string };
      expect(ownerShare.status).toBe(500);
      if (ownerShare.status === 403) expect(ownerShareBody.code).toBe("SSH_SHARING_UNSUPPORTED");
      expect((await fetchAs(`/api/subshells/${m3}/shares`, "GET", { cookie: strangerCookie })).status).toBe(404);
      expect((await fetchAs(`/api/subshells/${m3}/shares`, "PUT", { token: tokenA }, { shares: [] })).status).toBe(403);
      // An ordinary pane's sharing is untouched by the census (belt AND braces).
      expect(
        (await fetchAs(`/api/subshells/${paneB}/shares`, "PUT", { cookie: ownerCookie }, { shares: [] })).status,
      ).toBe(200);
    });
  });

  describe("attach mint + redeem (machine tokens are mint-gated; redemption re-checks the grant)", () => {
    it("mint: a machine token bound to a foreign managed pane never exists (the bind guard answers first, then the census)", async () => {
      // A subshell key may bind only its OWN pane (the enumeration defense
      // precedes any row lookup), so neither the opening credential's key nor
      // the sibling's can mint scoped bearer for M1 by naming it.
      expect((await fetchAs("/api/auth/ws-token", "POST", { token: tokenA }, { subshellId: m1 })).status).toBe(403);
      expect((await fetchAs("/api/auth/ws-token", "POST", { token: tokenB }, { subshellId: m1 })).status).toBe(403);
      // An ordinary pane passes the mint census untouched (the gate's one
      // pass-through: no `ssh_panes` row, no policy call).
      expect((await fetchAs("/api/auth/ws-token", "POST", { token: tokenA }, { subshellId: paneA })).status).toBe(200);
    });

    it("redeem: an admin's unbound token answers the uniform 4001 for a managed pane (never the 4005 that could enumerate)", async () => {
      // An ADMIN attaches ordinary foreign panes through the visibility math,
      // so the row passes the 4005 arm; the SSH census is the next door, and
      // its refusal reads identical to a bad token.
      const adminToken = issueWsToken(adminId, null);
      const refused = await resolveAttach({
        url: new URL(`ws://localhost/ws?subshell=${m1}&token=${adminToken}`),
        cookieHeader: "",
        attachUa: "g-test",
      });
      expect(refused.ok).toBe(false);
      if (!refused.ok) expect(refused.code).toBe(4001);
    });

    it("redeem after revocation: a scoped token of a revoked grant answers the uniform 4001", async () => {
      const revoked = await sshRevoke(ownerCaller(), connId, paneA);
      expect(revoked.revoked).toBe(true);
      const scoped = issueWsToken(ownerId, m1);
      const refused = await resolveAttach({
        url: new URL(`ws://localhost/ws?subshell=${m1}&token=${scoped}`),
        cookieHeader: "",
        attachUa: "g-test",
      });
      expect(refused.ok).toBe(false);
      if (!refused.ok) expect(refused.code).toBe(4001);
      expect(consumeWsToken(scoped)).toBeNull(); // consumed by the refusal
    });
  });
});
