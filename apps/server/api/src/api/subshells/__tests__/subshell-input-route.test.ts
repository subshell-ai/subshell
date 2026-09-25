import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { hashPassword } from "better-auth/crypto";
import { Elysia } from "elysia";

/**
 * `POST /api/subshells/:id/input` (spec 2026-09-25 MCP DX): pane input over
 * REST, the door the `subshell mcp` `send_to_subshell` tool rides.
 *
 * The rules this suite pins are the ones the security posture already assigns
 * to terminal input, moved from the attach WebSocket to a POST: the gate is
 * `edit` (a `view` grantee 403s), a foreign row is a 404 (never a 403), and a
 * bearer pane key acts through its OWNER with boost and shares switched off,
 * exactly the restart path's rule (its own and its owner's other panes; a
 * foreign row invisible). A non-running row is refused 409 BEFORE the launcher
 * is touched, and an offline agent node maps to 409 NODE_OFFLINE through the
 * create/restart mapper.
 *
 * The byte contract is the live typing path's: the text lands verbatim through
 * `launcher.sendInput`, and Enter is the same CR byte the browser's terminal
 * sends when a human presses it. The scripted agent captures the decoded wire,
 * so the text-vs-text+Enter difference is read off the real `input` frames,
 * not off a mock's call count.
 */
import { subshellRoutes } from "@/api/subshells/index.js";
import { db } from "@/db/index.js";
import { NodesRepository } from "@/db/repositories/nodes.repository.js";
import { PresetsRepository } from "@/db/repositories/presets.repository.js";
import { SubshellSharesRepository } from "@/db/repositories/subshell-shares.repository.js";
import { SubshellsRepository } from "@/db/repositories/subshells.repository.js";
import { UsersRepository } from "@/db/repositories/users.repository.js";
import { errorHandlerPlugin } from "@/plugins/error-handler.plugin.js";
import { seedPreset } from "@/services/__tests__/helpers/seed-preset.js";
import { resetNodeRegistryForTests } from "@/services/nodes/node-registry.js";
import { ensureLocalNode } from "@/services/nodes/seed-local.js";
import { issueSubshellToken } from "@/services/subshell-tokens.js";
import { attachScriptedNode, ok, type ScriptedNode, statDirEcho } from "@/test-helpers/scripted-node.js";
import { deleteUserByEmailOrId, setupAuthTables, signIn } from "../../__tests__/helpers/auth-tables.js";

const app = new Elysia().use(errorHandlerPlugin).use(subshellRoutes);

const nodes = new NodesRepository(db);
const subshells = new SubshellsRepository(db);
const shares = new SubshellSharesRepository(db);

/** What a RUNNING pane's node answers: the create pair plus the `input` under test. */
const LIFECYCLE = { stat_dir: statDirEcho, launch: ok, input: ok };

describe("POST /api/subshells/:id/input (spec 2026-09-25)", () => {
  const ownerEmail = `inp-owner-${crypto.randomUUID()}@subshell.local`;
  const granteeEmail = `inp-grantee-${crypto.randomUUID()}@subshell.local`;
  const foreignEmail = `inp-foreign-${crypto.randomUUID()}@subshell.local`;
  const pw = "inputroute-pass-1";
  let ownerId: string;
  let ownerCookie: string;
  let granteeId: string;
  let granteeCookie: string;
  let foreignId: string;

  let presetId: string;
  let node: string; // agent node with a per-test scripted agent attached
  const createdSubshellIds: string[] = [];

  async function input(id: string, opts: { cookie?: string; bearer?: string; body: unknown }) {
    const headers = new Headers({ "content-type": "application/json" });
    if (opts.cookie) headers.set("cookie", `better-auth.session_token=${opts.cookie}`);
    if (opts.bearer) headers.set("authorization", `Bearer ${opts.bearer}`);
    return app.fetch(
      new Request(`http://localhost:3080/api/subshells/${id}/input`, {
        method: "POST",
        headers,
        body: JSON.stringify(opts.body),
      }),
    );
  }

  /** A RUNNING row on the scripted node, launched through the real create route. */
  async function createRunning(name: string): Promise<string> {
    const res = await app.fetch(
      new Request("http://localhost:3080/api/subshells", {
        method: "POST",
        headers: { "content-type": "application/json", cookie: `better-auth.session_token=${ownerCookie}` },
        body: JSON.stringify({
          harnessId: "claude-code",
          presetId,
          workingDir: "/srv/work/input",
          nodeId: node,
          name,
        }),
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string };
    createdSubshellIds.push(body.id);
    return body.id;
  }

  /** A row written straight to the table (status/node chosen by the caller). */
  async function directRow(overrides: {
    userId: string;
    status?: "running" | "terminated";
    name: string;
  }): Promise<string> {
    const id = crypto.randomUUID();
    createdSubshellIds.push(id);
    await subshells.create({
      id,
      userId: overrides.userId,
      presetId: null,
      harnessId: "claude-code",
      name: overrides.name,
      workingDir: "/tmp",
      tmuxSocket: `inp-sock-${id}`,
      nodeId: node,
      status: overrides.status ?? "terminated",
      alive: 0,
    });
    return id;
  }

  const errorBody = async (res: Response) => (await res.json()) as { code: string; message: string };
  const inputBytes = (sim: ScriptedNode) => sim.cmdsOf("input").map((c) => c.data);

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
    granteeId = await users.createUser({
      email: granteeEmail,
      name: granteeEmail,
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
    granteeCookie = await signIn(granteeEmail, pw);

    presetId = await seedPreset(new PresetsRepository(db), { userId: ownerId, name: "inp-src" });
    node = crypto.randomUUID();
    await nodes.create({ id: node, ownerUserId: ownerId, name: `inp-${node.slice(0, 8)}`, kind: "agent" });
    await nodes.applyInventory(
      node,
      JSON.stringify([{ harnessId: "claude-code", installed: true, binaryPath: "/usr/bin/claude" }]),
    );
  });

  afterAll(async () => {
    resetNodeRegistryForTests();
    for (const id of createdSubshellIds) await db.deleteFrom("subshells").where("id", "=", id).execute();
    await nodes.deleteById(node);
    await db.deleteFrom("presets").where("id", "=", presetId).execute();
    for (const email of [ownerEmail, granteeEmail, foreignEmail]) await deleteUserByEmailOrId(email);
  });

  it("default submit types the text then the same CR the live typing path carries", async () => {
    const sim = attachScriptedNode(node, LIFECYCLE);
    try {
      const id = await createRunning("in-submit");
      const res = await input(id, { cookie: ownerCookie, body: { text: "hello pane" } });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
      // Two frames, in order: the text verbatim, then the CR byte a browser
      // terminal sends for Enter. No row write happens on this path.
      expect(inputBytes(sim)).toEqual(["hello pane", "\r"]);
      expect((await subshells.findById(id))?.status).toBe("running");
    } finally {
      sim.detach();
    }
  });

  it("submit:false types the text alone, no Enter (an edit at the prompt)", async () => {
    const sim = attachScriptedNode(node, LIFECYCLE);
    try {
      const id = await createRunning("in-draft");
      const res = await input(id, { cookie: ownerCookie, body: { text: "draft only", submit: false } });
      expect(res.status).toBe(200);
      expect(inputBytes(sim)).toEqual(["draft only"]);
    } finally {
      sim.detach();
    }
  });

  it("gate: a view grantee 403s and types nothing; an edit grantee 200s", async () => {
    const sim = attachScriptedNode(node, LIFECYCLE);
    try {
      const id = await createRunning("in-gate");
      await shares.replaceForSubshell(id, [{ granteeUserId: granteeId, permission: "view" }], ownerId);
      const denied = await input(id, { cookie: granteeCookie, body: { text: "may not type" } });
      expect(denied.status).toBe(403);
      expect(sim.countOf("input")).toBe(0);

      await shares.replaceForSubshell(id, [{ granteeUserId: granteeId, permission: "edit" }], ownerId);
      const granted = await input(id, { cookie: granteeCookie, body: { text: "edit types" } });
      expect(granted.status).toBe(200);
      expect(inputBytes(sim)).toEqual(["edit types", "\r"]);
    } finally {
      sim.detach();
    }
  });

  it("bearer pane key: the owner's OTHER running subshell 200s, a foreign row 404s", async () => {
    const sim = attachScriptedNode(node, LIFECYCLE);
    try {
      const paneA = await createRunning("in-pane-a"); // the token's own subshell
      const other = await createRunning("in-other"); // the owner's OTHER running row
      const key = await issueSubshellToken(paneA, ownerId);
      // The §4 surface restart already has: raw REST resolves the pane's key
      // as its OWNER (boost and shares off), so the owner's other rows pass
      // the edit gate.
      const res = await input(other, { bearer: key, body: { text: "sibling says hi", submit: false } });
      expect(res.status).toBe(200);
      expect(inputBytes(sim)).toEqual(["sibling says hi"]);

      // A foreign row is INVISIBLE to the bearer, never a 403: same 404 the
      // cookie stranger gets, so the id is not an existence oracle.
      const foreign = await directRow({ userId: foreignId, status: "running", name: "in-foreign" });
      const denied = await input(foreign, { bearer: key, body: { text: "probe" } });
      expect(denied.status).toBe(404);
    } finally {
      sim.detach();
    }
  });

  it("a non-running row 409s SUBSHELL_NOT_RUNNING before the launcher is touched", async () => {
    const sim = attachScriptedNode(node, LIFECYCLE);
    try {
      const id = await directRow({ userId: ownerId, status: "terminated", name: "in-dead" });
      const res = await input(id, { cookie: ownerCookie, body: { text: "wake up" } });
      expect(res.status).toBe(409);
      expect((await errorBody(res)).code).toBe("SUBSHELL_NOT_RUNNING");
      expect(sim.countOf("input")).toBe(0); // refused before any pane was asked
    } finally {
      sim.detach();
    }
  });

  it("a PARKED row (status running, alive 0 — the self-exit state) 409s, not a 500, and types nothing", async () => {
    // What a pane that exited on its own actually leaves behind: the
    // LIFECYCLE intent still says `running` (parked is what auto-restart and
    // "Start again" revive from) while the LIVENESS fact says 0, and the
    // pane's session is gone. A guard on `status` alone sails into the dead
    // session and answers 500 (the live incident 2026-09-25: cross-node MCP
    // sends failing after a remote pane terminated); the honest answer is the
    // same 409, because `alive` is the fact the send actually needs.
    const sim = attachScriptedNode(node, LIFECYCLE);
    try {
      const id = await directRow({ userId: ownerId, status: "running", name: "in-parked" });
      const res = await input(id, { cookie: ownerCookie, body: { text: "wake up" } });
      expect(res.status).toBe(409);
      expect((await errorBody(res)).code).toBe("SUBSHELL_NOT_RUNNING");
      // Nothing reaches the machine: an agent-facing "ok" here would be the
      // silent lie (bytes into a session that does not exist).
      expect(sim.countOf("input")).toBe(0);
    } finally {
      sim.detach();
    }
  });

  it("an offline agent node maps to 409 NODE_OFFLINE (the create/restart mapper)", async () => {
    const sim = attachScriptedNode(node, LIFECYCLE);
    const id = await createRunning("in-offline");
    sim.detach(); // the machine drops; the row still reads running
    const res = await input(id, { cookie: ownerCookie, body: { text: "anyone there" } });
    expect(res.status).toBe(409);
    expect((await errorBody(res)).code).toBe("NODE_OFFLINE");
  });
});
