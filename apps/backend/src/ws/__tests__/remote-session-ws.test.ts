import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import type { JsonValue, NodeCommandBody } from "@internal/session-protocol";
import { runMigrations } from "@/db/migrate.js";
import { dispatchOutput, resetNodeEventsForTests } from "@/services/nodes/node-events.js";
import {
  attachConnection,
  type NodeConnection,
  type NodeSocket,
  resetNodeRegistryForTests,
} from "@/services/nodes/node-registry.js";
import { resolveResult } from "@/services/nodes/node-rpc.js";
import { RemoteLauncher } from "@/services/nodes/remote-launcher.js";
import { readSessionLogTail } from "@/services/session-manager.service.js";
import { attachRemoteSessionWs, type RemoteAttachRow } from "@/ws/remote-session-ws.js";
import { cleanupSessionWs, handleSessionMessage, type WsSocket } from "@/ws/session-ws.js";

/**
 * Task 11 — the live-terminal relay for agent-node rows (spec 2026-08-31
 * §6.5). The browser contract must be BYTE-IDENTICAL to the local attach:
 * `{"type":"replay","data":...}` then `{"type":"output","data":...}` frames,
 * every outbound string through `stripSyncMarkers`, refusals on 4004.
 *
 * The node side is the FULL loop: a fake `NodeSocket` on the REAL registry,
 * driven by the REAL `sendCommand` (the launcher keeps its default seams) —
 * each wire frame is unwrapped (payload decoded, not re-verified: signing is
 * pinned by node-rpc.test) and answered with `resolveResult`, exactly like
 * the `/ws/node` handler does. Tail chunks ride the REAL output bus through
 * `dispatchOutput`, which is what `handleNodeMessage` feeds for `output`
 * frames.
 */

const NODE_ID = "node-relay-1";
const SID = "0e63c9a1-2f5b-4c8a-9d1e-2f3a4b5c6d7e";
const LOG_BYTES = 256 * 1024; // must mirror LOG_TAIL_BYTES (windowed-read assertion)

const BSU = "\x1b[?2026h";
const ESU = "\x1b[?2026l";

const b64 = (s: string): string => Buffer.from(s, "utf8").toString("base64");

/** Poll `cond` until true (signing/RPC settle on real async paths). */
async function until(cond: () => boolean, what = "condition", budgetMs = 4000): Promise<void> {
  for (let waited = 0; ; waited += 5) {
    if (cond()) return;
    if (waited > budgetMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** One unwrapped command frame: the claims' jti plus the plain command body. */
interface WireCmd {
  jti: string;
  cmd: NodeCommandBody;
}

/** Scripted answer: wire data (or a promise of it), or a function of the command. */
type Script = unknown | ((cmd: NodeCommandBody) => unknown);

/** Marker produced by `fail()` — an `ok:false` result for the next matching command. */
interface FailScript {
  __nodeFail: string;
}
const fail = (msg: string): FailScript => ({ __nodeFail: msg });
const isFail = (s: unknown): s is FailScript =>
  typeof s === "object" && s !== null && "__nodeFail" in (s as Record<string, unknown>);

/**
 * A fake agent on the REAL registry: every `sendCommand` frame from the
 * launcher arrives signed here; we decode the claims (no verify — the RPC
 * suite pins signing), answer via `resolveResult` from the script queue, and
 * record the command for assertions.
 */
function makeNodeSim() {
  const wire: WireCmd[] = [];
  const scripts = new Map<string, Script[]>();
  let conn: NodeConnection;

  const socket: NodeSocket = {
    send(data: string) {
      const { jws } = JSON.parse(data) as { jws: string };
      const claims = JSON.parse(Buffer.from(jws.split(".")[1], "base64url").toString("utf8")) as {
        jti: string;
        cmd: NodeCommandBody;
      };
      wire.push({ jti: claims.jti, cmd: claims.cmd });
      const entry = scripts.get(claims.cmd.type)?.shift();
      const ref = { type: "result" as const, ref: claims.jti };
      if (isFail(entry)) {
        resolveResult(conn, { ...ref, ok: false, error: entry.__nodeFail });
        return;
      }
      const payload = typeof entry === "function" ? (entry as (c: NodeCommandBody) => unknown)(claims.cmd) : entry;
      // `data` may be a promise — resolveResult hands it to the pending's
      // resolve, which adopts it (the scripted agent thinking before answering).
      // (JsonValue cast: a thenable here is legal at runtime — the pending's
      // resolve adopts it — but the wire type only names the settled shape.)
      resolveResult(conn, { ...ref, ok: true, data: payload as JsonValue });
    },
    close() {},
  };

  conn = attachConnection(NODE_ID, socket);
  // What the agent's `ready` frame installs (logPath composes from these).
  conn.agent = {
    dataDir: "/home/ag/.mote-agent",
    capabilities: ["mcp"],
    hostname: "box",
    agentVersion: "0.2.0",
    executablePath: "/usr/bin/mote-agent",
  };

  return {
    conn,
    wire,
    /** Queue the next answer for commands of `type` (functions see the command). */
    answer(type: string, script: Script) {
      const q = scripts.get(type) ?? [];
      q.push(script);
      scripts.set(type, q);
    },
    cmdTypes: () => wire.map((w) => w.cmd.type),
    cmdsOf: (type: string) => wire.filter((w) => w.cmd.type === type).map((w) => w.cmd),
  };
}

/** The scripted happy path: live pane, marker-laden capture, a 2-line small log. */
function scriptHappy(sim: ReturnType<typeof makeNodeSim>) {
  sim.answer("probe", [{ sessionId: SID, alive: true, exitCode: null }]);
  sim.answer("capture", `${BSU}SCREEN${ESU}`);
  scriptLogRead(sim, { bytes: "ab\ncd\n", size: 7 });
}

/** log_read pair: the 1-byte size probe and the window read. */
function scriptLogRead(sim: ReturnType<typeof makeNodeSim>, log: { bytes: string; size: number }) {
  const answer = (cmd: NodeCommandBody) =>
    cmd.type === "log_read" && cmd.maxBytes === 1
      ? { bytes_b64: b64(log.bytes.slice(0, 1)), next: Math.min(1, log.size), size: log.size }
      : { bytes_b64: b64(log.bytes), next: log.size, size: log.size };
  sim.answer("log_read", answer);
  sim.answer("log_read", answer);
}

interface FakeBrowser {
  ws: WsSocket;
  sent: string[];
  closed: { code?: number; reason?: string }[];
}

/** A fake browser socket; `lag` answers getBufferedAmount (the backpressure probe). */
function fakeBrowser(lag?: () => number): FakeBrowser {
  const sent: string[] = [];
  const closed: { code?: number; reason?: string }[] = [];
  const ws = {
    data: {},
    send: (d: string) => {
      sent.push(d);
      return 0;
    },
    close: (code?: number, reason?: string) => {
      closed.push({ code, reason });
    },
    raw: lag ? { getBufferedAmount: lag } : {},
  } as unknown as WsSocket;
  return { ws, sent, closed };
}

function attachRow(over: Partial<RemoteAttachRow> = {}): RemoteAttachRow {
  return { id: SID, nodeId: NODE_ID, tmuxSocket: "mote-relay", terminalReplayLines: null, ...over };
}

/** tail_start's subId as it went on the wire (the relay mints a uuid). */
function subIdOf(sim: ReturnType<typeof makeNodeSim>): string {
  const cmd = sim.cmdsOf("tail_start")[0] as Extract<NodeCommandBody, { type: "tail_start" }>;
  return cmd.subId;
}

function outputFrame(subId: string, fromByte: number, text: string) {
  return {
    type: "output" as const,
    sessionId: SID,
    subId,
    fromByte,
    toByte: fromByte + text.length,
    data_b64: b64(text),
  };
}

beforeAll(async () => {
  await runMigrations(); // persistOutput's throttled lastOutputAt write hits the real (temp) DB
});

beforeEach(() => {
  resetNodeRegistryForTests();
  resetNodeEventsForTests();
});

afterEach(() => {
  resetNodeRegistryForTests();
  resetNodeEventsForTests();
});

describe("attachRemoteSessionWs — the §6.5 flow on the wire", () => {
  it("replay first, then outputs: byte-exact browser contract, sync markers stripped", async () => {
    const sim = makeNodeSim();
    scriptHappy(sim);
    const { ws, sent } = fakeBrowser();

    await attachRemoteSessionWs(ws, attachRow(), new RemoteLauncher(NODE_ID), "owner");
    await until(() => sim.cmdTypes().includes("tail_start"), "tail_start on the wire");

    // Command ORDER through the real sendCommand: liveness, capture, size, window, tail.
    expect(sim.cmdTypes()).toEqual(["probe", "capture", "log_read", "log_read", "tail_start"]);
    // The size probe is a 1-byte read (size rides every log_read answer) and the
    // window read covers the whole LOG_TAIL_BYTES budget from 0 (log is small).
    expect(sim.cmdsOf("log_read")).toEqual([
      { type: "log_read", sessionId: SID, fromByte: 0, maxBytes: 1 },
      { type: "log_read", sessionId: SID, fromByte: 0, maxBytes: LOG_BYTES },
    ]);
    // Default cap (100 lines) keeps all 2 window lines ⇒ tail starts at 0.
    expect(sim.cmdsOf("tail_start")).toEqual([
      { type: "tail_start", sessionId: SID, subId: expect.any(String), fromByte: 0 },
    ]);

    // Frame 1: replay — the capture's DEC 2026 markers are gone and the frame
    // is the browser's exact JSON shape (key order included).
    expect(sent[0]).toBe(JSON.stringify({ type: "replay", data: "SCREEN" }));

    // Live chunks arrive as output frames, markers stripped, byte-identical.
    const sub = subIdOf(sim);
    dispatchOutput(outputFrame(sub, 0, "echo hi\r\n"));
    await until(() => sent.length === 2, "output frame");
    expect(sent[1]).toBe(JSON.stringify({ type: "output", data: "echo hi\r\n" }));
    dispatchOutput(outputFrame(sub, 9, `${BSU}x${ESU}`));
    await until(() => sent.length === 3, "stripped output frame");
    expect(sent[2]).toBe(JSON.stringify({ type: "output", data: "x" }));
  });

  it("a zero-byte log replays, then arms the tail at offset 0 (agent tolerates a missing file)", async () => {
    const sim = makeNodeSim();
    sim.answer("probe", [{ sessionId: SID, alive: true, exitCode: null }]);
    sim.answer("capture", "SCREEN");
    sim.answer("log_read", { bytes_b64: "", next: 0, size: 0 });
    sim.answer("log_read", { bytes_b64: "", next: 0, size: 0 });
    const { ws, sent, closed } = fakeBrowser();

    await attachRemoteSessionWs(ws, attachRow(), new RemoteLauncher(NODE_ID), "owner");
    await until(() => sim.cmdTypes().includes("tail_start"), "tail armed at offset 0");

    expect(sent[0]).toBe(JSON.stringify({ type: "replay", data: "SCREEN" }));
    expect(sim.cmdsOf("tail_start")[0]).toEqual({
      type: "tail_start",
      sessionId: SID,
      subId: expect.any(String),
      fromByte: 0,
    });
    expect(closed).toEqual([]);
  });

  it("honors the per-attach replay cap: the tail starts where the last `cap` lines begin", async () => {
    const sim = makeNodeSim();
    sim.answer("probe", [{ sessionId: SID, alive: true, exitCode: null }]);
    sim.answer("capture", "SCREEN");
    scriptLogRead(sim, { bytes: "l1\nl2\nl3\n", size: 12 });
    const { ws } = fakeBrowser();

    // terminalReplayLines=2 ⇒ drop the first line of the window (3 lines):
    // replayOffsetFromWindow(0, "l1\nl2\nl3\n", 2) = index of first \n (2) + 1.
    await attachRemoteSessionWs(ws, attachRow({ terminalReplayLines: 2 }), new RemoteLauncher(NODE_ID), "owner");
    await until(() => sim.cmdTypes().includes("tail_start"), "tail at pruned offset");
    expect(sim.cmdsOf("tail_start")[0]).toEqual({
      type: "tail_start",
      sessionId: SID,
      subId: expect.any(String),
      fromByte: 3,
    });
  });

  it("clamps terminalReplayLines to [1,200] exactly like the local attach", async () => {
    // 9999 ⇒ cap 200 ⇒ all 3 window lines kept ⇒ offset 0 (windowStart).
    const sim = makeNodeSim();
    sim.answer("probe", [{ sessionId: SID, alive: true, exitCode: null }]);
    sim.answer("capture", "SCREEN");
    scriptLogRead(sim, { bytes: "l1\nl2\nl3\n", size: 12 });
    await attachRemoteSessionWs(
      fakeBrowser().ws,
      attachRow({ terminalReplayLines: 9999 }),
      new RemoteLauncher(NODE_ID),
      "owner",
    );
    await until(() => sim.cmdTypes().includes("tail_start"), "tail_start (cap 200)");
    expect((sim.cmdsOf("tail_start")[0] as { fromByte: number }).fromByte).toBe(0);

    // 0 ⇒ clamped to 1 ⇒ keep only the last line ⇒ skip 2 lines: offset 6.
    const sim2 = makeNodeSim();
    sim2.answer("probe", [{ sessionId: SID, alive: true, exitCode: null }]);
    sim2.answer("capture", "SCREEN");
    scriptLogRead(sim2, { bytes: "l1\nl2\nl3\n", size: 12 });
    await attachRemoteSessionWs(
      fakeBrowser().ws,
      attachRow({ terminalReplayLines: 0 }),
      new RemoteLauncher(NODE_ID),
      "owner",
    );
    await until(() => sim2.cmdTypes().includes("tail_start"), "tail_start (cap 1)");
    expect((sim2.cmdsOf("tail_start")[0] as { fromByte: number }).fromByte).toBe(6);
  });

  it("refuses 4004 'node offline' when the node has no live connection (nothing hits the wire)", async () => {
    const { ws, sent, closed } = fakeBrowser();
    // No attachConnection for NODE_ID — the registry says offline.
    await attachRemoteSessionWs(ws, attachRow(), new RemoteLauncher(NODE_ID), "owner");
    expect(closed).toEqual([{ code: 4004, reason: "node offline" }]);
    expect(sent).toEqual([]);
  });

  it("refuses 4004 'session not running' when the probe answers dead", async () => {
    const sim = makeNodeSim();
    sim.answer("probe", [{ sessionId: SID, alive: false, exitCode: 1 }]);
    const { ws, sent, closed } = fakeBrowser();

    await attachRemoteSessionWs(ws, attachRow(), new RemoteLauncher(NODE_ID), "owner");
    expect(closed).toEqual([{ code: 4004, reason: "session not running" }]);
    expect(sent).toEqual([]);
    expect(sim.cmdTypes()).toEqual(["probe"]); // no capture, no reads, no tail
  });

  it("refuses 4004 when the capture races the pane away", async () => {
    const sim = makeNodeSim();
    sim.answer("probe", [{ sessionId: SID, alive: true, exitCode: null }]);
    sim.answer("capture", fail("can't find session: pane gone"));
    const { ws, sent, closed } = fakeBrowser();

    await attachRemoteSessionWs(ws, attachRow(), new RemoteLauncher(NODE_ID), "owner");
    expect(closed).toEqual([{ code: 4004, reason: "session not running" }]);
    expect(sent).toEqual([]);
    expect(sim.cmdTypes()).toEqual(["probe", "capture"]); // window read never ran
  });

  it("closes 1011 'client too slow' when the browser queue exceeds 4 MiB, and stops streaming", async () => {
    const sim = makeNodeSim();
    scriptHappy(sim);
    const { ws, sent, closed } = fakeBrowser(() => 4 * 1024 * 1024 + 1);

    await attachRemoteSessionWs(ws, attachRow(), new RemoteLauncher(NODE_ID), "owner");
    await until(() => sim.cmdTypes().includes("tail_start"), "tail armed");
    expect(sent).toEqual([JSON.stringify({ type: "replay", data: "SCREEN" })]);

    dispatchOutput(outputFrame(subIdOf(sim), 0, "flood"));
    await until(() => closed.some((c) => c.code === 1011), "1011 close");
    expect(sent.length).toBe(1); // the offending chunk never ships
    // The plugin's close handler runs the cleanup; the agent sees exactly one tail_stop.
    cleanupSessionWs(ws);
    await until(() => sim.cmdTypes().filter((t) => t === "tail_stop").length === 1, "tail_stop once");
    expect(sim.cmdTypes().filter((t) => t === "tail_stop")).toHaveLength(1);
  });
});

describe("attachRemoteSessionWs — input/resize/cleanup ride the shared handlers", () => {
  it("edit access: an input frame reaches the node as an `input` command over the real RPC", async () => {
    const sim = makeNodeSim();
    scriptHappy(sim);
    const { ws } = fakeBrowser();

    await attachRemoteSessionWs(ws, attachRow(), new RemoteLauncher(NODE_ID), "edit");
    await until(() => sim.cmdTypes().includes("tail_start"), "attached");

    handleSessionMessage(ws, JSON.stringify({ type: "input", data: "ls\r" }));
    await until(() => sim.cmdsOf("input").length === 1, "input on the wire");
    expect(sim.cmdsOf("input")).toEqual([{ type: "input", sessionId: SID, data: "ls\r" }]);

    handleSessionMessage(ws, JSON.stringify({ type: "resize", cols: 132, rows: 43 }));
    await until(() => sim.cmdsOf("resize").length === 1, "resize on the wire");
    expect(sim.cmdsOf("resize")).toEqual([{ type: "resize", sessionId: SID, cols: 132, rows: 43 }]);
  });

  it("view access: keystrokes are dropped, resize still passes", async () => {
    const sim = makeNodeSim();
    scriptHappy(sim);
    const { ws } = fakeBrowser();

    await attachRemoteSessionWs(ws, attachRow(), new RemoteLauncher(NODE_ID), "view");
    await until(() => sim.cmdTypes().includes("tail_start"), "attached");

    handleSessionMessage(ws, JSON.stringify({ type: "input", data: "rm -rf /\r" }));
    handleSessionMessage(ws, JSON.stringify({ type: "resize", cols: 80, rows: 24 }));
    await until(() => sim.cmdsOf("resize").length === 1, "resize through");
    expect(sim.cmdsOf("input")).toEqual([]);
  });

  it("close ⇒ tail_stop on the wire EXACTLY ONCE, even with a double cleanup (relay calls the disposer once per browser; idempotent disposer absorbs the rest)", async () => {
    const sim = makeNodeSim();
    scriptHappy(sim);
    const { ws } = fakeBrowser();

    await attachRemoteSessionWs(ws, attachRow(), new RemoteLauncher(NODE_ID), "owner");
    await until(() => sim.cmdTypes().includes("tail_start"), "attached");

    cleanupSessionWs(ws);
    cleanupSessionWs(ws); // belt-and-braces second cleanup (e.g. close after an error-path teardown)
    await until(() => sim.cmdTypes().includes("tail_stop"), "tail_stop on the wire");
    await Bun.sleep(25); // any hypothetical second stop lands within this via the send chain
    expect(sim.cmdTypes().filter((t) => t === "tail_stop")).toHaveLength(1);
    // …and the stop names the subscription that was started.
    expect(sim.cmdsOf("tail_stop")).toEqual([{ type: "tail_stop", subId: subIdOf(sim) }]);
    // After dispose the relay is deaf: an in-flight event must not ship.
    expect(dispatchOutput(outputFrame(subIdOf(sim), 0, "late"))).toBe(false);
  });

  it("browser close DURING attach never arms a zombie tail", async () => {
    const sim = makeNodeSim();
    sim.answer("probe", [{ sessionId: SID, alive: true, exitCode: null }]);
    sim.answer("capture", "SCREEN");
    sim.answer("log_read", { bytes_b64: b64("a"), next: 1, size: 7 });
    // The window read hangs until we release it — the browser closes while parked.
    let release: ((v: unknown) => void) | undefined;
    sim.answer(
      "log_read",
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const { ws } = fakeBrowser();

    const attaching = attachRemoteSessionWs(ws, attachRow(), new RemoteLauncher(NODE_ID), "owner");
    await until(() => sim.cmdTypes().filter((t) => t === "log_read").length === 2, "parked in the window read");
    cleanupSessionWs(ws); // browser vanished mid-attach
    release?.({ bytes_b64: b64("ab\ncd\n"), next: 7, size: 7 });
    await attaching;

    expect(sim.cmdTypes()).not.toContain("tail_start"); // nothing was armed…
    expect(sim.cmdTypes()).not.toContain("tail_stop"); // …so there is nothing to stop
  });
});

describe("readSessionLogTail routes by node", () => {
  it("an agent-node row reads through that node's launcher (size probe + window, real RPC)", async () => {
    const sim = makeNodeSim();
    scriptLogRead(sim, { bytes: "l1\nl2\n", size: 9 });
    expect(await readSessionLogTail(SID, NODE_ID)).toEqual({ lines: ["l1", "l2"], truncated: false });
    expect(sim.cmdsOf("log_read")).toEqual([
      { type: "log_read", sessionId: SID, fromByte: 0, maxBytes: 1 },
      { type: "log_read", sessionId: SID, fromByte: 0, maxBytes: LOG_BYTES },
    ]);
  });

  it("the default nodeId keeps the local file read (no node command ever fires)", async () => {
    const sim = makeNodeSim();
    expect(await readSessionLogTail(SID)).toEqual({ lines: [], truncated: false }); // no such local log
    expect(sim.cmdTypes()).toEqual([]);
  });
});
