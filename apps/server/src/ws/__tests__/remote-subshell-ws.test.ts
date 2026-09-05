import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import type { JsonValue, NodeCommandBody } from "@internal/subshell-protocol";
import { db } from "@/db/index.js";
import { runMigrations } from "@/db/migrate.js";
import { UserMetaRepository } from "@/db/repositories/user-meta.repository.js";
import { dispatchOutput, resetNodeEventsForTests } from "@/services/nodes/node-events.js";
import {
  attachConnection,
  type NodeConnection,
  type NodeSocket,
  resetNodeRegistryForTests,
} from "@/services/nodes/node-registry.js";
import { resolveResult } from "@/services/nodes/node-rpc.js";
import { RemoteLauncher } from "@/services/nodes/remote-launcher.js";
import { readSubshellLogTail } from "@/services/subshell-manager.service.js";
import { type AttachParams, UNNAMED_DEVICE } from "@/ws/attach-params.js";
import { attachRemoteSubshellWs, type RemoteAttachRow } from "@/ws/remote-subshell-ws.js";
import { cleanupSubshellWs, handleSubshellMessage } from "@/ws/subshell-ws.js";
import { paneStreams, resetLiveViewersForTests, sharedGridFor, type WsSocket } from "@/ws/viewers.js";

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
    dataDir: "/home/ag/.subshell",
    capabilities: ["mcp"],
    hostname: "box",
    agentVersion: "0.2.0",
    executablePath: "/usr/bin/subshell",
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
  sim.answer("probe", [{ subshellId: SID, alive: true, exitCode: null }]);
  sim.answer("capture", `${BSU}SCREEN${ESU}`);
  scriptLogRead(sim, { bytes: "ab\ncd\n", size: 7 });
}

/**
 * Script `times` log_read answers (attach needs exactly one — the 1-byte
 * size probe; `readSubshellLogTail` still asks size + window = two).
 */
function scriptLogRead(sim: ReturnType<typeof makeNodeSim>, log: { bytes: string; size: number }, times = 1) {
  const answer = (cmd: NodeCommandBody) =>
    cmd.type === "log_read" && cmd.maxBytes === 1
      ? { bytes_b64: b64(log.bytes.slice(0, 1)), next: Math.min(1, log.size), size: log.size }
      : { bytes_b64: b64(log.bytes), next: log.size, size: log.size };
  for (let i = 0; i < times; i++) sim.answer("log_read", answer);
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

/** The synthetic OWNER of every relay test row — the user whose per-user
 * terminal-history cap (`user_meta.terminal_replay_lines`) governs the attach. */
const OWNER_UID = "u-relay-owner";

/**
 * Attach params with everything defaulted — the struct the relay now takes.
 *
 * A test that cares about one field says so and inherits the rest, which is
 * the point of the struct: adding an input cannot silently skip a call site.
 */
function attachParams(over: Partial<AttachParams> = {}): AttachParams {
  return { size: null, deviceLabel: UNNAMED_DEVICE, hidden: false, build: "MISSING", ...over };
}

function attachRow(over: Partial<RemoteAttachRow> = {}): RemoteAttachRow {
  return { id: SID, nodeId: NODE_ID, tmuxSocket: "subshell-relay", userId: OWNER_UID, ...over };
}

/** Seed the owner's per-user cap (null = instance default; out-of-range
 * values simulate pre-validation/legacy rows, which the read-time clamp must
 * survive). */
async function setOwnerCap(lines: number | null): Promise<void> {
  await new UserMetaRepository(db).setTerminalReplayLines(OWNER_UID, lines);
}

/** tail_start's subId as it went on the wire (the relay mints a uuid). */
function subIdOf(sim: ReturnType<typeof makeNodeSim>): string {
  const cmd = sim.cmdsOf("tail_start")[0] as Extract<NodeCommandBody, { type: "tail_start" }>;
  return cmd.subId;
}

function outputFrame(subId: string, fromByte: number, text: string) {
  return {
    type: "output" as const,
    subshellId: SID,
    subId,
    fromByte,
    toByte: fromByte + text.length,
    data_b64: b64(text),
  };
}

beforeAll(async () => {
  await runMigrations(); // persistOutput's throttled lastOutputAt write hits the real (temp) DB
});

beforeEach(async () => {
  resetNodeRegistryForTests();
  resetNodeEventsForTests();
  // Every case here reuses one subshell id — without this, a prior case's
  // viewer would be "replaced" by the next case's attach.
  resetLiveViewersForTests();
  // The cap tests seed the owner's user_meta; clear it so default-cap cases
  // never inherit a previous case's number (the DB is shared per process).
  await setOwnerCap(null);
});

afterEach(() => {
  resetNodeRegistryForTests();
  resetNodeEventsForTests();
  resetLiveViewersForTests();
});

describe("attachRemoteSubshellWs — the §6.5 flow on the wire", () => {
  it("replay first, then outputs: byte-exact browser contract, sync markers stripped", async () => {
    const sim = makeNodeSim();
    scriptHappy(sim);
    const { ws, sent } = fakeBrowser();

    await attachRemoteSubshellWs(ws, attachRow(), new RemoteLauncher(NODE_ID), "owner", attachParams());
    await until(() => sim.cmdTypes().includes("tail_start"), "tail_start on the wire");

    // Command ORDER through the real sendCommand: liveness, the tail's JOIN
    // size probe, the TAIL, then the capture. One log_read only — historical
    // log bytes never ship.
    //
    // The tail is armed BEFORE the capture (it moved there when this path
    // joined the shared pump, matching the local twin): a viewer subscribes
    // first, its delivery stays QUEUED until the replay is sent, and the
    // queue is then flushed. Gap-freedom itself does not rest on this order —
    // `fromByte` is the pre-resize sample either way — but subscribing first
    // is what lets several viewers share ONE pump, which `NodeLauncher`'s
    // contract requires.
    expect(sim.cmdTypes()).toEqual(["probe", "log_read", "tail_start", "capture"]);
    expect(sim.cmdsOf("log_read")).toEqual([{ type: "log_read", subshellId: SID, fromByte: 0, maxBytes: 1 }]);
    // The capture carries the default replay line cap; the tail starts at the
    // probed size (7): only bytes past the snapshot ever ship.
    expect(sim.cmdsOf("capture")).toEqual([{ type: "capture", subshellId: SID, lines: 100 }]);
    expect(sim.cmdsOf("tail_start")).toEqual([
      { type: "tail_start", subshellId: SID, subId: expect.any(String), fromByte: 7 },
    ]);

    // Frame 1: replay — the capture's DEC 2026 markers are gone and the frame
    // is the browser's exact JSON shape (key order included).
    //
    // Terminal frames only, and re-read on EVERY assertion: the socket also
    // carries `viewers` presence, which arrives on its own schedule (a viewer
    // joining or leaving, anywhere), so indexing raw `sent` — or counting it
    // — silently drifts as soon as presence lands between two output frames.
    const term = (): string[] => sent.filter((f) => !f.includes('"type":"viewers"'));
    expect(term()[0]).toBe(JSON.stringify({ type: "replay", data: "SCREEN" }));

    // Live chunks arrive as output frames, markers stripped, byte-identical.
    const sub = subIdOf(sim);
    dispatchOutput(outputFrame(sub, 7, "echo hi\r\n"));
    await until(() => term().length === 2, "output frame");
    expect(term()[1]).toBe(JSON.stringify({ type: "output", data: "echo hi\r\n" }));
    dispatchOutput(outputFrame(sub, 16, `${BSU}x${ESU}`));
    await until(() => term().length === 3, "stripped output frame");
    expect(term()[2]).toBe(JSON.stringify({ type: "output", data: "x" }));
  });

  it("a zero-byte log replays, then arms the tail at offset 0 (agent tolerates a missing file)", async () => {
    const sim = makeNodeSim();
    sim.answer("probe", [{ subshellId: SID, alive: true, exitCode: null }]);
    sim.answer("capture", "SCREEN");
    sim.answer("log_read", { bytes_b64: "", next: 0, size: 0 });
    const { ws, sent, closed } = fakeBrowser();

    await attachRemoteSubshellWs(ws, attachRow(), new RemoteLauncher(NODE_ID), "owner", attachParams());
    await until(() => sim.cmdTypes().includes("tail_start"), "tail armed at offset 0");

    // Terminal frames only: the socket also carries `viewers` presence now.
    const term = sent.filter((f) => !f.includes('"type":"viewers"'));
    expect(term[0]).toBe(JSON.stringify({ type: "replay", data: "SCREEN" }));
    expect(sim.cmdsOf("tail_start")[0]).toEqual({
      type: "tail_start",
      subshellId: SID,
      subId: expect.any(String),
      fromByte: 0,
    });
    expect(closed).toEqual([]);
  });

  it("honors the owner's per-user replay cap: the CAPTURE carries the line budget (not the tail offset)", async () => {
    const sim = makeNodeSim();
    sim.answer("probe", [{ subshellId: SID, alive: true, exitCode: null }]);
    sim.answer("capture", "SCREEN");
    scriptLogRead(sim, { bytes: "l1\nl2\nl3\n", size: 12 });
    const { ws } = fakeBrowser();

    // cap=2 ⇒ `capture` asks for 2 history rows; the tail
    // still starts at EOF (12) — history ships inside the capture, never as
    // re-played log bytes.
    await setOwnerCap(2);
    await attachRemoteSubshellWs(ws, attachRow(), new RemoteLauncher(NODE_ID), "owner", attachParams());
    await until(() => sim.cmdTypes().includes("tail_start"), "tail at EOF");
    expect(sim.cmdsOf("capture")).toEqual([{ type: "capture", subshellId: SID, lines: 2 }]);
    expect((sim.cmdsOf("tail_start")[0] as { fromByte: number }).fromByte).toBe(12);
  });

  it("clamps the stored cap to [1,200] exactly like the local attach", async () => {
    // 9999 ⇒ cap 200 rows on the capture (out-of-range values simulate a
    // rollback-restored row; the read-time clamp is a load guarantee).
    const sim = makeNodeSim();
    sim.answer("probe", [{ subshellId: SID, alive: true, exitCode: null }]);
    sim.answer("capture", "SCREEN");
    scriptLogRead(sim, { bytes: "l1\nl2\nl3\n", size: 12 });
    await setOwnerCap(9999);
    await attachRemoteSubshellWs(fakeBrowser().ws, attachRow(), new RemoteLauncher(NODE_ID), "owner", attachParams());
    await until(() => sim.cmdsOf("capture").length === 1, "capture (cap 200)");
    expect((sim.cmdsOf("capture")[0] as { lines?: number }).lines).toBe(200);

    // 0 ⇒ clamped to 1.
    const sim2 = makeNodeSim();
    sim2.answer("probe", [{ subshellId: SID, alive: true, exitCode: null }]);
    sim2.answer("capture", "SCREEN");
    scriptLogRead(sim2, { bytes: "l1\nl2\nl3\n", size: 12 });
    await setOwnerCap(0);
    await attachRemoteSubshellWs(fakeBrowser().ws, attachRow(), new RemoteLauncher(NODE_ID), "owner", attachParams());
    await until(() => sim2.cmdsOf("capture").length === 1, "capture (cap 1)");
    expect((sim2.cmdsOf("capture")[0] as { lines?: number }).lines).toBe(1);
  });

  it("a client size on the attach resizes the pane BEFORE the capture, and quiesces the replay", async () => {
    const sim = makeNodeSim();
    sim.answer("probe", [{ subshellId: SID, alive: true, exitCode: null }]);
    // quiesce = true after a resize: two identical captures settle the poll.
    sim.answer("capture", "SCREEN");
    sim.answer("capture", "SCREEN");
    // The repaint-wait polls the log size until it bursts-and-quiesces; a
    // STATIC simulated log never grows, so it exits via the no-growth grace —
    // a handful of extra 1-byte probes before the capture. Script enough.
    scriptLogRead(sim, { bytes: "ab\ncd\n", size: 7 }, 40);
    const { ws } = fakeBrowser();

    await attachRemoteSubshellWs(
      ws,
      attachRow(),
      new RemoteLauncher(NODE_ID),
      "owner",
      attachParams({ size: { cols: 132, rows: 43 } }),
    );
    await until(() => sim.cmdTypes().includes("tail_start"), "tail armed");
    // Resize lands ahead of the capture so the replay matches the client
    // geometry.
    // Collapsed: the size probes repeat on a timing cadence, order is the point.
    // The tail precedes the resize now — see the ordering note above; what
    // still matters here is that the RESIZE lands ahead of the CAPTURE.
    expect([...new Set(sim.cmdTypes())].join(",")).toBe("probe,log_read,tail_start,resize,capture");
    // The scripted log never grows, so the pane reads as "never repainted"
    // and the relay nudges it (±1 col) to force a SIGWINCH — the local twin's
    // rule, and the cure for a no-op resize leaving a half-painted frame on
    // screen. It ends at the client's real geometry.
    expect(sim.cmdsOf("resize")).toEqual([
      { type: "resize", subshellId: SID, cols: 132, rows: 43 },
      { type: "resize", subshellId: SID, cols: 133, rows: 43 },
      { type: "resize", subshellId: SID, cols: 132, rows: 43 },
    ]);
  });

  it("refuses 4004 'node offline' when the node has no live connection (nothing hits the wire)", async () => {
    const { ws, sent, closed } = fakeBrowser();
    // No attachConnection for NODE_ID — the registry says offline.
    await attachRemoteSubshellWs(ws, attachRow(), new RemoteLauncher(NODE_ID), "owner", attachParams());
    expect(closed).toEqual([{ code: 4004, reason: "node offline" }]);
    expect(sent).toEqual([]);
  });

  it("refuses 4004 'subshell not running' when the probe answers dead", async () => {
    const sim = makeNodeSim();
    sim.answer("probe", [{ subshellId: SID, alive: false, exitCode: 1 }]);
    const { ws, sent, closed } = fakeBrowser();

    await attachRemoteSubshellWs(ws, attachRow(), new RemoteLauncher(NODE_ID), "owner", attachParams());
    expect(closed).toEqual([{ code: 4004, reason: "subshell not running" }]);
    expect(sent).toEqual([]);
    expect(sim.cmdTypes()).toEqual(["probe"]); // no capture, no reads, no tail
  });

  it("refuses 4004 when the capture races the pane away", async () => {
    const sim = makeNodeSim();
    sim.answer("probe", [{ subshellId: SID, alive: true, exitCode: null }]);
    scriptLogRead(sim, { bytes: "ab\ncd\n", size: 7 });
    sim.answer("capture", fail("can't find session: pane gone")); // tmux stderr, verbatim
    const { ws, sent, closed } = fakeBrowser();

    await attachRemoteSubshellWs(ws, attachRow(), new RemoteLauncher(NODE_ID), "owner", attachParams());
    expect(closed).toEqual([{ code: 4004, reason: "subshell not running" }]);
    expect(sent).toEqual([]);
    // The pump is armed before the capture (join-point rule), so a refusal
    // AFTER it must tear the subscription down rather than never having
    // started one. What must never survive is a running tail for a viewer
    // that was refused — assert the stop, not the absence of the start.
    await until(() => sim.cmdTypes().includes("tail_stop"), "tail stopped after the refusal");
    expect(sim.cmdTypes().filter((t) => t === "tail_start")).toHaveLength(1);
    expect(sim.cmdTypes().filter((t) => t === "tail_stop")).toHaveLength(1);
  });

  it("closes 1011 'client too slow' when the browser queue exceeds 4 MiB, and stops streaming", async () => {
    const sim = makeNodeSim();
    scriptHappy(sim);
    const { ws, sent, closed } = fakeBrowser(() => 4 * 1024 * 1024 + 1);

    await attachRemoteSubshellWs(ws, attachRow(), new RemoteLauncher(NODE_ID), "owner", attachParams());
    await until(() => sim.cmdTypes().includes("tail_start"), "tail armed");
    // Terminal frames only: the socket also carries `viewers` presence now.
    expect(sent.filter((f) => !f.includes('"type":"viewers"'))).toEqual([
      JSON.stringify({ type: "replay", data: "SCREEN" }),
    ]);

    dispatchOutput(outputFrame(subIdOf(sim), 7, "flood"));
    await until(() => closed.some((c) => c.code === 1011), "1011 close");
    // The offending chunk never ships. Terminal frames only — presence rides
    // the same socket.
    expect(sent.filter((f) => !f.includes('"type":"viewers"')).length).toBe(1);
    // The plugin's close handler runs the cleanup; the agent sees exactly one tail_stop.
    cleanupSubshellWs(ws);
    await until(() => sim.cmdTypes().filter((t) => t === "tail_stop").length === 1, "tail_stop once");
    expect(sim.cmdTypes().filter((t) => t === "tail_stop")).toHaveLength(1);
  });
});

describe("attachRemoteSubshellWs — input/resize/cleanup ride the shared handlers", () => {
  it("edit access: an input frame reaches the node as an `input` command over the real RPC", async () => {
    const sim = makeNodeSim();
    scriptHappy(sim);
    const { ws } = fakeBrowser();

    await attachRemoteSubshellWs(ws, attachRow(), new RemoteLauncher(NODE_ID), "edit", attachParams());
    await until(() => sim.cmdTypes().includes("tail_start"), "attached");

    handleSubshellMessage(ws, JSON.stringify({ type: "input", data: "ls\r" }));
    await until(() => sim.cmdsOf("input").length === 1, "input on the wire");
    expect(sim.cmdsOf("input")).toEqual([{ type: "input", subshellId: SID, data: "ls\r" }]);

    handleSubshellMessage(ws, JSON.stringify({ type: "resize", cols: 132, rows: 43 }));
    await until(() => sim.cmdsOf("resize").length === 1, "resize on the wire");
    expect(sim.cmdsOf("resize")).toEqual([{ type: "resize", subshellId: SID, cols: 132, rows: 43 }]);
  });

  it("view access: keystrokes are dropped, resize still passes", async () => {
    const sim = makeNodeSim();
    scriptHappy(sim);
    const { ws } = fakeBrowser();

    await attachRemoteSubshellWs(ws, attachRow(), new RemoteLauncher(NODE_ID), "view", attachParams());
    await until(() => sim.cmdTypes().includes("tail_start"), "attached");

    handleSubshellMessage(ws, JSON.stringify({ type: "input", data: "rm -rf /\r" }));
    handleSubshellMessage(ws, JSON.stringify({ type: "resize", cols: 80, rows: 24 }));
    await until(() => sim.cmdsOf("resize").length === 1, "resize through");
    expect(sim.cmdsOf("input")).toEqual([]);
  });

  it("close ⇒ tail_stop on the wire EXACTLY ONCE, even with a double cleanup (relay calls the disposer once per browser; idempotent disposer absorbs the rest)", async () => {
    const sim = makeNodeSim();
    scriptHappy(sim);
    const { ws } = fakeBrowser();

    await attachRemoteSubshellWs(ws, attachRow(), new RemoteLauncher(NODE_ID), "owner", attachParams());
    await until(() => sim.cmdTypes().includes("tail_start"), "attached");

    cleanupSubshellWs(ws);
    cleanupSubshellWs(ws); // belt-and-braces second cleanup (e.g. close after an error-path teardown)
    await until(() => sim.cmdTypes().includes("tail_stop"), "tail_stop on the wire");
    // Rule out a late second stop over a BOUNDED window — the file's
    // until-with-budget idiom rather than a wall-clock sleep, so a loaded
    // runner can't out- or under-run it: poll up to 100 ms for the send
    // chain to land another one (it never should — the disposer is
    // idempotent), then count.
    const sawLateStop = await until(
      () => sim.cmdTypes().filter((t) => t === "tail_stop").length > 1,
      "second (double-dispose) tail_stop",
      100,
    ).then(
      () => true,
      () => false,
    );
    expect(sawLateStop).toBe(false); // budget elapsed ⇒ nothing late ever arrived
    expect(sim.cmdTypes().filter((t) => t === "tail_stop")).toHaveLength(1);
    // …and the stop names the subscription that was started.
    expect(sim.cmdsOf("tail_stop")).toEqual([{ type: "tail_stop", subId: subIdOf(sim) }]);
    // After dispose the relay is deaf: an in-flight event must not ship.
    expect(dispatchOutput(outputFrame(subIdOf(sim), 0, "late"))).toBe(false);
  });

  it("browser close DURING attach never arms a zombie tail", async () => {
    const sim = makeNodeSim();
    sim.answer("probe", [{ subshellId: SID, alive: true, exitCode: null }]);
    sim.answer("log_read", { bytes_b64: b64("a"), next: 1, size: 7 });
    // The capture hangs until we release it — the browser closes while parked.
    let release: ((v: unknown) => void) | undefined;
    sim.answer(
      "capture",
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const { ws } = fakeBrowser();

    const attaching = attachRemoteSubshellWs(ws, attachRow(), new RemoteLauncher(NODE_ID), "owner", attachParams());
    await until(() => sim.cmdTypes().includes("capture"), "parked in the capture");
    cleanupSubshellWs(ws); // browser vanished mid-attach
    release?.("SCREEN");
    await attaching;

    // The pump is armed before the capture now, so a browser that leaves
    // while the capture is parked DOES arm one — and the attach must stop it
    // on the way out. A tail still running for a socket nobody holds is the
    // zombie this case exists to catch; never arming one was only ever the
    // means, and it is no longer available without reopening the join gap.
    await until(() => sim.cmdTypes().includes("tail_stop"), "the armed tail was stopped");
    expect(sim.cmdTypes().filter((t) => t === "tail_start")).toHaveLength(1);
    expect(sim.cmdTypes().filter((t) => t === "tail_stop")).toHaveLength(1);
  });
});

describe("attachRemoteSubshellWs — several viewers share one node pane", () => {
  it("fits the pane to the SHARED grid, not to whoever attached last", async () => {
    // The remote path was the half that never got the local twin's rule: it
    // applied the joiner's own size unconditionally, so a phone attaching to
    // a node subshell a laptop was already watching bounced the pane between
    // the two — exactly the behaviour eviction used to prevent.
    const sim = makeNodeSim();
    // Scripted answers are shifted off a queue, and the repaint wait POLLS the
    // log — so a second attach starves on `log_read` unless there are plenty.
    // It then throws, closes 1011, and never resizes at all: the failure looks
    // like "the shared fit was ignored" and is really "the attach died".
    sim.answer("probe", [{ subshellId: SID, alive: true, exitCode: null }]);
    sim.answer("probe", [{ subshellId: SID, alive: true, exitCode: null }]);
    sim.answer("capture", `${BSU}SCREEN${ESU}`);
    sim.answer("capture", `${BSU}SCREEN${ESU}`);
    scriptLogRead(sim, { bytes: "ab\ncd\n", size: 7 }, 60);
    const laptop = fakeBrowser();
    const phone = fakeBrowser();

    await attachRemoteSubshellWs(
      laptop.ws,
      attachRow(),
      new RemoteLauncher(NODE_ID),
      "owner",
      attachParams({ size: { cols: 120, rows: 40 } }),
    );
    // The laptop alone: the pane holds ITS size.
    expect(sim.cmdsOf("resize").at(-1)).toEqual({ type: "resize", subshellId: SID, cols: 120, rows: 40 });
    const before = sim.cmdsOf("resize").length;

    await attachRemoteSubshellWs(
      phone.ws,
      attachRow(),
      new RemoteLauncher(NODE_ID),
      "owner",
      attachParams({ size: { cols: 60, rows: 20 } }),
    );

    // The joiner's attach really did drive the pane...
    expect(sim.cmdsOf("resize").length).toBeGreaterThan(before);
    // ...and left it at the size BOTH can display, not at the joiner's own.
    // The nudge's ±1 steps are on the way there and deliberately not asserted;
    // where the pane ENDS is the claim.
    expect(sim.cmdsOf("resize").at(-1)).toEqual({ type: "resize", subshellId: SID, cols: 60, rows: 20 });

    cleanupSubshellWs(phone.ws);
    cleanupSubshellWs(laptop.ws);
  });

  it("honours `hidden` from the connect URL on a node pane too", async () => {
    // The local twin reads it there because the on-open `visibility` frame
    // races the handler's awaits and is dropped when it wins; the remote path
    // took the label from the URL and left this behind. A phone attached to a
    // node subshell while already backgrounded then counted as a visible
    // viewer for the socket's whole life.
    const sim = makeNodeSim();
    sim.answer("probe", [{ subshellId: SID, alive: true, exitCode: null }]);
    sim.answer("probe", [{ subshellId: SID, alive: true, exitCode: null }]);
    sim.answer("capture", `${BSU}SCREEN${ESU}`);
    sim.answer("capture", `${BSU}SCREEN${ESU}`);
    scriptLogRead(sim, { bytes: "ab\ncd\n", size: 7 }, 60);
    const laptop = fakeBrowser();
    const pocketed = fakeBrowser();

    await attachRemoteSubshellWs(
      laptop.ws,
      attachRow(),
      new RemoteLauncher(NODE_ID),
      "owner",
      attachParams({ size: { cols: 120, rows: 40 } }),
    );
    await attachRemoteSubshellWs(
      pocketed.ws,
      attachRow(),
      new RemoteLauncher(NODE_ID),
      "owner",
      attachParams({ size: { cols: 40, rows: 12 }, deviceLabel: "Phone", hidden: true }),
    );

    // The hidden joiner takes no part: the pane stays at the laptop's size.
    expect(sharedGridFor(SID)).toEqual({ cols: 120, rows: 40 });
    const presence = laptop.sent
      .filter((f) => f.includes('"type":"viewers"'))
      .map((f) => JSON.parse(f) as { viewers: Array<{ hidden: boolean; label: string }> })
      .at(-1);
    expect(presence?.viewers.find((v) => v.label === "Phone")?.hidden).toBe(true);

    cleanupSubshellWs(pocketed.ws);
    cleanupSubshellWs(laptop.ws);
  });

  it("a close DURING the attach leaves no ghost viewer and no running pump", async () => {
    // The local twin carries the full reasoning: the attach is fired
    // unawaited and reaches `Object.assign(ws.data, data)` only after the
    // node registry and a liveness probe, so a close in that window finds
    // nothing to undo. Registering afterwards strands a viewer that can never
    // be removed — permanently holding a place in the shared-grid decision
    // and keeping the pane's pump running with no reader.
    const sim = makeNodeSim();
    scriptHappy(sim);
    const { ws } = fakeBrowser();

    const attaching = attachRemoteSubshellWs(
      ws,
      attachRow(),
      new RemoteLauncher(NODE_ID),
      "owner",
      attachParams({ size: { cols: 40, rows: 12 } }),
    );
    cleanupSubshellWs(ws); // browser gone before the attach assigned anything
    await attaching;

    expect(sharedGridFor(SID)).toBeNull();
    expect(paneStreams.viewerCount(SID)).toBe(0);
    expect(sim.cmdTypes()).not.toContain("tail_start");
  });

  it("runs ONE tail for the pane however many browsers watch it", async () => {
    // `NodeLauncher`'s contract: "Callers MUST NOT overlap per-subshell pumps
    // … even serialized dispatch can flip the read-your-writes order these
    // pumps rely on." Two viewers each running their own `tail_start` is two
    // independent dup-clamp/backfill states over one byte stream, so each
    // device can observe a different order and neither is authoritative.
    const sim = makeNodeSim();
    // See the note in the case above: one round per attach is not enough.
    sim.answer("probe", [{ subshellId: SID, alive: true, exitCode: null }]);
    sim.answer("probe", [{ subshellId: SID, alive: true, exitCode: null }]);
    sim.answer("capture", `${BSU}SCREEN${ESU}`);
    sim.answer("capture", `${BSU}SCREEN${ESU}`);
    scriptLogRead(sim, { bytes: "ab\ncd\n", size: 7 }, 60);
    const first = fakeBrowser();
    const second = fakeBrowser();

    await attachRemoteSubshellWs(first.ws, attachRow(), new RemoteLauncher(NODE_ID), "owner", attachParams());
    await until(() => sim.cmdTypes().includes("tail_start"), "first tail");
    await attachRemoteSubshellWs(second.ws, attachRow(), new RemoteLauncher(NODE_ID), "owner", attachParams());

    expect(sim.cmdTypes().filter((t) => t === "tail_start")).toHaveLength(1);

    // Both browsers get the SAME bytes from that one pump.
    const output = (b: typeof first) => b.sent.filter((f) => f.includes('"type":"output"'));
    dispatchOutput(outputFrame(subIdOf(sim), 7, "shared\r\n"));
    await until(() => output(first).length === 1 && output(second).length === 1, "both fed");
    expect(output(first)).toEqual(output(second));

    // ...and the pump survives one of them leaving, then stops with the last.
    cleanupSubshellWs(second.ws);
    await Bun.sleep(30);
    expect(sim.cmdTypes().filter((t) => t === "tail_stop")).toHaveLength(0);
    cleanupSubshellWs(first.ws);
    await until(() => sim.cmdTypes().includes("tail_stop"), "tail stopped with the last viewer");
    expect(sim.cmdTypes().filter((t) => t === "tail_stop")).toHaveLength(1);
  });
});

describe("readSubshellLogTail routes by node", () => {
  it("an agent-node row reads through that node's launcher (size probe + window, real RPC)", async () => {
    const sim = makeNodeSim();
    scriptLogRead(sim, { bytes: "l1\nl2\n", size: 9 }, 2);
    expect(await readSubshellLogTail(SID, NODE_ID)).toEqual({ lines: ["l1", "l2"], truncated: false });
    expect(sim.cmdsOf("log_read")).toEqual([
      { type: "log_read", subshellId: SID, fromByte: 0, maxBytes: 1 },
      { type: "log_read", subshellId: SID, fromByte: 0, maxBytes: LOG_BYTES },
    ]);
  });

  it("the default nodeId keeps the local file read (no node command ever fires)", async () => {
    const sim = makeNodeSim();
    expect(await readSubshellLogTail(SID)).toEqual({ lines: [], truncated: false }); // no such local log
    expect(sim.cmdTypes()).toEqual([]);
  });
});
