import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TmuxRunner } from "@internal/harnesses";
import type { NodeCommandBody, NodeEvent } from "@internal/session-protocol";
import { spawnSync } from "bun";
import type { CommandContext, CommandResult } from "../commands/context.js";
import { dispatchCommand } from "../commands/index.js";
import { execLaunch } from "../commands/launch.js";
import { buildSessionsReport, EXIT_WATCH_INTERVAL_MS, startExitWatcher, stopWatcher } from "../commands/report.js";
import type { AgentConfig } from "../config.js";
import { type SessionMeta, SessionMetaStore } from "../session-meta.js";

/**
 * Task 4: the `launch` executor, the exit watcher, and `sessions_report`
 * (spec 2026-08-31 §6.4/§7). Same fake-tmux discipline as commands-basics:
 * a plain-object double records ordered calls, unstubbed methods throw. The
 * harness under test is the REAL claude-code plugin — its `findBinary` honors
 * the `CLAUDE_PATH` env override, so the binary-found / binary-missing paths
 * are deterministic on every host (the §6.4 byte-parity claim is that BOTH
 * sides call the same `buildHarnessCommand`; here we prove the agent calls it
 * with the plugin-local MCP dialect and every launch input).
 */

const S1 = "11111111-1111-4111-8111-111111111111";
const S2 = "22222222-2222-4222-8222-222222222222";
const FIXED_NOW = 1_700_000_000_000;

let base: string;
let claudePathOriginal: string | undefined;

beforeAll(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "mote-launch-")));
});

beforeEach(() => {
  // Default: the harness binary "exists" (/bin/sh — never spawned; the pane is
  // a double everywhere except the gated real-tmux smoke case).
  claudePathOriginal = process.env.CLAUDE_PATH;
  process.env.CLAUDE_PATH = "/bin/sh";
});

afterEach(() => {
  if (claudePathOriginal === undefined) delete process.env.CLAUDE_PATH;
  else process.env.CLAUDE_PATH = claudePathOriginal;
});

afterAll(() => rmSync(base, { recursive: true, force: true }));

/** A fresh temp dataDir per test (mcp/sessions writes are file-visible). */
function freshDataDir(tag: string): string {
  const dir = join(base, tag);
  mkdirSync(dir, { recursive: true });
  return dir;
}

interface Spec {
  newSession?: (socket: string, id: string, cwd: string, cmd: string) => void;
  pipePane?: (socket: string, id: string, out: string) => void;
  resizeWindow?: (socket: string, id: string, cols: number, rows: number) => void;
  hasSession?: (socket: string, id: string) => boolean;
  paneExitCode?: (socket: string, id: string) => number | null;
  killSession?: (socket: string, id: string) => void;
  run?: (args: string[]) => { stdout: string; stderr: string };
}

/** Build a CommandContext over a scripted double on `dataDir`; unstubbed calls throw. */
function makeCtx(
  dataDir: string,
  spec: Spec,
  events: NodeEvent[],
): { ctx: CommandContext; calls: Array<{ method: string; args: unknown[] }> } {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const method = (name: keyof Spec) => {
    const impl = spec[name];
    return (...args: unknown[]) => {
      calls.push({ method: name, args });
      if (!impl) throw new Error(`fake tmux: unstubbed call ${String(name)}(${JSON.stringify(args)})`);
      return (impl as (...a: unknown[]) => unknown)(...args);
    };
  };
  const raw = {
    newSession: method("newSession"),
    pipePane: method("pipePane"),
    resizeWindow: method("resizeWindow"),
    hasSession: method("hasSession"),
    paneExitCode: method("paneExitCode"),
    killSession: method("killSession"),
    run: method("run"),
  };
  const config: AgentConfig = {
    serverUrl: "http://localhost:1",
    nodeId: "node-1",
    nodeKey: "k",
    controlPublicKey: "{}",
    dataDir,
    name: "test-node",
  };
  const ctx: CommandContext = {
    config,
    tmux: raw as unknown as CommandContext["tmux"],
    meta: new SessionMetaStore(dataDir),
    nowMs: () => FIXED_NOW,
    ws: { send: (ev) => events.push(ev) },
    watchers: new Map(),
    tails: new Map(),
    uploads: new Map(),
  };
  return { ctx, calls };
}

type LaunchCmd = Extract<NodeCommandBody, { type: "launch" }>;

function launchCmd(over: Partial<LaunchCmd> = {}): LaunchCmd {
  return {
    type: "launch",
    sessionId: S1,
    socket: "mote-launch-test",
    cwd: base,
    harnessId: "claude-code",
    profile: { name: "p", env: {}, flags: [], settings: null, configIsolation: false },
    moteEnv: { MOTE_API_KEY: "k" },
    sessionName: "s1",
    cols: 120,
    rows: 30,
    ...over,
  };
}

async function recordMeta(store: SessionMetaStore, sessionId: string, socket: string): Promise<void> {
  await store.record({
    sessionId,
    cwd: base,
    socket,
    harnessId: "claude-code",
    name: "m",
    startedAt: "2026-09-01T00:00:00.000Z",
  });
}

/** The claude dialect the AGENT regenerates locally (Step-3 design note). */
function localMcpContent(): string {
  return `${JSON.stringify({ mcpServers: { mote: { command: process.execPath, args: ["mcp"] } } }, null, 2)}\n`;
}

async function waitFor(cond: () => boolean, what: string, timeoutMs = 5_000): Promise<void> {
  const t0 = Date.now();
  for (;;) {
    if (cond()) return;
    if (Date.now() - t0 > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

async function waitForAsync(cond: () => Promise<boolean>, what: string, timeoutMs = 5_000): Promise<void> {
  const t0 = Date.now();
  for (;;) {
    if (await cond()) return;
    if (Date.now() - t0 > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

function methodsOf(calls: Array<{ method: string }>): string[] {
  return calls.map((c) => c.method);
}

/* ------------------------------------------------------------------ */

describe("execLaunch (spec §6.4/§7)", () => {
  it("happy launch: meta recorded BEFORE newSession, call ORDER newSession→pipePane(logPath)→resize, {ok:true}", async () => {
    const dataDir = freshDataDir("happy");
    const events: NodeEvent[] = [];
    let probe: Promise<SessionMeta | undefined> | undefined;
    let paneCmd = "";
    const { ctx, calls } = makeCtx(
      dataDir,
      {
        newSession: (socket, id, cwd, cmd) => {
          // Ordering proof: the meta record is already readable when tmux is dialed.
          probe = ctx.meta.get(id);
          paneCmd = cmd;
          expect(socket).toBe("mote-launch-test");
          expect(cwd).toBe(base);
        },
        pipePane: () => {},
        resizeWindow: () => {},
      },
      events,
    );

    const result = await dispatchCommand(ctx, launchCmd());
    expect(result).toEqual({ ok: true });
    expect(events).toEqual([]); // the answer is the RESULT frame; no stray events
    expect(methodsOf(calls)).toEqual(["newSession", "pipePane", "resizeWindow"]);
    expect(calls[1]?.args).toEqual(["mote-launch-test", S1, ctx.meta.logPath(S1)]);
    expect(calls[2]?.args).toEqual(["mote-launch-test", S1, 120, 30]);

    // (4) meta recorded first — full record visible at newSession time and after.
    const recorded = await probe;
    expect(recorded).toBeDefined();
    expect(recorded).toMatchObject({
      sessionId: S1,
      cwd: base,
      socket: "mote-launch-test",
      harnessId: "claude-code",
      name: "s1",
    });
    expect(recorded?.startedAt).toBe(new Date(FIXED_NOW).toISOString());

    // (5) §6.4 assembly: env -i + moteEnv + the real claude argv (binary from CLAUDE_PATH).
    expect(paneCmd.startsWith("env -i ")).toBe(true);
    expect(paneCmd).toInclude("MOTE_API_KEY='k'");
    expect(paneCmd).toInclude("'/bin/sh'");
    expect(paneCmd).toInclude("'--settings'");
    expect(paneCmd).toInclude("'--name' 's1'");

    // (9) watcher registered — cleaned up so the timer cannot outlive the test.
    expect(ctx.watchers.has(S1)).toBe(true);
    stopWatcher(ctx, S1);
    expect(ctx.watchers.has(S1)).toBe(false);
  });

  it("resume pin rides the argv (§6.4: harnessSession = BuildCommandInput.harnessSession)", async () => {
    const dataDir = freshDataDir("resume-pin");
    let paneCmd = "";
    const { ctx } = makeCtx(
      dataDir,
      { newSession: (_s, _i, _c, cmd) => (paneCmd = cmd), pipePane: () => {}, resizeWindow: () => {} },
      [],
    );
    const result = await dispatchCommand(ctx, launchCmd({ harnessSession: { id: S2, mode: "resume" } }));
    expect(result).toEqual({ ok: true });
    expect(paneCmd).toInclude("'--resume' '22222222-2222-4222-8222-222222222222'");
    stopWatcher(ctx, S1);
  });

  it("no geometry on the wire ⇒ no resizeWindow call", async () => {
    const dataDir = freshDataDir("no-geometry");
    const { ctx, calls } = makeCtx(dataDir, { newSession: () => {}, pipePane: () => {} }, []);
    const result = await dispatchCommand(ctx, launchCmd({ cols: undefined, rows: undefined }));
    expect(result).toEqual({ ok: true });
    expect(methodsOf(calls)).toEqual(["newSession", "pipePane"]);
    stopWatcher(ctx, S1);
  });

  it("unknown harness ⇒ ok:false, NO tmux calls", async () => {
    const dataDir = freshDataDir("unknown-harness");
    const { ctx, calls } = makeCtx(dataDir, {}, []);
    const result = await dispatchCommand(ctx, launchCmd({ harnessId: "no-such-harness" }));
    expect(result).toEqual({ ok: false, error: "unknown harness: no-such-harness" });
    expect(calls).toEqual([]);
  });

  it("findBinary null ⇒ ok:false 'harness binary missing: <id>' and NO tmux calls, NO meta", async () => {
    const dataDir = freshDataDir("no-binary");
    process.env.CLAUDE_PATH = join(base, "definitely-not-executable");
    const { ctx, calls } = makeCtx(dataDir, {}, []);
    const result = await dispatchCommand(ctx, launchCmd());
    // The exact message CLASS the backend maps to inventory-refresh-on-failure (§6.2).
    expect(result).toEqual({ ok: false, error: "harness binary missing: claude-code" });
    expect(calls).toEqual([]);
    expect(await ctx.meta.get(S1)).toBeUndefined();
  });

  it("a malformed session id is refused before ANY harness/tmux/meta work", async () => {
    const dataDir = freshDataDir("bad-id");
    const { ctx, calls } = makeCtx(dataDir, {}, []);
    const result = await dispatchCommand(ctx, launchCmd({ sessionId: "../evil" }));
    expect(result).toEqual({ ok: false, error: "invalid session id" });
    expect(calls).toEqual([]);
  });

  it("newSession throws ⇒ ok:false + meta FORGOTTEN (rollback) + no watcher + no pipePane", async () => {
    const dataDir = freshDataDir("newsession-throws");
    const { ctx, calls } = makeCtx(
      dataDir,
      {
        newSession: () => {
          throw new Error("no server running");
        },
      },
      [],
    );
    const result = await dispatchCommand(ctx, launchCmd());
    expect(result).toEqual({ ok: false, error: "no server running" });
    expect(await ctx.meta.get(S1)).toBeUndefined(); // rolled back
    expect(ctx.watchers.size).toBe(0);
    expect(methodsOf(calls)).toEqual(["newSession"]); // pipePane never attempted
  });

  it("mcp path outside dataDir ⇒ ok:false 'mcp path refused', no spawn, no writes", async () => {
    const dataDir = freshDataDir("mcp-refused");
    const { ctx, calls } = makeCtx(dataDir, {}, []);
    const result = await dispatchCommand(
      ctx,
      launchCmd({ mcp: { path: "/etc/passwd", fileContent: localMcpContent() } }),
    );
    expect(result).toEqual({ ok: false, error: "mcp path refused" });
    expect(calls).toEqual([]);
    expect(existsSync(join(dataDir, "mcp"))).toBe(false); // dir not even created
  });

  it("mcp happy ⇒ file exists mode 600 with exact local-dialect content; --mcp-config rides the pane argv", async () => {
    const dataDir = freshDataDir("mcp-happy");
    const mcpFile = join(dataDir, "mcp", `${S1}.json`);
    let paneCmd = "";
    const { ctx } = makeCtx(
      dataDir,
      {
        newSession: (_s, _i, _c, cmd) => {
          paneCmd = cmd;
        },
        pipePane: () => {},
        resizeWindow: () => {},
      },
      [],
    );
    const result = await dispatchCommand(ctx, launchCmd({ mcp: { path: mcpFile, fileContent: localMcpContent() } }));
    expect(result).toEqual({ ok: true });
    stopWatcher(ctx, S1);
    expect(existsSync(mcpFile)).toBe(true);
    expect(statSync(mcpFile).mode & 0o077).toBe(0); // 0600 — no group/other bits
    expect(statSync(join(dataDir, "mcp")).mode & 0o077).toBe(0); // dir re-tightened to 0700
    expect(await Bun.file(mcpFile).text()).toBe(localMcpContent());
    // The plugin's OWN argv (never on the wire) — the agent regenerated it locally.
    expect(paneCmd).toInclude(`'--mcp-config' '${mcpFile}'`);
  });

  it("mcp content drift ⇒ one warn line and the LOCAL content wins over the wire value", async () => {
    const dataDir = freshDataDir("mcp-drift");
    const mcpFile = join(dataDir, "mcp", `${S1}.json`);
    const lines: string[] = [];
    const spy = spyOn(console, "log").mockImplementation((...a: unknown[]) => {
      lines.push(a.join(" "));
    });
    let ctx: CommandContext | undefined;
    try {
      const made = makeCtx(
        dataDir,
        {
          newSession: () => {},
          pipePane: () => {},
          resizeWindow: () => {},
        },
        [],
      );
      ctx = made.ctx;
      const result = await dispatchCommand(
        ctx,
        launchCmd({ mcp: { path: mcpFile, fileContent: '{"stale":"control-plane guess"}' } }),
      );
      expect(result).toEqual({ ok: true });
      expect(await Bun.file(mcpFile).text()).toBe(localMcpContent()); // local wins
      expect(lines.filter((l) => l.toLowerCase().includes("mcp"))).toHaveLength(1); // ONE warn line
    } finally {
      spy.mockRestore();
      if (ctx) stopWatcher(ctx, S1);
    }
  });

  it("bestEffortLog + throwing pipePane ⇒ one warn line, still {ok:true}, resize + watcher run", async () => {
    const dataDir = freshDataDir("best-effort-pipe");
    const lines: string[] = [];
    const spy = spyOn(console, "log").mockImplementation((...a: unknown[]) => {
      lines.push(a.join(" "));
    });
    try {
      const { ctx, calls } = makeCtx(
        dataDir,
        {
          newSession: () => {},
          pipePane: () => {
            throw new Error("pipe-pane refused");
          },
          resizeWindow: () => {},
        },
        [],
      );
      const result = await dispatchCommand(ctx, launchCmd({ bestEffortLog: true }));
      expect(result).toEqual({ ok: true }); // the pane is live — revive parity
      expect(lines.filter((l) => l.includes("log attach"))).toHaveLength(1);
      expect(methodsOf(calls)).toEqual(["newSession", "pipePane", "resizeWindow"]);
      expect(ctx.watchers.has(S1)).toBe(true);
      stopWatcher(ctx, S1);
    } finally {
      spy.mockRestore();
    }
  });

  it("bestEffortLog wraps mkdir TOO: throwing sessions-dir mkdir ⇒ warn + {ok:true}, pipePane skipped", async () => {
    const dataDir = freshDataDir("best-effort-mkdir");
    const lines: string[] = [];
    const spy = spyOn(console, "log").mockImplementation((...a: unknown[]) => {
      lines.push(a.join(" "));
    });
    try {
      const { ctx, calls } = makeCtx(
        dataDir,
        {
          newSession: () => {},
          pipePane: () => {},
          resizeWindow: () => {},
        },
        [],
      );
      const result = await launchWithSabotagedSessionsDir(ctx, launchCmd({ bestEffortLog: true }), dataDir);
      expect(result).toEqual({ ok: true });
      expect(lines.filter((l) => l.includes("log attach"))).toHaveLength(1);
      // mkdir threw INSIDE the guard → pipePane never ran; the launch CONTINUES (resize still fits the pane).
      expect(methodsOf(calls)).toEqual(["newSession", "resizeWindow"]);
      stopWatcher(ctx, S1);
    } finally {
      spy.mockRestore();
    }
  });

  it("STRICT default: throwing log attach fails the launch (createSession parity), NO watcher", async () => {
    const dataDir = freshDataDir("strict-mkdir");
    const { ctx, calls } = makeCtx(
      dataDir,
      {
        newSession: () => {},
        pipePane: () => {},
        resizeWindow: () => {},
      },
      [],
    );
    const result = await launchWithSabotagedSessionsDir(ctx, launchCmd(), dataDir);
    expect(result.ok).toBe(false);
    expect(!result.ok && /EEXIST/.test(result.error)).toBe(true);
    expect(methodsOf(calls)).toEqual(["newSession"]); // strict: nothing after the mkdir throw
    expect(ctx.watchers.size).toBe(0);
    // strict failure keeps the record (parity with the local throw path); tidy up —
    // the record is already gone (the sabotage deleted its dir), restore-unlink-restore:
    rmSync(join(dataDir, "sessions"), { force: true });
    await ctx.meta.forget(S1);
  });

  it("throwing resizeWindow is log-and-continue (geometry is cosmetic)", async () => {
    const dataDir = freshDataDir("resize-throws");
    const lines: string[] = [];
    const spy = spyOn(console, "log").mockImplementation((...a: unknown[]) => {
      lines.push(a.join(" "));
    });
    try {
      const { ctx } = makeCtx(
        dataDir,
        {
          newSession: () => {},
          pipePane: () => {},
          resizeWindow: () => {
            throw new Error("can't find window");
          },
        },
        [],
      );
      expect(await dispatchCommand(ctx, launchCmd())).toEqual({ ok: true });
      expect(lines.some((l) => l.toLowerCase().includes("resize"))).toBe(true);
      stopWatcher(ctx, S1);
    } finally {
      spy.mockRestore();
    }
  });
});

/**
 * Run a launch whose step-(7) sessions-dir mkdir MUST throw: the sabotage
 * lands between the meta record (which creates the dir) and the attach —
 * `newSession` swaps the sessions dir for a regular file, so
 * `mkdir(dir, {recursive:true})` fails with EEXIST. The throwing-mkdir twin
 * of a throwing pipe-pane.
 */
async function launchWithSabotagedSessionsDir(
  ctx: CommandContext,
  cmd: LaunchCmd,
  dataDir: string,
): Promise<CommandResult> {
  const original = ctx.tmux.newSession.bind(ctx.tmux);
  (ctx.tmux as unknown as { newSession: (...a: unknown[]) => void }).newSession = (...a: unknown[]) => {
    (original as (...x: unknown[]) => void)(...a);
    rmSync(join(dataDir, "sessions"), { recursive: true, force: true });
    writeFileSync(join(dataDir, "sessions"), "sabotage");
  };
  try {
    return await execLaunch(ctx, cmd);
  } catch (err) {
    // The dispatcher's wrap, applied here (execLaunch PROPAGATES strict throws by design).
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/* ------------------------------------------------------------------ */

describe("exit watcher (report.ts)", () => {
  it("pane death ⇒ ONE exit event {exitCode, at}, interval cleared, meta forgotten", async () => {
    const dataDir = freshDataDir("watcher-death");
    const events: NodeEvent[] = [];
    let ticks = 0;
    const { ctx, calls } = makeCtx(
      dataDir,
      {
        hasSession: () => ticks++ === 0, // alive on the first tick, gone after
        paneExitCode: () => 7,
      },
      events,
    );
    await recordMeta(ctx.meta, S1, "w-sock");
    expect(EXIT_WATCH_INTERVAL_MS).toBe(2_000); // production cadence (spec §7)
    await startExitWatcher(ctx, S1, 20); // short interval, real timers (daemon-test polling style)
    expect(ctx.watchers.has(S1)).toBe(true);
    await waitFor(() => events.length > 0, "exit event");
    expect(events[0]).toEqual({ type: "exit", sessionId: S1, exitCode: 7, at: new Date(FIXED_NOW).toISOString() });
    expect(ctx.watchers.size).toBe(0); // cleared on fire
    await waitForAsync(async () => (await ctx.meta.get(S1)) === undefined, "meta forgotten");
    expect(calls.some((c) => c.method === "paneExitCode" && c.args[0] === "w-sock" && c.args[1] === S1)).toBe(true);
    await new Promise((r) => setTimeout(r, 80)); // an extra beat: never a second event
    expect(events.length).toBe(1);
  });

  it("paneExitCode null (server gone before a status was read) ⇒ exitCode null rides the event", async () => {
    const dataDir = freshDataDir("watcher-null");
    const events: NodeEvent[] = [];
    let ticks = 0;
    const { ctx } = makeCtx(dataDir, { hasSession: () => ticks++ === 0, paneExitCode: () => null }, events);
    await recordMeta(ctx.meta, S1, "w2");
    await startExitWatcher(ctx, S1, 20);
    await waitFor(() => events.length > 0, "exit event");
    expect(events[0]).toMatchObject({ type: "exit", sessionId: S1, exitCode: null });
  });

  it("execKill and execTerminate STOP the watcher — a dead-on-arrival pane never reports after a deliberate kill", async () => {
    const dataDir = freshDataDir("watcher-kill");
    const events: NodeEvent[] = [];
    const { ctx } = makeCtx(
      dataDir,
      {
        hasSession: () => false, // an UNSUPPRESSED watcher would fire on its very first tick
        paneExitCode: () => 9,
        killSession: () => {},
        run: () => ({ stdout: "", stderr: "" }),
      },
      events,
    );
    await recordMeta(ctx.meta, S1, "k-sock");
    await startExitWatcher(ctx, S1, 20);
    expect(await dispatchCommand(ctx, { type: "kill", sessionId: S1 })).toEqual({ ok: true });
    expect(ctx.watchers.size).toBe(0);
    await recordMeta(ctx.meta, S2, "k-sock-2");
    await startExitWatcher(ctx, S2, 20);
    expect(await dispatchCommand(ctx, { type: "terminate", sessionId: S2 })).toEqual({ ok: true });
    expect(ctx.watchers.size).toBe(0);
    await new Promise((r) => setTimeout(r, 120)); // several 20 ms beats
    // The real contract: a deliberate kill answers before the next tick can
    // fire, so NO `exit` event ever appears. (Probe COUNTS are not asserted —
    // a `hasSession` tick landing in the tiny window between watcher start
    // and the executor's stop is a timing race on a loaded host, not a bug.)
    expect(events.filter((e) => e.type === "exit")).toEqual([]); // neither deliberate kill produced an exit event
  });
});

/* ------------------------------------------------------------------ */

describe("buildSessionsReport (spec §3.3)", () => {
  it("one row per recorded meta: alive ⇒ null exit, dead ⇒ paneExitCode", async () => {
    const dataDir = freshDataDir("sessions-report");
    const { ctx } = makeCtx(dataDir, { hasSession: (_s, id) => id === S1, paneExitCode: () => 2 }, []);
    await recordMeta(ctx.meta, S1, "sock-a");
    await recordMeta(ctx.meta, S2, "sock-b");
    const report = await buildSessionsReport(ctx);
    expect(report).toEqual({
      type: "sessions_report",
      sessions: [
        { sessionId: S1, alive: true, exitCode: null },
        { sessionId: S2, alive: false, exitCode: 2 },
      ],
    });
  });

  it("no metas ⇒ an empty sessions list (still a valid event)", async () => {
    const dataDir = freshDataDir("sessions-report-empty");
    const { ctx } = makeCtx(dataDir, {}, []);
    expect(await buildSessionsReport(ctx)).toEqual({ type: "sessions_report", sessions: [] });
  });
});

/* ------------------------------------------------------------------ */
/* Step 5: real-tmux smoke (gated on `which tmux`, mirroring the         */
/* backend's Bun.which skip pattern)                                     */
/* ------------------------------------------------------------------ */

const HAS_TMUX = Bun.which("tmux");

it.skipIf(!HAS_TMUX)(
  "smoke (real tmux): launch a stub harness pane, kill it, receive the exit event",
  async () => {
    const dataDir = freshDataDir("smoke");
    const workDir = join(base, "smoke-work");
    mkdirSync(workDir, { recursive: true });
    const stub = join(base, "stub-harness");
    // argv-agnostic stub: claude's --settings/--name tokens are simply ignored.
    writeFileSync(stub, "#!/bin/sh\necho hi\nexec sleep 30\n", { mode: 0o755 });
    process.env.CLAUDE_PATH = stub;

    const socket = `mote-test-${crypto.randomUUID().slice(0, 8)}`;
    const sessionId = crypto.randomUUID();
    const events: NodeEvent[] = [];
    const runner = new TmuxRunner();
    const config: AgentConfig = {
      serverUrl: "http://localhost:1",
      nodeId: "node-1",
      nodeKey: "k",
      controlPublicKey: "{}",
      dataDir,
      name: "smoke-node",
    };
    const ctx: CommandContext = {
      config,
      tmux: runner,
      meta: new SessionMetaStore(dataDir),
      nowMs: () => Date.now(),
      ws: { send: (ev) => events.push(ev) },
      watchers: new Map(),
      tails: new Map(),
      uploads: new Map(),
    };
    try {
      const result = await dispatchCommand(
        ctx,
        launchCmd({ sessionId, socket, cwd: workDir, cols: undefined, rows: undefined }),
      );
      expect(result).toEqual({ ok: true });
      expect(runner.hasSession(socket, sessionId)).toBe(true); // the pane is LIVE through real tmux
      runner.killSession(socket, sessionId); // deliberate death — the watcher's job is to notice it
      await waitFor(() => events.some((e) => e.type === "exit"), "exit event from the real-death watcher", 15_000);
      const exit = events.find((e) => e.type === "exit") as Extract<NodeEvent, { type: "exit" }>;
      expect(exit.sessionId).toBe(sessionId);
      expect(Number.isNaN(Date.parse(exit.at))).toBe(false);
      await waitForAsync(async () => (await ctx.meta.get(sessionId)) === undefined, "meta forgotten after exit", 5_000);
    } finally {
      // Always reap: killSession, then the WHOLE server on this socket, then the
      // socket file — a failed assertion must not leak a tmux daemon.
      runner.killSession(socket, sessionId);
      spawnSync(["tmux", "-L", socket, "kill-server"], { stdout: "ignore", stderr: "ignore" });
      runner.cleanSocket(socket);
      for (const w of ctx.watchers.values()) clearInterval(w);
      ctx.watchers.clear();
    }
  },
  30_000,
);
