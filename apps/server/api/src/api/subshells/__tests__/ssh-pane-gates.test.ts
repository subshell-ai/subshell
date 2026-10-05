import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { BackendErrorCodes } from "@internal/backend-errors";
import { hashPassword } from "better-auth/crypto";
import { Elysia } from "elysia";
/**
 * The SSH gates on the GENERIC pane surfaces (task-C brief deliverables 1-3):
 * every managed-SSH-pane act runs the injected policy and honors its refusal;
 * until D registers the real implementation the placeholder DENIES
 * everything, and no surface turns a refusal into success or an ordinary-pane
 * fallback. The scripted policy installed here is deliberately dumb (per-surface
 * allow/deny decisions, no grant math - that is D's suite): what these tests
 * pin is that the SURFACES consult it, map it onto the house conventions
 * exactly (refusal → invisibility 404/absent; named refusal → 403 + the
 * policy code in metadata; v1 sharing refusal even under an `allow`; no
 * hooks → 503, never a local shell), and that ordinary panes are untouched.
 *
 * The route-boot pattern: errorHandlerPlugin + the real subshellRoutes +
 * a signed-in cookie, like every other route suite here.
 */
import { subshellRoutes } from "@/api/subshells/index.js";
import { deleteApiKey } from "@/auth/apikey-store.js";
import { ensureSystemUser } from "@/auth/system-user.js";
import { getAuth } from "@/auth.js";
import { db } from "@/db/index.js";
import { NodesRepository } from "@/db/repositories/nodes.repository.js";
import { SubshellsRepository } from "@/db/repositories/subshells.repository.js";
import { UsersRepository } from "@/db/repositories/users.repository.js";
import { getRequestlessContext } from "@/lib/context.js";
import { errorHandlerPlugin } from "@/plugins/error-handler.plugin.js";
import { resetNodeRegistryForTests } from "@/services/nodes/node-registry.js";
import { previewCacheDrop, previewCachePut } from "@/services/nodes/preview-cache.js";
import {
  DENY_EVERYTHING_SSH_POLICY,
  type SshPaneHooks,
  setSshPaneHooksForTests,
  setSshPolicyForTests,
} from "@/services/pane-ssh-gate.js";
import type { SshDecision, SshPolicy } from "@/services/ssh/ssh-policy.js";
import { issueSubshellToken } from "@/services/subshell-tokens.js";
import { SubshellsService } from "@/services/subshells.service.js";
import { cancelObservation, observationActive } from "@/services/terminal-exec-records.js";
import { attachScriptedNode, ok, type ScriptedNode } from "@/test-helpers/scripted-node.js";
import { registerViewer, resetLiveViewersForTests, type WsSocket } from "@/ws/viewers.js";
import { deleteUserByEmailOrId, setupAuthTables, signIn } from "../../__tests__/helpers/auth-tables.js";

const app = new Elysia().use(errorHandlerPlugin).use(subshellRoutes);

const nodes = new NodesRepository(db);
const subshells = new SubshellsRepository(db);

const enc = new TextEncoder();

/* ------------------------------------------------------------------ */
/* the scripted policy: a per-surface decision table                    */
/* ------------------------------------------------------------------ */

interface Scripted {
  paneSurface: Map<string, SshDecision>;
  /** The DEFAULT decision for any surface not in the table. The placeholder's shape: refuse as invisible. */
  defaultSurface: SshDecision;
  sharing: SshDecision;
  humanConfig: SshDecision;
  seenSurfaces: string[];
}

let scripted: Scripted;

function scriptedPolicy(): SshPolicy {
  return {
    ...DENY_EVERYTHING_SSH_POLICY,
    gatePaneSurface: async (req) => {
      scripted.seenSurfaces.push(`${req.subshellId}:${req.surface}`);
      return scripted.paneSurface.get(req.surface) ?? scripted.defaultSurface;
    },
    gateSharing: async () => scripted.sharing,
    gateHumanConfig: async () => scripted.humanConfig,
  };
}

/* ------------------------------------------------------------------ */
/* the scripted hooks: what the SSH backend would do, recorded          */
/* ------------------------------------------------------------------ */

interface HookCalls {
  input: { subshellId: string; text: string; submit: boolean; inputGeneration: number }[];
  control: { subshellId: string; mode: string; generation: number }[];
  restart: string[];
}

let hookCalls: HookCalls;

function scriptedHooks(): SshPaneHooks {
  return {
    sendManagedInput: async (req) => {
      hookCalls.input.push(req);
    },
    applyControlTransition: async (req) => {
      hookCalls.control.push(req);
    },
    restartManagedPane: async ({ subshellId }) => {
      hookCalls.restart.push(subshellId);
      return { tmuxSocket: `sock-${subshellId.slice(0, 8)}` };
    },
  };
}

describe("SSH gates on the generic pane surfaces", () => {
  const ownerEmail = `sshgate-owner-${crypto.randomUUID()}@subshell.local`;
  const foreignEmail = `sshgate-foreign-${crypto.randomUUID()}@subshell.local`;
  const adminEmail = `sshgate-admin-${crypto.randomUUID()}@subshell.local`;
  const pw = "sshgate-pass-1";
  let ownerId: string;
  let foreignId: string;
  let ownerCookie: string;
  let adminCookie: string;

  let node: string; // an agent node (rows live there; local fallback can never mask a missing gate)
  let sim: ScriptedNode;
  const cleanup: Array<() => Promise<void>> = [];

  /** A plain RUNNING terminal row on the scripted agent node. */
  async function seedPane(name: string, over: { startedAt?: string } = {}): Promise<string> {
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
      // A launched pane carries its spawn stamp; the exec-record incarnation
      // test compares against it, so every seeded row has one.
      startedAt: over.startedAt ?? "2026-10-04T00:00:00.000Z",
    });
    cleanup.push(async () => {
      await db.deleteFrom("sshPanes").where("subshellId", "=", id).execute();
      await db.deleteFrom("sshTerminalExecs").where("subshellId", "=", id).execute();
      await db.deleteFrom("subshells").where("id", "=", id).execute();
    });
    return id;
  }

  /** A MANAGED SSH pane: connection row + subshells row + ssh_panes row. */
  async function seedManaged(
    name: string,
    over: { controlGeneration?: number; logGeneration?: number; controlOwner?: "agent" | "human" } = {},
  ): Promise<string> {
    const paneId = await seedPane(name);
    const connId = crypto.randomUUID();
    await db
      .insertInto("sshConnections")
      .values({
        id: connId,
        userId: ownerId,
        nodeId: node,
        displayName: "gate-conn",
        configSnapshot: "{}",
        remoteDir: null,
        // The registry has no Generated wrappers on this table: every column
        // (including the DB-defaulted stamps) is named, as production inserts do.
        revision: 1,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })
      .execute();
    cleanup.push(async () => {
      await db.deleteFrom("sshPanes").where("subshellId", "=", paneId).execute();
      await db.deleteFrom("sshConnections").where("id", "=", connId).execute();
    });
    await db
      .insertInto("sshPanes")
      .values({
        subshellId: paneId,
        connectionId: connId,
        connectionRevision: 1,
        initiatedBy: "human",
        grantId: null,
        apiKeyId: null,
        controlOwner: over.controlOwner ?? "agent",
        controlGeneration: over.controlGeneration ?? 1,
        logGeneration: over.logGeneration ?? 1,
        createdAt: new Date().toISOString(),
      })
      .execute();
    return paneId;
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
    // The guard resolves a PRESENT cookie first; a bearer test must therefore
    // send ONLY the bearer, or it silently measures the owner's cookie pass.
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
      name: "Gate Owner",
      role: "user",
    });
    ownerCookie = await signIn(ownerEmail, pw);
    foreignId = await new UsersRepository(db).createUser({
      email: foreignEmail,
      passwordHash: await hashPassword(pw),
      name: "Foreign",
      role: "user",
    });
    // A real admin (role "admin", not a grantee): the summary census test
    // needs an account whose ordinary visibility is instance-wide, so the
    // managed drop is proven to be the POLICY and not ordinary math.
    await new UsersRepository(db).createUser({
      email: adminEmail,
      passwordHash: await hashPassword(pw),
      name: "Gate Admin",
      role: "admin",
    });
    adminCookie = await signIn(adminEmail, pw);
    node = crypto.randomUUID();
    await nodes.create({ id: node, ownerUserId: ownerId, name: `gate-${node.slice(0, 8)}`, kind: "agent" });
  });

  afterAll(async () => {
    resetNodeRegistryForTests();
    await deleteUserByEmailOrId(ownerEmail);
    await deleteUserByEmailOrId(foreignEmail);
    await deleteUserByEmailOrId(adminEmail);
  });

  beforeEach(() => {
    scripted = {
      paneSurface: new Map(),
      defaultSurface: { allow: false, code: "not_found" },
      sharing: { allow: false, code: "sharing_unsupported" },
      humanConfig: { allow: true },
      seenSurfaces: [],
    };
    hookCalls = { input: [], control: [], restart: [] };
    setSshPolicyForTests(scriptedPolicy());
    setSshPaneHooksForTests(scriptedHooks());
    sim = attachScriptedNode(node, {
      terminate: ok,
      kill: ok,
      input: ok,
      // The agent-shaped empty log: the managed paths never read it (they
      // refuse or delegate), ordinary exec uses its own suites.
      log_read: () => ({ bytes_b64: "", next: 0, size: 0 }),
    });
  });

  afterEach(async () => {
    setSshPolicyForTests(null);
    setSshPaneHooksForTests(null);
    sim.detach();
    resetNodeRegistryForTests();
    for (const fn of cleanup.splice(0).reverse()) await fn().catch(() => {});
  });

  const allowAll = () => {
    for (const s of [
      "detail",
      "list_preview",
      "log",
      "capture",
      "live",
      "attach_redeem",
      "input",
      "exec",
      "prompt",
      "restart",
      "terminate",
      "delete",
    ] as const) {
      scripted.paneSurface.set(s, { allow: true });
    }
  };

  describe("detail / list hiding", () => {
    it("a refused managed pane is invisible on detail, not a 403", async () => {
      const pane = await seedManaged("gate-detail");
      const res = await call(`/${pane}`);
      expect(res.status).toBe(404);
      expect(scripted.seenSurfaces).toContain(`${pane}:detail`);
    });

    it("an allowed managed pane reads normally", async () => {
      const pane = await seedManaged("gate-detail-ok");
      allowAll();
      const res = await call(`/${pane}`);
      expect(res.status).toBe(200);
    });

    it("the owner's list drops managed panes the policy refuses, keeps them when allowed", async () => {
      const ordinary = await seedPane("gate-list-ordinary");
      const managed = await seedManaged("gate-list-managed");
      // Deny (the placeholder's arm): absent from the list, ordinary stays.
      let res = await call("");
      let ids = ((await res.json()) as { id: string }[]).map((v) => v.id);
      expect(ids).toContain(ordinary);
      expect(ids).not.toContain(managed);
      // Allow: present.
      allowAll();
      res = await call("");
      ids = ((await res.json()) as { id: string }[]).map((v) => v.id);
      expect(ids).toContain(managed);
    });

    it("a same-owner sibling's bearer list never sees the managed pane without its own grant", async () => {
      const sibling = await seedPane("gate-sibling");
      const managed = await seedManaged("gate-sibling-managed");
      allowAll(); // the policy's allow is keyed to the CALLER in D's real form;
      // here the sibling must be refused by its OWN table - default deny wins
      // back for the bearer pass while the owner's cookie pass keeps it.
      scripted.paneSurface.clear();
      const token = await issueSubshellToken(sibling, ownerId);
      const res = await call("", { bearer: token });
      const ids = ((await res.json()) as { id: string }[]).map((v) => v.id);
      expect(ids).toContain(sibling); // ordinary rows: enumeration unchanged
      expect(ids).not.toContain(managed);
    });
  });

  describe("sharing", () => {
    it("v1 refuses to read and write a managed pane's shares, even when the policy says allow", async () => {
      const pane = await seedManaged("gate-shares");
      scripted.sharing = { allow: true }; // belt AND braces: the v1 ruling is the site's too
      let res = await call(`/${pane}/shares`, { method: "PUT", body: { shares: [] } });
      expect(res.status).toBe(403);
      expect(((await res.json()) as { code: string }).code).toBe(BackendErrorCodes.SSH_SHARING_UNSUPPORTED);
      res = await call(`/${pane}/shares`);
      expect(res.status).toBe(403);
    });

    it("ordinary panes share unchanged", async () => {
      const pane = await seedPane("gate-shares-ordinary");
      const res = await call(`/${pane}/shares`, { method: "PUT", body: { shares: [] } });
      expect(res.status).toBe(200);
    });
  });

  // The §6 "captures" door (Gate C coverage): the dedicated-screens path is
  // the most sensitive bytes the app moves, and it is its own census surface
  // beside `list_preview` - the live-ws snapshot pulls screens through
  // `previewsFor`, and the alternate-paths header has always claimed the row.
  describe("the captures door (previewsFor)", () => {
    function service(): SubshellsService {
      const ctx = getRequestlessContext();
      return new SubshellsService({ log: ctx.log, db: ctx.db, repos: ctx.repos });
    }

    it("refuses a non-owner's capture AND the un-allowed owner's, passes only what the policy admits, and asks `capture`", async () => {
      const ordinary = await seedPane("cap-ordinary");
      const managed = await seedManaged("cap-managed");
      // The screens are cached facts (the agent-node preview path), so an
      // ABSENT map entry is proof the door filtered the id, not that no
      // screen existed.
      previewCachePut(ordinary, ["ORDINARY SCREEN"]);
      previewCachePut(managed, ["MANAGED REMOTE SCREEN"]);
      try {
        // Default arm (invisible): the owner's own snapshots answer without
        // the managed screen, and the door was ASKED for it.
        const denied = await service().previewsFor(ownerId, [ordinary, managed]);
        expect(denied.get(managed)).toBeUndefined();
        expect(denied.get(ordinary)).toEqual(["ORDINARY SCREEN"]);
        expect(scripted.seenSurfaces).toContain(`${managed}:capture`);
        // A foreign viewer sees neither row (the ordinary visibility already
        // excludes both; the capture door cannot reopen them).
        const foreign = await service().previewsFor(foreignId, [ordinary, managed]);
        expect(foreign.size).toBe(0);
        // Allowed: the managed screen rides the answer like any row's.
        allowAll();
        const allowed = await service().previewsFor(ownerId, [ordinary, managed]);
        expect(allowed.get(managed)).toEqual(["MANAGED REMOTE SCREEN"]);
        expect(allowed.get(ordinary)).toEqual(["ORDINARY SCREEN"]);
      } finally {
        previewCacheDrop(ordinary);
        previewCacheDrop(managed);
      }
    });
  });

  describe("log reads", () => {
    it("a refused managed pane 404s the log tail", async () => {
      const pane = await seedManaged("gate-log");
      const res = await call(`/${pane}/log`);
      expect(res.status).toBe(404);
    });

    it("managed cursor reads answer an explicit cursorExpired, never silent reuse (the plane-stamp arm)", async () => {
      const pane = await seedManaged("gate-log-gen", { logGeneration: 2 });
      allowAll();
      // A stale stamp: the explicit reset, with the CURRENT generation named.
      let res = await call(`/${pane}/log?from_byte=10&log_generation=1`);
      expect(res.status).toBe(200);
      let body = (await res.json()) as { cursorExpired?: boolean; logGeneration?: number; lines: string[] };
      expect(body.cursorExpired).toBe(true);
      expect(body.logGeneration).toBe(2);
      expect(body.lines).toEqual([]);
      // A missing stamp on a managed cursor read: the same explicit answer.
      res = await call(`/${pane}/log?from_byte=10`);
      body = (await res.json()) as typeof body;
      expect(body.cursorExpired).toBe(true);
      // The current stamp passes through to the real window read.
      res = await call(`/${pane}/log?from_byte=10&log_generation=2`);
      body = (await res.json()) as typeof body;
      expect(body.cursorExpired).toBeUndefined();
      expect(body.logGeneration).toBe(2);
      // A tail read needs no stamp and carries the current one.
      res = await call(`/${pane}/log`);
      body = (await res.json()) as typeof body;
      expect(body.cursorExpired).toBeUndefined();
      expect(body.logGeneration).toBe(2);
    });

    it("a node-side rotation rotates the PLANE's stamp and expires the held cursor (the reported arm, end to end)", async () => {
      // Gate C IMPORTANT 2: `ssh_panes.log_generation` was written only at
      // create (=1), so the check above compared against a constant and a
      // stale cursor reused bytes silently across every node-side rotation.
      // The contract is real now: the `log_read` answer echoes the node's
      // CURRENT generation, the plane persists it, and a reader stamped under
      // the old one gets the explicit expiry - through the ROUTE, with the
      // REAL launcher RPC chain to the scripted node.
      const pane = await seedManaged("gate-log-rotate");
      allowAll();
      // A controllable "rotation" on the machine: the answer table carries the
      // generation the node would report, and flipping `nodeGen` is exactly
      // what the sweep's rotateTerminalLogIfNeeded does to its own counter.
      sim.detach();
      resetNodeRegistryForTests();
      let nodeGen = 1;
      const logBytes = "hello managed\n";
      sim = attachScriptedNode(node, {
        log_read: (cmd) => {
          if (cmd.type !== "log_read") return new Error("wrong cmd");
          const full = enc.encode(logBytes);
          const end = Math.min(full.byteLength, cmd.fromByte + cmd.maxBytes);
          const bytes = full.subarray(cmd.fromByte, Math.min(end, full.byteLength));
          return {
            bytes_b64: Buffer.from(bytes).toString("base64"),
            next: cmd.fromByte + bytes.byteLength,
            size: full.byteLength,
            logGeneration: nodeGen,
          };
        },
        terminate: ok,
        kill: ok,
        input: ok,
      });
      try {
        // A cursor seeded under generation 1 reads normally while the node
        // still says 1 - the stamp's whole point is that the CURRENT value
        // passes (this is the arm the constant could never break).
        let res = await call(`/${pane}/log?from_byte=0&max_bytes=12&log_generation=1`);
        let body = (await res.json()) as {
          cursorExpired?: boolean;
          logGeneration?: number;
          lines: string[];
          nextByte: number;
        };
        expect(body.cursorExpired).toBeUndefined();
        expect(body.logGeneration).toBe(1);
        expect(body.lines.length).toBeGreaterThan(0);

        // The hourly sweep rotates on the machine. The reader still holds its
        // (1, offset) cursor - the NEXT read must never continue at that
        // offset into the fresh generation.
        nodeGen = 2;
        res = await call(`/${pane}/log?from_byte=6&max_bytes=64&log_generation=1`);
        body = (await res.json()) as typeof body;
        expect(body.cursorExpired).toBe(true);
        expect(body.lines).toEqual([]);
        expect(body.nextByte).toBe(0);
        expect(body.logGeneration).toBe(2);
        // The plane's persisted stamp moved WITH the node's - the constant is
        // dead, and the next read stamped 2 passes straight through.
        const row = await db
          .selectFrom("sshPanes")
          .select("logGeneration")
          .where("subshellId", "=", pane)
          .executeTakeFirstOrThrow();
        expect(row.logGeneration).toBe(2);
        res = await call(`/${pane}/log?from_byte=6&max_bytes=64&log_generation=2`);
        body = (await res.json()) as typeof body;
        expect(body.cursorExpired).toBeUndefined();
        expect(body.logGeneration).toBe(2);
        // A tail read with no cursor learns the new stamp the same way.
        nodeGen = 3;
        res = await call(`/${pane}/log`);
        body = (await res.json()) as typeof body;
        expect(body.cursorExpired).toBeUndefined();
        expect(body.logGeneration).toBe(3);
      } finally {
        // Restore the suite's shared scripted node for the cases that follow.
        sim.detach();
        resetNodeRegistryForTests();
        sim = attachScriptedNode(node, {
          terminate: ok,
          kill: ok,
          input: ok,
          log_read: () => ({ bytes_b64: "", next: 0, size: 0 }),
        });
      }
    });

    it("ordinary cursor reads never see the generation fields (contract untouched, echo or not)", async () => {
      const pane = await seedPane("gate-log-ordinary");
      const res = await call(`/${pane}/log?from_byte=0`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect("cursorExpired" in body).toBe(false);
      expect("logGeneration" in body).toBe(false);
      // The node could not answer a generation for an ordinary pane even if
      // asked (no SSH terminal state exists for it) - and the route shape
      // never grows the field for an ordinary row.
      sim.detach();
      resetNodeRegistryForTests();
      sim = attachScriptedNode(node, {
        log_read: () => ({ bytes_b64: "", next: 0, size: 0, logGeneration: 7 }),
        terminate: ok,
        kill: ok,
        input: ok,
      });
      try {
        const again = await call(`/${pane}/log?from_byte=0`);
        expect(((await again.json()) as Record<string, unknown>)["logGeneration"]).toBeUndefined();
      } finally {
        sim.detach();
        resetNodeRegistryForTests();
        sim = attachScriptedNode(node, {
          terminate: ok,
          kill: ok,
          input: ok,
          log_read: () => ({ bytes_b64: "", next: 0, size: 0 }),
        });
      }
    });
  });

  describe("input", () => {
    it("a refused managed pane 404s before the running check leaks anything", async () => {
      const pane = await seedManaged("gate-input");
      await subshells.update(pane, { status: "terminated", alive: 0 });
      const res = await call(`/${pane}/input`, { method: "POST", body: { text: "ls" } });
      expect(res.status).toBe(404);
      expect(sim.countOf("input")).toBe(0);
    });

    it("a PARKED managed pane answers the clean 409 on the managed branch too, dispatching nothing (Gate C minor 4)", async () => {
      // The two facts are the manager's posture, not an ordinary-branch quirk:
      // `status: running, alive: 0` (self-exited, restartable) must refuse
      // HERE, not dispatch a doomed stamped write and map a node error.
      const pane = await seedManaged("gate-input-parked");
      allowAll();
      await subshells.update(pane, { alive: 0 });
      const res = await call(`/${pane}/input`, { method: "POST", body: { text: "ls" } });
      expect(res.status).toBe(409);
      expect(((await res.json()) as { code: string }).code).toBe(BackendErrorCodes.SUBSHELL_NOT_RUNNING);
      expect(hookCalls.input).toEqual([]);
      expect(sim.countOf("input")).toBe(0);
    });

    it("an authorized managed write goes to the SSH input seam at the CURRENT generation, never a local shell", async () => {
      const pane = await seedManaged("gate-input-ok", { controlGeneration: 3 });
      allowAll();
      const res = await call(`/${pane}/input`, { method: "POST", body: { text: "ls" } });
      expect(res.status).toBe(200);
      expect(hookCalls.input).toEqual([{ subshellId: pane, text: "ls", submit: true, inputGeneration: 3 }]);
      expect(sim.countOf("input")).toBe(0); // nothing on the ordinary frame path
    });

    it("human control is a named 403 with the policy code, and types nothing", async () => {
      const pane = await seedManaged("gate-input-human", { controlOwner: "human" });
      scripted.paneSurface.set("input", { allow: false, code: "human_control" });
      const res = await call(`/${pane}/input`, { method: "POST", body: { text: "ls" } });
      expect(res.status).toBe(403);
      const body = (await res.json()) as { code: string; metadataSafe?: { sshPolicyCode?: string } };
      expect(body.code).toBe(BackendErrorCodes.SSH_ACCESS_DENIED);
      expect(body.metadataSafe?.sshPolicyCode).toBe("human_control");
      expect(hookCalls.input).toEqual([]);
    });

    it("without the SSH backend hooks the act refuses 503 instead of typing locally", async () => {
      const pane = await seedManaged("gate-input-nohooks");
      allowAll();
      setSshPaneHooksForTests(null);
      const res = await call(`/${pane}/input`, { method: "POST", body: { text: "ls" } });
      expect(res.status).toBe(503);
      expect(((await res.json()) as { code: string }).code).toBe(BackendErrorCodes.SSH_BACKEND_UNAVAILABLE);
      expect(sim.countOf("input")).toBe(0);
    });
  });

  describe("exec", () => {
    it("the marker helper never runs on a managed terminal even when the policy allows the surface", async () => {
      const pane = await seedManaged("gate-exec");
      allowAll();
      const res = await call(`/${pane}/exec`, { method: "POST", body: { command: "echo hi" } });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { code: string }).code).toBe(BackendErrorCodes.EXEC_SSH_UNSUPPORTED);
      expect(sim.countOf("input")).toBe(0);
    });

    it("a refused managed pane 404s exec", async () => {
      const pane = await seedManaged("gate-exec-deny");
      const res = await call(`/${pane}/exec`, { method: "POST", body: { command: "echo hi" } });
      expect(res.status).toBe(404);
    });
  });

  describe("restart / terminate / delete", () => {
    it("an authorized managed restart re-launches via the SSH seam, never the local revive", async () => {
      const pane = await seedManaged("gate-restart");
      allowAll();
      const res = await call(`/${pane}/restart`, { method: "POST", body: {} });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ id: pane, tmuxSocket: expect.any(String), promptDelivered: false });
      expect(hookCalls.restart).toEqual([pane]);
      expect(sim.countOf("launch")).toBe(0); // no connecting-node shell fallback
    });

    it("a managed restart prompt rides the SSH input seam at the current generation", async () => {
      const pane = await seedManaged("gate-restart-prompt", { controlGeneration: 5 });
      allowAll();
      const res = await call(`/${pane}/restart`, { method: "POST", body: { prompt: "do the thing" } });
      expect(res.status).toBe(200);
      expect(((await res.json()) as { promptDelivered?: boolean }).promptDelivered).toBe(true);
      expect(hookCalls.input).toEqual([{ subshellId: pane, text: "do the thing", submit: true, inputGeneration: 5 }]);
      expect(sim.countOf("prompt_deliver")).toBe(0);
    });

    it("prompt injection is its own surface: allowed restart + refused prompt refuses the WHOLE call, relaunch included", async () => {
      const pane = await seedManaged("gate-restart-prompt-deny");
      allowAll();
      scripted.paneSurface.set("prompt", { allow: false, code: "not_granted" });
      const res = await call(`/${pane}/restart`, { method: "POST", body: { prompt: "sneak in" } });
      expect(res.status).toBe(403);
      // Nothing happened: the refusal precedes the relaunch (deny precedes
      // effect, the house rule), so no SSH restart, no input hook, no launch.
      expect(hookCalls.restart).toEqual([]);
      expect(hookCalls.input).toEqual([]);
      expect(sim.countOf("launch")).toBe(0);
    });

    it("a refused managed pane 404s restart and writes nothing", async () => {
      const pane = await seedManaged("gate-restart-deny");
      const res = await call(`/${pane}/restart`, { method: "POST", body: {} });
      expect(res.status).toBe(404);
      expect(hookCalls.restart).toEqual([]);
    });

    it("terminate honors the policy first, then ends the pane (the ssh foreground dies with it)", async () => {
      const pane = await seedManaged("gate-terminate");
      const denied = await call(`/${pane}/terminate`, { method: "POST" });
      expect(denied.status).toBe(404);
      allowAll();
      const res = await call(`/${pane}/terminate`, { method: "POST" });
      expect(res.status).toBe(200);
      // The kill frame is the manager's teardown verb (`killSubshell`); the
      // tmux death takes the ssh foreground with it.
      expect(sim.countOf("kill")).toBe(1);
    });

    it("delete honors the policy first, then removes the row (and the managed marker cascades)", async () => {
      const pane = await seedManaged("gate-delete");
      const denied = await call(`/${pane}`, { method: "DELETE" });
      expect(denied.status).toBe(404);
      allowAll();
      const res = await call(`/${pane}`, { method: "DELETE" });
      expect(res.status).toBe(200);
      expect(await db.selectFrom("sshPanes").selectAll().where("subshellId", "=", pane).execute()).toEqual([]);
    });
  });

  describe("exec records and the after-unknown rule (ordinary panes)", () => {
    /**
     * Swap in a node whose pane log grows the sentinel receipts: every input
     * frame is recorded, and for each sentinel `printf` typed so far the pane
     * shows an output line and its `_DONE rc=0`. The log only ever grows, so
     * back-to-back execs each scan past the previous receipt and see their
     * own marker land.
     */
    function simWithMarkers(): void {
      sim.detach();
      resetNodeRegistryForTests();
      const typed: string[] = [];
      sim = attachScriptedNode(node, {
        input: (cmd) => {
          if (cmd.type === "input") typed.push(cmd.data);
          return undefined;
        },
        log_read: (cmd) => {
          if (cmd.type !== "log_read") return new Error("wrong");
          const tokens = [...typed.join("").matchAll(/__xcomm_([0-9a-f]{16})_DONE/g)].map((m) => m[1]);
          // The log GROWS monotonically (a growing pane, never a rewritten
          // window): one receipt per typed sentinel, oldest first.
          const text = tokens.length === 0 ? "" : `${tokens.map((t) => `out\n__xcomm_${t}_DONE rc=0\n`).join("")}$ `;
          const full = enc.encode(text);
          const end = Math.min(full.byteLength, cmd.fromByte + cmd.maxBytes);
          return {
            bytes_b64: Buffer.from(full.subarray(cmd.fromByte, end)).toString("base64"),
            next: end,
            size: full.byteLength,
          };
        },
        terminate: ok,
        kill: ok,
      });
    }

    it("exec answers its execution id and the status door reads the record back", async () => {
      const pane = await seedPane("gate-exec-status");
      simWithMarkers();
      const res = await call(`/${pane}/exec`, { method: "POST", body: { command: "echo out" } });
      expect(res.status).toBe(200);
      const answer = (await res.json()) as { status: string; executionId: string; exitCode: number };
      expect(answer.status).toBe("completed");
      expect(answer.exitCode).toBe(0);
      const status = await call(`/${pane}/execs/${answer.executionId}`);
      expect(status.status).toBe(200);
      const view = (await status.json()) as Record<string, unknown>;
      expect(view).toMatchObject({
        id: answer.executionId,
        subshellId: pane,
        state: "completed",
        exitCode: 0,
        inputGeneration: 1,
      });
      expect(view.createdAt).toStrictEqual(expect.any(String));
      expect(view.resolvedAt).toStrictEqual(expect.any(String));
    });

    it("after unknown, the automated caller is refused and types nothing; the human passes", async () => {
      const sibling = await seedPane("gate-unknown-sibling");
      const pane = await seedPane("gate-unknown-pane");
      simWithMarkers(); // the human's recovery exec (and the bearer's next one) must actually resolve
      const row = await subshells.findById(pane);
      await db
        .insertInto("sshTerminalExecs")
        .values({
          id: crypto.randomUUID(),
          subshellId: pane,
          paneIncarnation: row?.startedAt ?? "2026-10-04T00:00:00.000Z",
          initiatedBy: "agent",
          grantId: null,
          apiKeyId: null,
          inputGeneration: 1,
          markerToken: "0123456789abcdef",
          state: "unknown",
          createdAt: "2026-10-04T10:00:00.000Z",
          resolvedAt: "2026-10-04T10:00:01.000Z",
          outputTruncated: 0,
        })
        .execute();
      // A bearer (automated) caller: refused, nothing typed.
      const token = await issueSubshellToken(sibling, ownerId);
      let res = await call(`/${pane}/exec`, { method: "POST", body: { command: "echo hi" }, bearer: token });
      expect(res.status).toBe(409);
      expect(((await res.json()) as { code: string }).code).toBe(BackendErrorCodes.EXEC_UNKNOWN_RECOVERY);
      expect(sim.countOf("input")).toBe(0);
      // The pane's own human (cookie): passes the gate and runs (recovery).
      res = await call(`/${pane}/exec`, { method: "POST", body: { command: "echo hi" } });
      expect(res.status).toBe(200);
      expect(((await res.json()) as { status?: string }).status).toBe("completed");
      // The newer completed record clears the block for automated callers too.
      res = await call(`/${pane}/exec`, { method: "POST", body: { command: "echo again" }, bearer: token });
      expect(res.status).toBe(200);
    });

    // A 15 s per-test budget (bun's default is 5 s): the re-armed watcher polls
    // at the REAL production `EXEC_OBSERVE_POLL_MS` (5 s), so retiring it after
    // the pane row is killed needs one full poll. The internal wait-loop caps at
    // 8 s; the margin is for parallel-run drift. A fake clock cannot drive it
    // because the observation is armed module-scoped, outside the test's sleep.
    it("the status door re-arms observation for an outstanding record with no watcher", async () => {
      const pane = await seedPane("gate-rearm");
      const row = await subshells.findById(pane);
      const execId = crypto.randomUUID();
      await db
        .insertInto("sshTerminalExecs")
        .values({
          id: execId,
          subshellId: pane,
          paneIncarnation: row?.startedAt ?? "2026-10-04T00:00:00.000Z",
          initiatedBy: "human",
          grantId: null,
          apiKeyId: null,
          inputGeneration: 1,
          markerToken: "0123456789abcdef",
          state: "outstanding",
          createdAt: "2026-10-04T10:00:00.000Z",
          outputTruncated: 0,
        })
        .execute();
      const res = await call(`/${pane}/execs/${execId}`);
      expect(res.status).toBe(200);
      expect(((await res.json()) as { state: string }).state).toBe("outstanding");
      expect(observationActive(execId)).toBe(true);
      // End it honestly: kill the pane's row so the watcher's liveness test
      // fails and the loop retires (one 5 s poll), marking the record unknown.
      await subshells.update(pane, { status: "terminated", alive: 0 });
      const deadline = Date.now() + 8_000;
      while (observationActive(execId) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
      expect(observationActive(execId)).toBe(false);
      await cancelObservation(db, pane);
    }, 15_000);

    it("a record from another pane is not recoverable through this pane's door", async () => {
      const a = await seedPane("gate-status-a");
      const b = await seedPane("gate-status-b");
      await db
        .insertInto("sshTerminalExecs")
        .values({
          id: crypto.randomUUID(),
          subshellId: a,
          paneIncarnation: "2026-10-04T00:00:00.000Z",
          initiatedBy: "human",
          grantId: null,
          apiKeyId: null,
          inputGeneration: 1,
          markerToken: "0123456789abcdef",
          state: "completed",
          createdAt: "2026-10-04T10:00:00.000Z",
          resolvedAt: "2026-10-04T10:00:01.000Z",
          outputTruncated: 0,
          exitCode: 0,
        })
        .execute();
      const missing = await call(`/${b}/execs/${crypto.randomUUID()}`);
      expect(missing.status).toBe(404);
      // right id, wrong pane: the same 404.
      const row = await db
        .selectFrom("sshTerminalExecs")
        .select("id")
        .where("subshellId", "=", a)
        .executeTakeFirstOrThrow();
      const cross = await call(`/${b}/execs/${row.id}`);
      expect(cross.status).toBe(404);
    });
  });

  describe("human takeover / return", () => {
    it("machine credentials cannot act; an ordinary pane 404s; a managed pane moves control, fences, and invalidates", async () => {
      const sibling = await seedPane("gate-control-sibling");
      const token = await issueSubshellToken(sibling, ownerId);
      // bearer: 403 cookie_required (named)
      let res = await call("/whatever/ssh-control", { method: "POST", body: { mode: "human" }, bearer: token });
      // (unknown id: the gate's cookie check is the actor's own, so 403 precedes 404)
      expect(res.status).toBe(403);

      const ordinary = await seedPane("gate-control-ordinary");
      res = await call(`/${ordinary}/ssh-control`, { method: "POST", body: { mode: "human" } });
      expect(res.status).toBe(404); // takeover is a managed-pane act only

      const pane = await seedManaged("gate-control-managed", { controlGeneration: 1 });
      await db
        .insertInto("sshTerminalExecs")
        .values({
          id: crypto.randomUUID(),
          subshellId: pane,
          paneIncarnation: "2026-10-04T00:00:00.000Z",
          initiatedBy: "human",
          grantId: null,
          apiKeyId: null,
          inputGeneration: 1,
          markerToken: "0123456789abcdef",
          state: "outstanding",
          createdAt: "2026-10-04T10:00:00.000Z",
          outputTruncated: 0,
        })
        .execute();
      res = await call(`/${pane}/ssh-control`, { method: "POST", body: { mode: "human" } });
      expect(res.status).toBe(200);
      const view = (await res.json()) as { subshellId: string; controlOwner: string; controlGeneration: number };
      expect(view).toEqual({ subshellId: pane, controlOwner: "human", controlGeneration: 2 });
      // The node was fenced FIRST, with the raised generation...
      expect(hookCalls.control).toEqual([{ subshellId: pane, mode: "human", generation: 2 }]);
      // ...and the outstanding record is `unknown` now (the invalidation fact).
      const rec = await db
        .selectFrom("sshTerminalExecs")
        .select("state")
        .where("subshellId", "=", pane)
        .executeTakeFirstOrThrow();
      expect(rec.state).toBe("unknown");
      // A DB mirror read-back:
      const row = await db.selectFrom("sshPanes").selectAll().where("subshellId", "=", pane).executeTakeFirstOrThrow();
      expect(row.controlOwner).toBe("human");
      expect(row.controlGeneration).toBe(2);
    });

    it("takeover blocks the agent surface while it holds, and return unblocks at the new generation", async () => {
      const pane = await seedManaged("gate-control-cycle");
      allowAll();
      // The scripted policy models the control state itself (D does the same,
      // from the live row): input denies while human holds control.
      scripted.paneSurface.set("input", { allow: false, code: "human_control" });
      await call(`/${pane}/ssh-control`, { method: "POST", body: { mode: "human" } });
      let res = await call(`/${pane}/input`, { method: "POST", body: { text: "hi" } });
      expect(res.status).toBe(403);
      expect(hookCalls.input).toEqual([]);
      // Return control: policy's human arm allowed; EVERY transition raises
      // (seeded 1 -> takeover 2 -> return 3), and the agent's next write
      // carries the raised generation, never the one the takeover left.
      scripted.paneSurface.delete("input"); // back to the default allow
      allowAll();
      res = await call(`/${pane}/ssh-control`, { method: "POST", body: { mode: "agent" } });
      expect(res.status).toBe(200);
      expect(hookCalls.control.at(-1)).toEqual({ subshellId: pane, mode: "agent", generation: 3 });
      res = await call(`/${pane}/input`, { method: "POST", body: { text: "hi" } });
      expect(res.status).toBe(200);
      expect(hookCalls.input[0]?.inputGeneration).toBe(3);
    });

    it("without hooks the takeover refuses 503 and moves NOTHING", async () => {
      const pane = await seedManaged("gate-control-nohooks");
      setSshPaneHooksForTests(null);
      const res = await call(`/${pane}/ssh-control`, { method: "POST", body: { mode: "human" } });
      expect(res.status).toBe(503);
      const row = await db.selectFrom("sshPanes").selectAll().where("subshellId", "=", pane).executeTakeFirstOrThrow();
      expect(row.controlOwner).toBe("agent");
      expect(row.controlGeneration).toBe(1);
      expect(hookCalls.control).toEqual([]);
    });

    it("the policy's human arm is asked first: a cookie denial stops the transition", async () => {
      const pane = await seedManaged("gate-control-deny");
      scripted.humanConfig = { allow: false, code: "cookie_required" };
      const res = await call(`/${pane}/ssh-control`, { method: "POST", body: { mode: "human" } });
      expect(res.status).toBe(403);
      const row = await db.selectFrom("sshPanes").selectAll().where("subshellId", "=", pane).executeTakeFirstOrThrow();
      expect(row.controlGeneration).toBe(1);
    });

    it("the takeover act closes the pane's live terminal sockets within itself (the revoke-side ordering, mirrored)", async () => {
      // Gate C re-review round 1 moved the stream close to the beat the raise
      // commits, BEFORE the exec-invalidate/cancel awaits (a still-open
      // socket stamps its writes at the RAISED generation, which the node's
      // equal-or-higher rule accepts). The deterministic ordering proof lives
      // in the races suite (close observed inside the `ssh_input_control`
      // dispatch window); this pins the act's half: a registered viewer is
      // closed by the takeover itself, with the below-4000 retry code and
      // the named reason, before the response lands.
      const pane = await seedManaged("gate-control-closes");
      allowAll();
      const closed: Array<{ code: number; reason: string }> = [];
      const ws = {
        data: { viewerId: crypto.randomUUID(), subshellId: pane, canInput: true },
        send: () => undefined,
        close: (code?: number, reason?: string) => {
          closed.push({ code: code ?? 0, reason: reason ?? "" });
        },
      } as unknown as WsSocket;
      registerViewer(ws, pane);
      try {
        const res = await call(`/${pane}/ssh-control`, { method: "POST", body: { mode: "human" } });
        expect(res.status).toBe(200);
        expect(closed).toEqual([{ code: 1012, reason: "human took control" }]);
      } finally {
        resetLiveViewersForTests();
      }
    });
  });

  describe("summary counts (review I-1) and the human-class recovery door (review M5)", () => {
    it("a refused managed pane is absent from summary counts for owner, admin, and same-owner bearer", async () => {
      const ordinary = await seedPane("sum-ordinary");
      const managed = await seedManaged("sum-managed");
      const token = await issueSubshellToken(ordinary, ownerId);

      const counts = async (opts: { cookie?: string | null; bearer?: string } = {}) =>
        (await (await call("/summary", opts)).json()) as { total: number; running: number; waiting: number };

      // Denied (the placeholder default arm): the badge numbers never grew.
      // Review I-1's leak: the counts ride the SAME policy-filtered set as
      // the list, so an admin's or a sibling's arithmetic says "1 running",
      // not "2".
      expect(await counts()).toEqual({ total: 1, running: 1, waiting: 0 });
      expect((await counts({ bearer: token })).total).toBe(1); // same-owner sibling bearer: not counted
      expect(scripted.seenSurfaces.filter((x) => x === `${managed}:list_preview`).length).toBeGreaterThan(0);

      // The admin's seed asks the policy for the admin's OWN caller facts
      // (no bypass); the placeholder's deny is what hides the pane. Admin
      // visibility spans the whole DB, so the honest assertion is the DELTA
      // across the policy flip: exactly the managed pane moves.
      const adminDenied = (await counts({ cookie: adminCookie })).total;
      allowAll();
      expect((await counts({ cookie: adminCookie })).total).toBe(adminDenied + 1);

      // Allowed: the managed pane is a row like any other, counted by every
      // caller whose policy decision is allow.
      expect(await counts()).toEqual({ total: 2, running: 2, waiting: 0 });
      expect((await counts({ bearer: token })).total).toBe(2);
    });

    it("after unknown, a system key passes the recovery gate like a cookie human; only pane keys are refused", async () => {
      const pane = await seedPane("sum-afterunknown");
      const row = await subshells.findById(pane);
      await db
        .insertInto("sshTerminalExecs")
        .values({
          id: crypto.randomUUID(),
          subshellId: pane,
          paneIncarnation: row?.startedAt ?? "2026-10-04T00:00:00.000Z",
          initiatedBy: "agent",
          grantId: null,
          apiKeyId: null,
          inputGeneration: 1,
          markerToken: "0123456789abcdef",
          state: "unknown",
          createdAt: "2026-10-04T10:00:00.000Z",
          resolvedAt: "2026-10-04T10:00:01.000Z",
          outputTruncated: 0,
        })
        .execute();
      // A deliberate edit grant makes the pane reachable for the system
      // service user (grants DO reach it, unlike the pre-seeded nowhere
      // default); the pane itself is parked DEAD, so the refusal a caller
      // gets PROVES which gate answered: SUBSHELL_NOT_RUNNING means the
      // after-unknown gate was passed, EXEC_UNKNOWN_RECOVERY means it refused.
      const systemUserId = await ensureSystemUser();
      await db
        .insertInto("subshellShares")
        .values({
          id: crypto.randomUUID(),
          subshellId: pane,
          granteeUserId: systemUserId,
          permission: "edit",
          createdBy: ownerId,
          createdAt: new Date().toISOString(),
        })
        .execute();
      await subshells.update(pane, { status: "terminated", alive: 0 });
      const systemKey = (await getAuth().api.createApiKey({
        body: {
          name: `gate-sys-${crypto.randomUUID()}`,
          userId: systemUserId,
          metadata: { kind: "system" },
        },
      })) as unknown as { id: string; key: string };
      cleanup.push(async () => {
        await db.deleteFrom("subshellShares").where("granteeUserId", "=", systemUserId).execute();
        // The apikey table has no registry type (raw SQL lives only in
        // apikey-store); its own delete is the honest cleanup.
        deleteApiKey(systemKey.id);
      });

      // (M5, coordinator ruling 2026-10-05) system key = human-class: it
      // passes the after-unknown gate exactly like the cookie owner and
      // reaches the next fact (the pane is not running).
      const sys = await call(`/${pane}/exec`, {
        method: "POST",
        body: { command: "recovery" },
        cookie: null,
        bearer: systemKey.key,
      });
      expect(sys.status).toBe(409);
      expect(((await sys.json()) as { code: string }).code).toBe(BackendErrorCodes.SUBSHELL_NOT_RUNNING);
      // A cookie human passes the same gate for the same reason.
      const human = await call(`/${pane}/exec`, { method: "POST", body: { command: "recovery" } });
      expect(human.status).toBe(409);
      expect(((await human.json()) as { code: string }).code).toBe(BackendErrorCodes.SUBSHELL_NOT_RUNNING);
      // The automated actor - a pane key - is the one refused by the rule.
      const sibling = await seedPane("sum-afterunknown-sibling");
      const token = await issueSubshellToken(sibling, ownerId);
      const paneKey = await call(`/${pane}/exec`, {
        method: "POST",
        body: { command: "recovery" },
        cookie: null,
        bearer: token,
      });
      expect(paneKey.status).toBe(409);
      expect(((await paneKey.json()) as { code: string }).code).toBe(BackendErrorCodes.EXEC_UNKNOWN_RECOVERY);
    });
  });
});
