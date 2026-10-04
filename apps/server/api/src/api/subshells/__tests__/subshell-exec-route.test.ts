import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { hashPassword } from "better-auth/crypto";
import { Elysia } from "elysia";

/**
 * `POST /api/subshells/:id/exec` (spec 2026-10-02): one shell command run in
 * a TERMINAL pane, answered with its output and exit code, over REST.
 *
 * The gate rules are the input route's, mirrored verbatim (the service's
 * `execInTerminal` reuses its `#gate`): `edit` (a `view` grantee 403s), a
 * foreign row is a 404, and a bearer pane key acts through its OWNER with
 * boost and shares off. This suite additionally pins what the ROUTE adds to
 * the service: the body shape (empty and oversized commands fail schema
 * validation with nothing typed) and that `timeoutMs` out of range is a
 * CLAMP, not a refusal - a caller asking 5 ms still gets a 200.
 *
 * The scripted log is drawn LAZILY from the frames the node actually received
 * (the idiom `subshells-exec.test.ts` refined): until all four `input` frames
 * land the pane's log is empty (size 0 answers the quiet probes), and once
 * they have, the log carries the sentinel line for the token read back off
 * the typed printf frame. Completion here therefore proves the route wired
 * the real service verb, not a stub.
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
import {
  attachScriptedNode,
  ok,
  type ScriptedHandler,
  type ScriptedNode,
  statDirEcho,
} from "@/test-helpers/scripted-node.js";
import { deleteUserByEmailOrId, setupAuthTables, signIn } from "../../__tests__/helpers/auth-tables.js";

const app = new Elysia().use(errorHandlerPlugin).use(subshellRoutes);

const nodes = new NodesRepository(db);
const subshells = new SubshellsRepository(db);
const shares = new SubshellSharesRepository(db);

/** What a RUNNING pane's node answers; the exec suites extend it with `log_read`. */
const LIFECYCLE = { stat_dir: statDirEcho, launch: ok };

const enc = new TextEncoder();
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");

/** The sentinel printf the service types third; the token is drawn per call. */
const SENTINEL_FRAME_RE = /__xcomm_([0-9a-f]{16})_DONE/;

/**
 * The scripted pane's whole log as a function of the `input` frames it has
 * received: nothing until the command+CR+sentinel+CR quartet has landed, then
 * one output line and the sentinel answer for the token IN that typed frame
 * (rc 0), with the next prompt left unterminated behind it.
 */
function scriptedExecLog(typed: string[]): string {
  const sentinelFrame = typed[2];
  if (typed.length < 4 || sentinelFrame === undefined) return "";
  const token = SENTINEL_FRAME_RE.exec(sentinelFrame)?.[1];
  if (!token) return "";
  return `out line\n__xcomm_${token}_DONE rc=0\n$ `;
}

/** One `log_read` window over a whole-log string, agent-shaped. */
function windowOver(text: string, fromByte: number, maxBytes: number) {
  const full = enc.encode(text);
  const end = Math.min(full.byteLength, fromByte + maxBytes);
  return { bytes_b64: b64(full.subarray(fromByte, end)), next: end, size: full.byteLength };
}

/** `log_read` over the frame-drawn log: probes see size 0, cursors see the answer. */
function execLogRead(typed: string[]): ScriptedHandler {
  return (cmd) => {
    if (cmd.type !== "log_read") return new Error(`exec sim: wrong cmd ${cmd.type}`);
    return windowOver(scriptedExecLog(typed), cmd.fromByte, cmd.maxBytes);
  };
}

/** An `input` handler that captures the decoded bytes and answers the bare ok. */
function typingInto(typed: string[]): ScriptedHandler {
  return (cmd) => {
    if (cmd.type === "input") typed.push(cmd.data);
    return undefined;
  };
}

/** The four frames one completed exec types: command, CR, sentinel printf, CR. */
const fourFramesTyped = (sim: ScriptedNode) => sim.cmdsOf("input").map((c) => c.data).length === 4;

describe("POST /api/subshells/:id/exec (spec 2026-10-02)", () => {
  const ownerEmail = `execr-owner-${crypto.randomUUID()}@subshell.local`;
  const granteeEmail = `execr-grantee-${crypto.randomUUID()}@subshell.local`;
  const foreignEmail = `execr-foreign-${crypto.randomUUID()}@subshell.local`;
  const pw = "execroute-pass-1";
  let ownerId: string;
  let ownerCookie: string;
  let granteeId: string;
  let granteeCookie: string;
  let foreignCookie: string;

  let presetId: string;
  let node: string; // agent node with a per-test scripted agent attached
  const createdSubshellIds: string[] = [];

  async function exec(id: string, opts: { cookie?: string; bearer?: string; body: unknown }) {
    const headers = new Headers({ "content-type": "application/json" });
    if (opts.cookie) headers.set("cookie", `better-auth.session_token=${opts.cookie}`);
    if (opts.bearer) headers.set("authorization", `Bearer ${opts.bearer}`);
    return app.fetch(
      new Request(`http://localhost:3080/api/subshells/${id}/exec`, {
        method: "POST",
        headers,
        body: JSON.stringify(opts.body),
      }),
    );
  }

  /** A row written straight to the table (harness/status/alive chosen by the caller). */
  async function directRow(overrides: {
    name: string;
    userId?: string;
    harnessId?: string;
    status?: "running" | "terminated";
    alive?: 0 | 1;
  }): Promise<string> {
    const id = crypto.randomUUID();
    createdSubshellIds.push(id);
    await subshells.create({
      id,
      userId: overrides.userId ?? ownerId,
      presetId: null,
      harnessId: overrides.harnessId ?? "terminal",
      name: overrides.name,
      workingDir: "/tmp",
      tmuxSocket: `execr-sock-${id}`,
      nodeId: node,
      status: overrides.status ?? "running",
      alive: overrides.alive ?? 1,
    });
    return id;
  }

  const errorBody = async (res: Response) => (await res.json()) as { code: string; message: string };

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
    await users.createUser({
      email: foreignEmail,
      name: foreignEmail,
      passwordHash: await hashPassword(pw),
      role: "user",
    });
    ownerCookie = await signIn(ownerEmail, pw);
    granteeCookie = await signIn(granteeEmail, pw);
    foreignCookie = await signIn(foreignEmail, pw);

    presetId = await seedPreset(new PresetsRepository(db), { userId: ownerId, name: "execr-src" });
    node = crypto.randomUUID();
    await nodes.create({ id: node, ownerUserId: ownerId, name: `execr-${node.slice(0, 8)}`, kind: "agent" });
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

  it("happy: the owner cookie 200s with the sentinel answer, and the node saw the four input frames", async () => {
    const typed: string[] = [];
    const sim = attachScriptedNode(node, { ...LIFECYCLE, input: typingInto(typed), log_read: execLogRead(typed) });
    try {
      const id = await directRow({ name: "execr-happy" });
      const res = await exec(id, { cookie: ownerCookie, body: { command: "echo hi" } });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        status: string;
        exitCode: number | null;
        output: string;
        truncated: boolean;
        nextByte: number;
      };
      expect(body.status).toBe("completed");
      expect(body.exitCode).toBe(0);
      expect(body.output).toContain("out line");
      expect(body.truncated).toBe(false);
      expect(body.nextByte).toBeGreaterThan(0);
      // Four frames in order: the command verbatim, the CR the live typing path
      // carries, the sentinel printf for a fresh token, another CR.
      const frames = sim.cmdsOf("input").map((c) => c.data);
      expect(frames).toHaveLength(4);
      expect(frames.slice(0, 2)).toEqual(["echo hi", "\r"]);
      expect(frames[2]).toMatch(/^printf '__xcomm_[0-9a-f]{16}_DONE rc=%s\\n' "\$\?"$/);
      expect(frames[3]).toBe("\r");
    } finally {
      sim.detach();
    }
  });

  it("gate: a view grantee 403s and types nothing", async () => {
    const sim = attachScriptedNode(node, LIFECYCLE);
    try {
      const id = await directRow({ name: "execr-gate" });
      await shares.replaceForSubshell(id, [{ granteeUserId: granteeId, permission: "view" }], ownerId);
      const denied = await exec(id, { cookie: granteeCookie, body: { command: "echo hi" } });
      expect(denied.status).toBe(403);
      expect(sim.countOf("input")).toBe(0);
    } finally {
      sim.detach();
    }
  });

  it("a foreign caller 404s, never a 403 on the way", async () => {
    const sim = attachScriptedNode(node, LIFECYCLE);
    try {
      const id = await directRow({ name: "execr-foreign" });
      const res = await exec(id, { cookie: foreignCookie, body: { command: "echo hi" } });
      expect(res.status).toBe(404);
      expect(sim.countOf("input")).toBe(0);
    } finally {
      sim.detach();
    }
  });

  it("bearer pane key of the SAME owner acts (edit rides the owner path) and types the four frames", async () => {
    const typed: string[] = [];
    const sim = attachScriptedNode(node, { ...LIFECYCLE, input: typingInto(typed), log_read: execLogRead(typed) });
    try {
      const paneA = await directRow({ name: "execr-pane-a" }); // the token's own subshell
      const other = await directRow({ name: "execr-other" }); // the owner's OTHER running terminal row
      const key = await issueSubshellToken(paneA, ownerId);
      const res = await exec(other, { bearer: key, body: { command: "echo hi" } });
      expect(res.status).toBe(200);
      expect(fourFramesTyped(sim)).toBe(true);
    } finally {
      sim.detach();
    }
  });

  it("body validation: empty and oversized commands 400 with nothing typed", async () => {
    const sim = attachScriptedNode(node, LIFECYCLE);
    try {
      const id = await directRow({ name: "execr-validation" });
      const empty = await exec(id, { cookie: ownerCookie, body: { command: "" } });
      expect(empty.status).toBe(400);
      expect((await errorBody(empty)).code).toBe("INPUT_VALIDATION_ERROR");

      const oversized = await exec(id, { cookie: ownerCookie, body: { command: "x".repeat(20001) } });
      expect(oversized.status).toBe(400);
      expect((await errorBody(oversized)).code).toBe("INPUT_VALIDATION_ERROR");

      // Neither attempt reached the pane: the shape check precedes every gate.
      expect(sim.countOf("input")).toBe(0);
    } finally {
      sim.detach();
    }
  });

  it("timeoutMs 5 completes 200: the clamp is a pull-in, not a schema refusal", async () => {
    const typed: string[] = [];
    const sim = attachScriptedNode(node, { ...LIFECYCLE, input: typingInto(typed), log_read: execLogRead(typed) });
    try {
      const id = await directRow({ name: "execr-clamp" });
      const res = await exec(id, { cookie: ownerCookie, body: { command: "x", timeoutMs: 5 } });
      // 5 ms is below the floor the service pulls up to (1000); the SERVICE is
      // the single clamp authority, so the route answers 200, never 400.
      expect(res.status).toBe(200);
      expect(fourFramesTyped(sim)).toBe(true);
    } finally {
      sim.detach();
    }
  });

  it("an AGENT-harness row 400s EXEC_TERMINAL_ONLY", async () => {
    const sim = attachScriptedNode(node, LIFECYCLE);
    try {
      const id = await directRow({ name: "execr-agent", harnessId: "claude-code" });
      const res = await exec(id, { cookie: ownerCookie, body: { command: "echo hi" } });
      expect(res.status).toBe(400);
      expect((await errorBody(res)).code).toBe("EXEC_TERMINAL_ONLY");
      expect(sim.countOf("input")).toBe(0);
    } finally {
      sim.detach();
    }
  });

  // The input route's offline idiom verbatim in shape: the scripted machine
  // is detached AFTER the row lands, so the row still reads running while the
  // registry holds no connection. The ROUTE is where the offline refusal is
  // pinned (the service test could only re-pick the same machine): exec hits
  // the mapper at the first quiet-probe read, before anything is typed.
  it("an offline agent node maps to 409 NODE_OFFLINE (the create/restart mapper)", async () => {
    const sim = attachScriptedNode(node, LIFECYCLE);
    const id = await directRow({ name: "execr-offline" }); // terminal harness, running row
    sim.detach(); // the machine drops; the row still reads running
    const res = await exec(id, { cookie: ownerCookie, body: { command: "echo hi" } });
    expect(res.status).toBe(409);
    expect((await errorBody(res)).code).toBe("NODE_OFFLINE");
    // Nothing reached the pane: the refusal is the missing wire itself, and
    // it precedes the typing (the quiet probe is the first RPC the verb makes).
    expect(sim.countOf("input")).toBe(0);
    expect(sim.countOf("log_read")).toBe(0);
  });

  it("a dead row 409s SUBSHELL_NOT_RUNNING before any frame", async () => {
    const sim = attachScriptedNode(node, LIFECYCLE);
    try {
      const id = await directRow({ name: "execr-dead", status: "terminated", alive: 0 });
      const res = await exec(id, { cookie: ownerCookie, body: { command: "echo hi" } });
      expect(res.status).toBe(409);
      expect((await errorBody(res)).code).toBe("SUBSHELL_NOT_RUNNING");
      // Refused before the quiet probes and the typing alike (the two facts come first).
      expect(sim.countOf("input")).toBe(0);
      expect(sim.countOf("log_read")).toBe(0);
    } finally {
      sim.detach();
    }
  });
});
