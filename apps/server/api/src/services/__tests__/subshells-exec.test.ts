import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { ApiError, BackendErrorCodes } from "@internal/backend-errors";
import { hashPassword } from "better-auth/crypto";

/**
 * `SubshellsService.execInTerminal` (spec 2026-10-02): run ONE shell command in
 * a TERMINAL pane and answer with its output and exit code, over the sentinel
 * protocol. The service is exercised directly: the gates themselves are the
 * input route's pinned rules (this verb mirrors them verbatim), so this suite
 * pins the two NEW refusals (terminal-type, in-flight lease), the ordering
 * that keeps them behind the two facts, and the byte contract on the happy
 * path: four `input` frames (command, CR, sentinel printf, CR) and a completed
 * wait answered through the scripted node's `log_read` windows.
 *
 * The scripted log is drawn LAZILY from the frames the node actually received:
 * until all four `input` frames have landed the pane's log is empty (size 0
 * answers the quiet probes), and once they have, the log text carries the
 * sentinel line for the token read back off the typed printf frame. That is
 * the honest shape of a pane answering its own shell, and it keeps the service
 * free of a token-injection test seam: the token is always production's own
 * `execSentinelToken()`, and a completion proves scanner and frame agree.
 */
import { db } from "@/db/index.js";
import { NodesRepository } from "@/db/repositories/nodes.repository.js";
import { PresetsRepository } from "@/db/repositories/presets.repository.js";
import { SubshellsRepository } from "@/db/repositories/subshells.repository.js";
import { UsersRepository } from "@/db/repositories/users.repository.js";
import { ApiContext } from "@/lib/context.js";
import { seedPreset } from "@/services/__tests__/helpers/seed-preset.js";
import { resetNodeRegistryForTests } from "@/services/nodes/node-registry.js";
import { ensureLocalNode } from "@/services/nodes/seed-local.js";
import { SubshellsService } from "@/services/subshells.service.js";
import { attachScriptedNode, ok, type ScriptedHandler, statDirEcho } from "@/test-helpers/scripted-node.js";
import { getLogger } from "@/utils/logger.js";
import { deleteUserByEmailOrId, setupAuthTables } from "../../api/__tests__/helpers/auth-tables.js";

const nodes = new NodesRepository(db);
const subshells = new SubshellsRepository(db);

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

async function expectRefusal(promise: Promise<unknown>): Promise<ApiError> {
  const err = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err, "expected the call to refuse").toBeInstanceOf(ApiError);
  return err as ApiError;
}

describe("SubshellsService.execInTerminal (spec 2026-10-02)", () => {
  const ownerEmail = `exec-owner-${crypto.randomUUID()}@subshell.local`;
  const pw = "execsvc-pass-1";
  let ownerId: string;

  let presetId: string;
  let node: string; // agent node with a per-test scripted agent attached
  const createdSubshellIds: string[] = [];
  let ctx: ApiContext;

  /** A row written straight to the table (harness/status/alive chosen by the caller). */
  async function directRow(overrides: {
    harnessId: string;
    name: string;
    status?: "running" | "terminated";
    alive?: 0 | 1;
  }): Promise<string> {
    const id = crypto.randomUUID();
    createdSubshellIds.push(id);
    await subshells.create({
      id,
      userId: ownerId,
      presetId: null,
      harnessId: overrides.harnessId,
      name: overrides.name,
      workingDir: "/tmp",
      tmuxSocket: `exec-sock-${id}`,
      nodeId: node,
      status: overrides.status ?? "running",
      alive: overrides.alive ?? 1,
    });
    return id;
  }

  // ownerId is assigned in beforeAll (after setupAuthTables + signIn), so the
  // seed is built per call, not captured at describe scope.
  const cookieSeed = () => ({
    actor: "cookie" as const,
    userId: ownerId,
    principal: `user:${ownerId}`,
    apiKeyId: null,
  });
  const exec = (id: string, command = "echo hi", timeoutMs?: number) =>
    ctx.services.subshells.execInTerminal(ownerId, id, command, timeoutMs, cookieSeed());

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

    presetId = await seedPreset(new PresetsRepository(db), { userId: ownerId, name: "exec-src" });
    node = crypto.randomUUID();
    await nodes.create({ id: node, ownerUserId: ownerId, name: `exec-${node.slice(0, 8)}`, kind: "agent" });
    await nodes.applyInventory(
      node,
      JSON.stringify([{ harnessId: "claude-code", installed: true, binaryPath: "/usr/bin/claude" }]),
    );
    ctx = new ApiContext({ db, log: getLogger() });
  });

  afterAll(async () => {
    resetNodeRegistryForTests();
    for (const id of createdSubshellIds) await db.deleteFrom("subshells").where("id", "=", id).execute();
    await nodes.deleteById(node);
    await db.deleteFrom("presets").where("id", "=", presetId).execute();
    await deleteUserByEmailOrId(ownerEmail);
  });

  it("an AGENT-harness pane 400s EXEC_TERMINAL_ONLY and the type gate precedes even the probe", async () => {
    const sim = attachScriptedNode(node, LIFECYCLE);
    try {
      const id = await directRow({ harnessId: "claude-code", name: "exec-agent" });
      const err = await expectRefusal(exec(id));
      expect(err.statusCode).toBe(400);
      expect(err.code).toBe(BackendErrorCodes.EXEC_TERMINAL_ONLY);
      // A refusal types nothing, and it does not even open the quiet window:
      // an agent pane would eat the line into its own input box, and the
      // probe is only owed to panes that could accept the typing.
      expect(sim.countOf("input")).toBe(0);
      expect(sim.countOf("log_read")).toBe(0);
    } finally {
      sim.detach();
    }
  });

  it("a growing log between the quiet probes 409s EXEC_PANE_BUSY and types nothing", async () => {
    let probes = 0;
    const busyLog: ScriptedHandler = (cmd) => {
      if (cmd.type !== "log_read") return new Error(`exec sim: wrong cmd ${cmd.type}`);
      // The whole-file size moves every probe: the pane is producing output,
      // so the second probe never agrees with the first.
      probes += 1;
      return { bytes_b64: "", next: 0, size: 8 + probes };
    };
    const sim = attachScriptedNode(node, { ...LIFECYCLE, log_read: busyLog });
    try {
      const id = await directRow({ harnessId: "terminal", name: "exec-busy" });
      const err = await expectRefusal(exec(id));
      expect(err.statusCode).toBe(409);
      expect(err.code).toBe(BackendErrorCodes.EXEC_PANE_BUSY);
      expect(sim.countOf("input")).toBe(0); // the refusal never touches the pane
      expect(probes).toBe(2); // the verdict is exactly two reads, never one or three
    } finally {
      sim.detach();
    }
  });

  it("types command+Enter, sentinel+Enter, and answers with the rc", async () => {
    const typed: string[] = [];
    const sim = attachScriptedNode(node, {
      ...LIFECYCLE,
      input: typingInto(typed),
      log_read: execLogRead(typed),
    });
    try {
      const id = await directRow({ harnessId: "terminal", name: "exec-happy" });
      const answer = await exec(id);
      expect(answer).toMatchObject({ status: "completed", exitCode: 0, truncated: false });
      expect(answer.output).toContain("out line");
      // Four frames in order: the command verbatim, the CR the live typing path
      // carries, the sentinel printf for a fresh token, another CR.
      const frames = sim.cmdsOf("input").map((c) => c.data);
      expect(frames.slice(0, 2)).toEqual(["echo hi", "\r"]);
      expect(frames[2]).toMatch(/^printf '__xcomm_[0-9a-f]{16}_DONE rc=%s\\n' "\$\?"$/);
      expect(frames[3]).toBe("\r");
      // The wait started where the quiet probes stopped (size 0), and the
      // answer's cursor sits right after the sentinel line, the unterminated
      // prompt after it belongs to the next reader.
      const cursorReads = sim.cmdsOf("log_read").filter((c) => !(c.fromByte === 0 && c.maxBytes === 1));
      expect(cursorReads[0]?.fromByte).toBe(0);
      expect(enc.encode(scriptedExecLog(typed)).subarray(answer.nextByte)).toEqual(enc.encode("$ "));
    } finally {
      sim.detach();
    }
  });

  it("a second exec on the same pane while one is in flight 409s EXEC_IN_FLIGHT", async () => {
    const typed: string[] = [];
    let probes = 0;
    let releaseSecondProbe: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      releaseSecondProbe = resolve;
    });
    const logRead: ScriptedHandler = (cmd) => {
      if (cmd.type !== "log_read") return new Error(`exec sim: wrong cmd ${cmd.type}`);
      if (cmd.fromByte === 0 && cmd.maxBytes === 1) {
        probes += 1;
        // Hold the SECOND quiet probe: the first call is inside its window,
        // lease held, nothing typed yet.
        if (probes === 2) return held.then(() => windowOver("", cmd.fromByte, cmd.maxBytes));
        return windowOver("", cmd.fromByte, cmd.maxBytes);
      }
      return execLogRead(typed)(cmd);
    };
    const sim = attachScriptedNode(node, { ...LIFECYCLE, input: typingInto(typed), log_read: logRead });
    try {
      const id = await directRow({ harnessId: "terminal", name: "exec-lease" });
      const first = exec(id);
      // The lease is set before the first probe can reach the wire, so one
      // observed frame proves the in-flight entry is in place.
      for (let i = 0; sim.countOf("log_read") === 0 && i < 200; i++) await new Promise((r) => setTimeout(r, 5));
      expect(sim.countOf("log_read")).toBe(1);

      // The refused call goes through a SECOND service instance over the same
      // repos, which is what two racing requests actually are (contextPlugin
      // builds `SubshellsService` fresh per request): the refusal must come
      // from the process-wide lease, not one instance's map. Were the map
      // per-instance, this second service would see nothing in flight.
      const twin = new SubshellsService({ log: ctx.log, db: ctx.db, repos: ctx.repos });
      const err = await expectRefusal(twin.execInTerminal(ownerId, id, "echo hi", undefined, cookieSeed()));
      expect(err.statusCode).toBe(409);
      expect(err.code).toBe(BackendErrorCodes.EXEC_IN_FLIGHT);
      expect(sim.countOf("input")).toBe(0); // the refused call typed nothing at all

      releaseSecondProbe();
      const answer = await first; // the held call completes normally: refusal of a sibling never poisons it
      expect(answer).toMatchObject({ status: "completed", exitCode: 0 });
      expect(sim.cmdsOf("input").map((c) => c.data)).toHaveLength(4); // still only the first call's frames
    } finally {
      sim.detach();
    }
  });

  it("a pane that never answers the sentinel times out: the answer, and the ruling-2 receipt", async () => {
    const typed: string[] = [];
    // The scripted pane ECHOES the frames it is given but never runs the
    // sentinel printf, so the wait can only end on the deadline. The echo
    // stays honest: the anchored scanner regex cannot match an echoed
    // command (it carries quotes and a literal `$?`), exactly the shape the
    // pane-exec suite pins. Log text is drawn LAZILY from `typed` like the
    // other cases, so the quiet probes still see size 0 before the typing.
    const echoLog: ScriptedHandler = (cmd) => {
      if (cmd.type !== "log_read") return new Error(`exec sim: wrong cmd ${cmd.type}`);
      const text = typed
        .filter((frame) => frame !== "\r")
        .map((frame) => `${frame}\n`)
        .join("");
      return windowOver(text, cmd.fromByte, cmd.maxBytes);
    };
    const sim = attachScriptedNode(node, { ...LIFECYCLE, input: typingInto(typed), log_read: echoLog });
    try {
      const id = await directRow({ harnessId: "terminal", name: "exec-timeout" });
      const answer = await exec(id, "echo hi", 1200);
      expect(answer).toMatchObject({ status: "timed_out", exitCode: null, truncated: false });
      // Ruling 2's receipt, at the SERVICE layer: the timeout types NOTHING
      // further. The four command frames are the whole traffic; the command
      // keeps running on the pane and this call only stopped watching.
      expect(sim.countOf("input")).toBe(4);
      const cursorReads = sim.cmdsOf("log_read").filter((c) => !(c.fromByte === 0 && c.maxBytes === 1));
      const startByte = cursorReads[0]?.fromByte ?? 0;
      // The returned cursor never rewinds past where the wait started: bytes
      // the scan consumed are behind the next reader, bytes it did not are
      // ahead of it, never both-or-neither confusion.
      expect(answer.nextByte).toBeGreaterThanOrEqual(startByte);
    } finally {
      sim.detach();
    }
  });

  it("a row that dies mid-wait ends the wait early - the DB-backed recheck, not just the unit stub", async () => {
    // Spec §5 promised this at the SERVICE layer: the pure `waitSentinel` unit
    // stubs `alive`, but the verb's real recheck reads the row each poll, and
    // that composition (findById, the two facts, the early stop) is what the
    // route ships. The scripted pane echoes and never answers, so WITHOUT the
    // recheck this call could only end at its 30 s deadline.
    const typed: string[] = [];
    const echoLog: ScriptedHandler = (cmd) => {
      if (cmd.type !== "log_read") return new Error(`exec sim: wrong cmd ${cmd.type}`);
      const text = typed
        .filter((frame) => frame !== "\r")
        .map((frame) => `${frame}\n`)
        .join("");
      return windowOver(text, cmd.fromByte, cmd.maxBytes);
    };
    const sim = attachScriptedNode(node, { ...LIFECYCLE, input: typingInto(typed), log_read: echoLog });
    const started = Date.now();
    try {
      const id = await directRow({ harnessId: "terminal", name: "exec-died" });
      const answerP = exec(id, "sleep 99", 30_000);
      // Let the typing land, then flip the row's facts like a death report does.
      for (let i = 0; sim.countOf("input") < 4 && i < 600; i++) await new Promise((r) => setTimeout(r, 5));
      expect(sim.countOf("input")).toBe(4);
      await subshells.update(id, { status: "terminated", alive: 0 });
      const answer = await answerP;
      expect(answer).toMatchObject({ status: "timed_out", exitCode: null });
      // ~2 s (quiet probe + one poll), never the 30 s deadline.
      expect(Date.now() - started).toBeLessThan(8_000);
      expect(sim.countOf("input")).toBe(4); // ruling 2: ending the watch types nothing
    } finally {
      sim.detach();
    }
  });

  it("a PARKED row (status running, alive 0) 409s SUBSHELL_NOT_RUNNING before the terminal-type check", async () => {
    const sim = attachScriptedNode(node, LIFECYCLE);
    try {
      // An AGENT-harness parked row: if the two facts were checked after the
      // terminal-type gate, this row would answer 400 EXEC_TERMINAL_ONLY. The
      // input suite's ordering rule mirrors here: running first, always.
      const id = await directRow({ harnessId: "claude-code", name: "exec-parked", status: "running", alive: 0 });
      const err = await expectRefusal(exec(id));
      expect(err.statusCode).toBe(409);
      expect(err.code).toBe(BackendErrorCodes.SUBSHELL_NOT_RUNNING);
      expect(sim.countOf("input")).toBe(0);
      expect(sim.countOf("log_read")).toBe(0);
    } finally {
      sim.detach();
    }
  });
});
