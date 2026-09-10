import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TmuxRunner } from "@internal/pane-runtime";
import { HARNESS_BINARY_PLACEHOLDER, type NodeCommandBody, type NodeEvent } from "@internal/subshell-protocol";
import { spawnSync } from "bun";
import type { CommandContext, CommandResult } from "../commands/context.js";
import { dispatchCommand } from "../commands/index.js";
import { execLaunch } from "../commands/launch.js";
import {
  buildSubshellsReport,
  EXIT_WATCH_INTERVAL_MS,
  runExitWatchTick,
  startExitWatcher,
  stopWatcher,
} from "../commands/report.js";
import type { AgentConfig } from "../config.js";
import { type SubshellMeta, SubshellMetaStore } from "../subshell-meta.js";
import { captureLogs } from "./helpers/capture-logs.js";

/**
 * Task 4 + Task 7: the `launch` executor, the exit watcher, and
 * `subshells_report` (spec 2026-08-31 §6.4/§7, inversion spec 2026-09-10 §5/§6).
 * Same fake-tmux discipline as commands-basics: a plain-object double records
 * ordered calls, unstubbed methods throw. The node holds no plugin anymore,
 * so every frame carries the server-built argv + a resolve rule; the binary
 * is found through `findBinary` honoring the `CLAUDE_PATH` env override, so
 * the binary-found / binary-missing paths are deterministic on every host.
 * (The §6.4 byte-parity claim lives in the argv-parity matrix, which builds
 * the sent argv with the real plugin and compares against the node's spawn.)
 */

const S1 = "11111111-1111-4111-8111-111111111111";
const S2 = "22222222-2222-4222-8222-222222222222";
const S3 = "33333333-3333-4333-8333-333333333333";
const FIXED_NOW = 1_700_000_000_000;

let base: string;
let claudePathOriginal: string | undefined;

beforeAll(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "subshell-launch-")));
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

/**
 * A fresh temp dataDir per test (mcp/subshells writes are file-visible).
 *
 * Nothing is installed into it anymore: the node holds no plugin concept
 * (inversion §6), so a launch works against a bare directory. The
 * no-plugins-dir case is pinned explicitly below.
 */
async function freshDataDir(tag: string): Promise<string> {
  const dir = join(base, tag);
  mkdirSync(dir, { recursive: true });
  return dir;
}

interface Spec {
  newSubshell?: (socket: string, id: string, cwd: string, cmd: string) => void;
  pipePane?: (socket: string, id: string, out: string) => void;
  resizeWindow?: (socket: string, id: string, cols: number, rows: number) => void;
  hasSubshell?: (socket: string, id: string) => boolean;
  listSubshellNames?: (socket: string) => string[];
  /**
   * Tri-state probe script (design 2026-09-02 §1). When UNSTUBBED, the fake
   * derives `{ ok: true, names: listSubshellNames(socket) }` from the switch
   * above — so a pre-threshold test's `[]` keeps its old meaning (a socket
   * that ANSWERED with the pane missing, i.e. confirmed death), and its
   * spawn-count assertions still see the call recorded under
   * "listSubshellNames" (the derivation runs through that wrapper).
   */
  listSubshellsChecked?: (socket: string) => { ok: true; names: string[] } | { ok: false; detail: string };
  paneExitCode?: (socket: string, id: string) => number | null;
  killSubshell?: (socket: string, id: string) => void;
  run?: (args: string[]) => { stdout: string; stderr: string };
}

/** A one-shot promise plus its resolver (the gated-forget fixtures drive these). */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

/**
 * A real {@link SubshellMetaStore} that models a tick stuck INSIDE
 * `await ctx.meta.forget(...)`: the underlying forget work (mirror eviction +
 * unlink) runs first, then the returned promise is held on a test-resolved
 * gate. This is the production ordering the fix documents as self-healing —
 * a relaunch landing in the window writes its meta AFTER the old unlink and
 * before the watcher entry is re-checked — so the surviving record is proof
 * the tick's post-await sweep respected the newer registration, not proof
 * forget never ran.
 */
class GateHeldMetaStore extends SubshellMetaStore {
  /** Resolves once the tick's first `forget` has done its underlying work and entered the held window. */
  readonly forgetEntered = deferred();
  /** While pending, every `forget` promise is held here — the relaunch interleaving window. */
  readonly forgetGate = deferred();

  override async forget(id: string): Promise<void> {
    await super.forget(id);
    this.forgetEntered.resolve();
    await this.forgetGate.promise;
  }
}

/** Build a CommandContext over a scripted double on `dataDir`; unstubbed calls throw. */
function makeCtx(
  dataDir: string,
  spec: Spec,
  events: NodeEvent[],
  meta?: SubshellMetaStore,
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
  const listSubshellNames = method("listSubshellNames");
  const raw = {
    newSubshell: method("newSubshell"),
    pipePane: method("pipePane"),
    resizeWindow: method("resizeWindow"),
    hasSubshell: method("hasSubshell"),
    listSubshellNames,
    listSubshellsChecked: (socket: string): { ok: true; names: string[] } | { ok: false; detail: string } => {
      calls.push({ method: "listSubshellsChecked", args: [socket] });
      const scripted = spec.listSubshellsChecked;
      if (scripted) return scripted(socket);
      // Unscripted: answer through the listSubshellNames switch, always as a
      // SUCCESSFUL probe — pre-threshold tests keep their exact meaning.
      return { ok: true, names: listSubshellNames(socket) as string[] };
    },
    paneExitCode: method("paneExitCode"),
    killSubshell: method("killSubshell"),
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
    meta: meta ?? new SubshellMetaStore(dataDir),
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
    subshellId: S1,
    socket: "subshell-launch-test",
    cwd: base,
    harnessId: "claude-code",
    profile: { name: "p", env: {}, flags: [], settings: null, configIsolation: false },
    subshellEnv: { SUBSHELL_API_KEY: "k" },
    subshellName: "s1",
    cols: 120,
    rows: 30,
    // The inversion made argv the whole launch (Task 7 removed the node-side
    // builder): the default carries the server-shaped frame, binary slot and
    // all, with the resolve rule pointing at the CLAUDE_PATH override the
    // beforeEach scripts, so every case is deterministic on every host.
    argv: [HARNESS_BINARY_PLACEHOLDER],
    resolve: { binaryName: "claude", envOverride: "CLAUDE_PATH" },
    ...over,
  };
}

async function recordMeta(store: SubshellMetaStore, subshellId: string, socket: string): Promise<void> {
  await store.record({
    subshellId,
    cwd: base,
    socket,
    harnessId: "claude-code",
    name: "m",
    startedAt: "2026-09-01T00:00:00.000Z",
  });
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
  it("happy launch: meta recorded BEFORE newSubshell, call ORDER newSubshell→pipePane(logPath)→resize, {ok:true}", async () => {
    const dataDir = await freshDataDir("happy");
    const events: NodeEvent[] = [];
    let probe: Promise<SubshellMeta | undefined> | undefined;
    let paneCmd = "";
    const { ctx, calls } = makeCtx(
      dataDir,
      {
        newSubshell: (socket, id, cwd, cmd) => {
          // Ordering proof: the meta record is already readable when tmux is dialed.
          probe = ctx.meta.get(id);
          paneCmd = cmd;
          expect(socket).toBe("subshell-launch-test");
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
    expect(methodsOf(calls)).toEqual(["newSubshell", "pipePane", "resizeWindow"]);
    expect(calls[1]?.args).toEqual(["subshell-launch-test", S1, ctx.meta.logPath(S1)]);
    expect(calls[2]?.args).toEqual(["subshell-launch-test", S1, 120, 30]);

    // (4) meta recorded first — full record visible at newSubshell time and after.
    const recorded = await probe;
    expect(recorded).toBeDefined();
    expect(recorded).toMatchObject({
      subshellId: S1,
      cwd: base,
      socket: "subshell-launch-test",
      harnessId: "claude-code",
      name: "s1",
    });
    expect(recorded?.startedAt).toBe(new Date(FIXED_NOW).toISOString());

    // (5) §6.4 assembly: env -i + subshellEnv over the sent argv, the binary
    // slot bound to CLAUDE_PATH's /bin/sh by the frame's resolve rule.
    expect(paneCmd.startsWith("env -i ")).toBe(true);
    expect(paneCmd).toInclude("SUBSHELL_API_KEY='k'");
    expect(paneCmd).toInclude("'/bin/sh'");
    expect(paneCmd).not.toInclude(HARNESS_BINARY_PLACEHOLDER);

    // (9) watcher registered — cleaned up so the timer cannot outlive the test.
    expect(ctx.watchers.has(S1)).toBe(true);
    stopWatcher(ctx, S1);
    expect(ctx.watchers.has(S1)).toBe(false);
  });

  it("no geometry on the wire ⇒ no resizeWindow call", async () => {
    const dataDir = await freshDataDir("no-geometry");
    const { ctx, calls } = makeCtx(dataDir, { newSubshell: () => {}, pipePane: () => {} }, []);
    const result = await dispatchCommand(ctx, launchCmd({ cols: undefined, rows: undefined }));
    expect(result).toEqual({ ok: true });
    expect(methodsOf(calls)).toEqual(["newSubshell", "pipePane"]);
    stopWatcher(ctx, S1);
  });

  // The "launch with no argv" case this file used to pin is GONE with the
  // interim v2 tolerance: since protocol 3 the frame parser refuses a launch
  // without `argv` or `resolve` before dispatch (`__tests__/node-frames.test.ts`,
  // "a launch without argv or without resolve no longer parses"), so no
  // dispatchable command of that shape exists to answer here.
  it("findBinary null ⇒ ok:false 'harness binary missing: <id>' and NO tmux calls, NO meta", async () => {
    const dataDir = await freshDataDir("no-binary");
    process.env.CLAUDE_PATH = join(base, "definitely-not-executable");
    const { ctx, calls } = makeCtx(dataDir, {}, []);
    const result = await dispatchCommand(ctx, launchCmd());
    // The exact message CLASS the backend maps to inventory-refresh-on-failure (§6.2).
    expect(result).toEqual({ ok: false, error: "harness binary missing: claude-code" });
    expect(calls).toEqual([]);
    expect(await ctx.meta.get(S1)).toBeUndefined();
  });

  it("a malformed subshell id is refused before ANY harness/tmux/meta work", async () => {
    const dataDir = await freshDataDir("bad-id");
    const { ctx, calls } = makeCtx(dataDir, {}, []);
    const result = await dispatchCommand(ctx, launchCmd({ subshellId: "../evil" }));
    expect(result).toEqual({ ok: false, error: "invalid subshell id" });
    expect(calls).toEqual([]);
  });

  it("newSubshell throws ⇒ ok:false + meta FORGOTTEN (rollback) + no watcher + no pipePane", async () => {
    const dataDir = await freshDataDir("newsubshell-throws");
    const { ctx, calls } = makeCtx(
      dataDir,
      {
        newSubshell: () => {
          throw new Error("no server running");
        },
      },
      [],
    );
    const result = await dispatchCommand(ctx, launchCmd());
    expect(result).toEqual({ ok: false, error: "no server running" });
    expect(await ctx.meta.get(S1)).toBeUndefined(); // rolled back
    expect(ctx.watchers.size).toBe(0);
    expect(methodsOf(calls)).toEqual(["newSubshell"]); // pipePane never attempted
  });

  it("mcp path outside dataDir ⇒ ok:false 'mcp path refused', no spawn, no writes", async () => {
    const dataDir = await freshDataDir("mcp-refused");
    const { ctx, calls } = makeCtx(dataDir, {}, []);
    const result = await dispatchCommand(
      ctx,
      launchCmd({ mcp: { path: "/etc/passwd", fileContent: '{"mcpServers":{}}\n' } }),
    );
    expect(result).toEqual({ ok: false, error: "mcp path refused" });
    expect(calls).toEqual([]);
    expect(existsSync(join(dataDir, "mcp"))).toBe(false); // dir not even created
  });

  it("bestEffortLog + throwing pipePane ⇒ one warn line, still {ok:true}, resize + watcher run", async () => {
    const dataDir = await freshDataDir("best-effort-pipe");
    const { lines, restore } = captureLogs();
    try {
      const { ctx, calls } = makeCtx(
        dataDir,
        {
          newSubshell: () => {},
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
      expect(methodsOf(calls)).toEqual(["newSubshell", "pipePane", "resizeWindow"]);
      expect(ctx.watchers.has(S1)).toBe(true);
      stopWatcher(ctx, S1);
    } finally {
      restore();
    }
  });

  it("bestEffortLog wraps mkdir TOO: throwing subshells-dir mkdir ⇒ warn + {ok:true}, pipePane skipped", async () => {
    const dataDir = await freshDataDir("best-effort-mkdir");
    const { lines, restore } = captureLogs();
    try {
      const { ctx, calls } = makeCtx(
        dataDir,
        {
          newSubshell: () => {},
          pipePane: () => {},
          resizeWindow: () => {},
        },
        [],
      );
      const result = await launchWithSabotagedSubshellsDir(ctx, launchCmd({ bestEffortLog: true }), dataDir);
      expect(result).toEqual({ ok: true });
      expect(lines.filter((l) => l.includes("log attach"))).toHaveLength(1);
      // mkdir threw INSIDE the guard → pipePane never ran; the launch CONTINUES (resize still fits the pane).
      expect(methodsOf(calls)).toEqual(["newSubshell", "resizeWindow"]);
      stopWatcher(ctx, S1);
    } finally {
      restore();
    }
  });

  it("STRICT default: throwing log attach fails the launch (createSubshell parity), NO watcher", async () => {
    const dataDir = await freshDataDir("strict-mkdir");
    const { ctx, calls } = makeCtx(
      dataDir,
      {
        newSubshell: () => {},
        pipePane: () => {},
        resizeWindow: () => {},
      },
      [],
    );
    const result = await launchWithSabotagedSubshellsDir(ctx, launchCmd(), dataDir);
    expect(result.ok).toBe(false);
    expect(!result.ok && /EEXIST/.test(result.error)).toBe(true);
    expect(methodsOf(calls)).toEqual(["newSubshell"]); // strict: nothing after the mkdir throw
    expect(ctx.watchers.size).toBe(0);
    // strict failure keeps the record (parity with the local throw path); tidy up —
    // the record is already gone (the sabotage deleted its dir), restore-unlink-restore:
    rmSync(join(dataDir, "subshells"), { force: true });
    await ctx.meta.forget(S1);
  });

  it("throwing resizeWindow is log-and-continue (geometry is cosmetic)", async () => {
    const dataDir = await freshDataDir("resize-throws");
    const { lines, restore } = captureLogs();
    try {
      const { ctx } = makeCtx(
        dataDir,
        {
          newSubshell: () => {},
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
      restore();
    }
  });
});

/* ------------------------------------------------------------------ */
/* Inversion spec §5/§6: the sent argv IS the launch. Substitution is  */
/* STRICT ELEMENT EQUALITY (the argv-parity gate's binding rule), and  */
/* an unresolvable binary answers `harness binary missing:` — the       */
/* message CLASS the backend regex-matches to refresh an inventory.    */
/* ------------------------------------------------------------------ */

describe("execLaunch with a server-built argv (inversion §5)", () => {
  it("a launch carrying argv spawns exactly that, with the binary substituted", async () => {
    const dataDir = await freshDataDir("sent-argv");
    let paneCmd = "";
    const { ctx } = makeCtx(
      dataDir,
      { newSubshell: (_s, _i, _c, cmd) => (paneCmd = cmd), pipePane: () => {}, resizeWindow: () => {} },
      [],
    );
    const result = await dispatchCommand(
      ctx,
      launchCmd({
        argv: [HARNESS_BINARY_PLACEHOLDER, "--flag"],
        resolve: { binaryName: "claude", envOverride: "CLAUDE_PATH" },
      }),
    );
    expect(result).toEqual({ ok: true });
    stopWatcher(ctx, S1);
    // The binary slot carries the path resolved NOW from the resolve rule
    // (CLAUDE_PATH=/bin/sh), and the rest of the argv is the sent list verbatim.
    expect(paneCmd).toInclude(`'/bin/sh' '--flag'`);
    expect(paneCmd.endsWith("'--flag'")).toBe(true);
    // The locally-built claude argv (--settings/--name) is NOT on this pane:
    // with argv present, the plugin's buildCommand never runs.
    expect(paneCmd).not.toInclude("'--settings'");
    expect(paneCmd).not.toInclude(HARNESS_BINARY_PLACEHOLDER);
  });

  it("substitution is strict element equality: a longer token containing the placeholder survives untouched", async () => {
    const dataDir = await freshDataDir("sent-argv-element-equality");
    let paneCmd = "";
    const { ctx } = makeCtx(
      dataDir,
      { newSubshell: (_s, _i, _c, cmd) => (paneCmd = cmd), pipePane: () => {}, resizeWindow: () => {} },
      [],
    );
    // A flag may legitimately carry the placeholder TEXT inside a longer token
    // (argv-parity matrix row: `--append-system-prompt … @@HARNESS_BINARY@@ …`).
    // Substring replacement would silently rewrite it; only an entry EQUAL to
    // the placeholder is the binary.
    const longToken = `--note=the ${HARNESS_BINARY_PLACEHOLDER} stays`;
    const result = await dispatchCommand(
      ctx,
      launchCmd({
        argv: [longToken, HARNESS_BINARY_PLACEHOLDER, "tail"],
        resolve: { binaryName: "claude", envOverride: "CLAUDE_PATH" },
      }),
    );
    expect(result).toEqual({ ok: true });
    stopWatcher(ctx, S1);
    expect(paneCmd).toInclude(`'${longToken}'`); // untouched, placeholder text intact
    expect(paneCmd).toInclude(`'/bin/sh' 'tail'`); // the bare element was substituted
    expect(paneCmd.endsWith("'tail'")).toBe(true);
  });

  it("an unresolvable resolve rule on the sent path fails with the missing prefix, no tmux, no meta", async () => {
    const dataDir = await freshDataDir("sent-argv-unresolvable");
    const { ctx, calls } = makeCtx(dataDir, {}, []);
    // The failure must come from the frame's resolve rule, which is the ONLY
    // lookup now. A distinct env var keeps it independent of the default
    // resolve rule the other cases share.
    process.env.SENT_MISSING_PATH = join(base, "definitely-not-executable");
    try {
      const result = await dispatchCommand(
        ctx,
        launchCmd({
          argv: [HARNESS_BINARY_PLACEHOLDER],
          resolve: { binaryName: "nope", envOverride: "SENT_MISSING_PATH" },
        }),
      );
      // The exact message CLASS the backend maps to inventory-refresh-on-failure (§6.2).
      expect(result).toEqual({ ok: false, error: "harness binary missing: claude-code" });
      expect(calls).toEqual([]);
      expect(await ctx.meta.get(S1)).toBeUndefined();
    } finally {
      delete process.env.SENT_MISSING_PATH;
    }
  });

  // The "placeholder with no resolve rule" dispatch case went with the same
  // protocol-3 tightening: a launch frame without `resolve` never reaches
  // this executor (parser refuses it — pinned in the protocol test). The
  // case above keeps what it meant: a resolve rule that finds nothing
  // answers `harness binary missing:`.

  it("sent mcp content and env ride verbatim; the drift rule does not run on this path", async () => {
    const dataDir = await freshDataDir("sent-mcp-verbatim");
    const mcpFile = join(dataDir, "mcp", `${S1}.json`);
    const { lines, restore } = captureLogs();
    let paneCmd = "";
    try {
      const { ctx } = makeCtx(
        dataDir,
        { newSubshell: (_s, _i, _c, cmd) => (paneCmd = cmd), pipePane: () => {}, resizeWindow: () => {} },
        [],
      );
      const result = await dispatchCommand(
        ctx,
        launchCmd({
          argv: [HARNESS_BINARY_PLACEHOLDER, "--mcp-config", mcpFile],
          resolve: { binaryName: "claude", envOverride: "CLAUDE_PATH" },
          mcp: {
            path: mcpFile,
            fileContent: '{"from":"the control plane"}\n',
            args: ["--mcp-config", mcpFile],
            env: { OPENCODE_CONFIG: mcpFile },
          },
        }),
      );
      expect(result).toEqual({ ok: true });
      stopWatcher(ctx, S1);
      // The WIRE content is the content: with the local regeneration gone
      // (Task 7), there is no second source a drift rule could arbitrate.
      expect(await Bun.file(mcpFile).text()).toBe('{"from":"the control plane"}\n');
      expect(statSync(mcpFile).mode & 0o077).toBe(0); // the 0600 write is unchanged on both paths
      expect(statSync(join(dataDir, "mcp")).mode & 0o077).toBe(0); // dir re-tightened to 0700 (its own pin, survived the fallback's death)
      expect(lines.filter((l) => l.toLowerCase().includes("mcp"))).toHaveLength(0); // the drift warn is gone
      // The sent env rides the pane env layer; the sent argv is the whole command line.
      expect(paneCmd).toInclude(`OPENCODE_CONFIG='${mcpFile}'`);
      expect(paneCmd).toInclude(`'/bin/sh' '--mcp-config' '${mcpFile}'`);
      expect(paneCmd).not.toInclude("'--settings'");
    } finally {
      restore();
    }
  });
});

/**
 * Run a launch whose step-(7) subshells-dir mkdir MUST throw: the sabotage
 * lands between the meta record (which creates the dir) and the attach —
 * `newSubshell` swaps the subshells dir for a regular file, so
 * `mkdir(dir, {recursive:true})` fails with EEXIST. The throwing-mkdir twin
 * of a throwing pipe-pane.
 */
async function launchWithSabotagedSubshellsDir(
  ctx: CommandContext,
  cmd: LaunchCmd,
  dataDir: string,
): Promise<CommandResult> {
  const original = ctx.tmux.newSubshell.bind(ctx.tmux);
  (ctx.tmux as unknown as { newSubshell: (...a: unknown[]) => void }).newSubshell = (...a: unknown[]) => {
    (original as (...x: unknown[]) => void)(...a);
    rmSync(join(dataDir, "subshells"), { recursive: true, force: true });
    writeFileSync(join(dataDir, "subshells"), "sabotage");
  };
  try {
    return await execLaunch(ctx, cmd);
  } catch (err) {
    // The dispatcher's wrap, applied here (execLaunch PROPAGATES strict throws by design).
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/* ------------------------------------------------------------------ */

describe("exit watcher (report.ts) — one shared tick", () => {
  it("pane death ⇒ ONE exit event {exitCode, at}, supervision dropped, meta forgotten", async () => {
    const dataDir = await freshDataDir("watcher-death");
    const events: NodeEvent[] = [];
    let ticks = 0;
    const { ctx, calls } = makeCtx(
      dataDir,
      {
        listSubshellNames: () => (ticks++ === 0 ? [S1] : []), // alive on the first tick, gone after
        paneExitCode: () => 7,
      },
      events,
    );
    await recordMeta(ctx.meta, S1, "w-sock");
    expect(EXIT_WATCH_INTERVAL_MS).toBe(2_000); // production cadence (spec §7)
    startExitWatcher(ctx, S1, "w-sock", 20); // short interval, real timers (daemon-test polling style)
    expect(ctx.watchers.get(S1)?.socket).toBe("w-sock"); // supervised on the LAUNCH socket — no meta re-read
    await waitFor(() => events.length > 0, "exit event");
    expect(events[0]).toEqual({ type: "exit", subshellId: S1, exitCode: 7, at: new Date(FIXED_NOW).toISOString() });
    expect(ctx.watchers.size).toBe(0); // unregistered on fire
    await waitForAsync(async () => (await ctx.meta.get(S1)) === undefined, "meta forgotten");
    expect(calls.some((c) => c.method === "paneExitCode" && c.args[0] === "w-sock" && c.args[1] === S1)).toBe(true);
    await new Promise((r) => setTimeout(r, 80)); // an extra beat: never a second event
    expect(events.length).toBe(1);
    expect(ctx.watchTick).toBeUndefined(); // the shared loop stops when the last pane leaves
  });

  it("paneExitCode null (server gone before a status was read) ⇒ exitCode null rides the event", async () => {
    const dataDir = await freshDataDir("watcher-null");
    const events: NodeEvent[] = [];
    const { ctx, calls } = makeCtx(dataDir, { listSubshellNames: () => [], paneExitCode: () => null }, events);
    // NO meta record on purpose: the watcher must probe the socket it was
    // PASSED (launch's cmd.socket), not one recovered from the store.
    startExitWatcher(ctx, S1, "w2", 20);
    await waitFor(() => events.length > 0, "exit event");
    expect(events[0]).toMatchObject({ type: "exit", subshellId: S1, exitCode: null });
    expect(calls.find((c) => c.method === "paneExitCode")?.args).toEqual(["w2", S1]);
  });

  it("execKill and execTerminate STOP supervision — a dead-on-arrival pane never reports after a deliberate kill", async () => {
    const dataDir = await freshDataDir("watcher-kill");
    const events: NodeEvent[] = [];
    const { ctx } = makeCtx(
      dataDir,
      {
        listSubshellNames: () => [], // an UNSUPPRESSED watcher would fire on its very next tick
        paneExitCode: () => 9,
        killSubshell: () => {},
        run: () => ({ stdout: "", stderr: "" }),
      },
      events,
    );
    await recordMeta(ctx.meta, S1, "k-sock");
    startExitWatcher(ctx, S1, "k-sock", 20);
    expect(await dispatchCommand(ctx, { type: "kill", subshellId: S1 })).toEqual({ ok: true });
    expect(ctx.watchers.size).toBe(0);
    await recordMeta(ctx.meta, S2, "k-sock-2");
    startExitWatcher(ctx, S2, "k-sock-2", 20);
    expect(await dispatchCommand(ctx, { type: "terminate", subshellId: S2 })).toEqual({ ok: true });
    expect(ctx.watchers.size).toBe(0);
    expect(ctx.watchTick).toBeUndefined(); // the second stop drained the set and killed the loop
    await new Promise((r) => setTimeout(r, 120)); // several 20 ms beats
    // The real contract: a deliberate kill answers before the next tick can
    // fire, so NO `exit` event ever appears. (Probe COUNTS are not asserted —
    // a `list-sessions` tick landing in the tiny window between watcher start
    // and the executor's stop is a timing race on a loaded host, not a bug.)
    expect(events.filter((e) => e.type === "exit")).toEqual([]); // neither deliberate kill produced an exit event
  });

  it("batching: 3 supervised panes on ONE socket ⇒ one list-sessions per tick, zero per-pane has-sessions", async () => {
    const dataDir = await freshDataDir("watcher-batch");
    const events: NodeEvent[] = [];
    const { ctx, calls } = makeCtx(
      dataDir,
      { listSubshellNames: (socket) => (socket === "b-sock" ? [S1, S2, S3] : []) },
      events,
    );
    startExitWatcher(ctx, S1, "b-sock", 20);
    startExitWatcher(ctx, S2, "b-sock", 20);
    startExitWatcher(ctx, S3, "b-sock", 20);
    const lists = () => calls.filter((c) => c.method === "listSubshellNames");
    await waitFor(() => lists().length >= 2, "two batched ticks");
    const spawnCount = lists().length;
    // The claim under test: 3 panes × 2+ ticks is ≥6 spawns per-pane (the old
    // loop), but ONE spawn per socket per tick for the shared loop — and the
    // per-pane probe is gone entirely.
    expect(calls.filter((c) => c.method === "hasSubshell")).toHaveLength(0);
    expect(spawnCount).toBeLessThan(6);
    for (const l of lists()) expect(l.args).toEqual(["b-sock"]);
    expect(events).toEqual([]); // all three stayed alive
    for (const id of [S1, S2, S3]) stopWatcher(ctx, id);
    expect(ctx.watchTick).toBeUndefined();
  });

  it("grouping: 2 panes on sock-a + 1 on sock-b ⇒ one spawn PER SOCKET per tick — exactly 4 over 2 ticks, not 6", async () => {
    const dataDir = await freshDataDir("watcher-group");
    const { ctx, calls } = makeCtx(
      dataDir,
      { listSubshellNames: (socket) => (socket === "sock-a" ? [S1, S2] : [S3]) },
      [],
    );
    // 10 s interval: the timer never fires inside this test — the shared tick
    // runs twice, deterministically, so the SPAWN COUNT is exact.
    startExitWatcher(ctx, S1, "sock-a", 10_000);
    startExitWatcher(ctx, S2, "sock-a", 10_000);
    startExitWatcher(ctx, S3, "sock-b", 10_000);
    await runExitWatchTick(ctx);
    await runExitWatchTick(ctx);
    expect(calls.filter((c) => c.method === "hasSubshell")).toHaveLength(0);
    // The per-pane loop would have spawned 3 probes per tick (6 here); the
    // shared loop asks each socket ONCE per tick, grouped by socket.
    expect(calls.filter((c) => c.method === "listSubshellNames").map((c) => c.args[0])).toEqual([
      "sock-a",
      "sock-b",
      "sock-a",
      "sock-b",
    ]);
    for (const id of [S1, S2, S3]) stopWatcher(ctx, id);
    expect(ctx.watchTick).toBeUndefined();
  });

  it("two panes vanish on ONE tick ⇒ two independent exit events, each exactly once", async () => {
    const dataDir = await freshDataDir("watcher-double");
    const events: NodeEvent[] = [];
    let tick = 0;
    const { ctx } = makeCtx(
      dataDir,
      { listSubshellNames: () => (tick++ === 0 ? [S1, S2] : []), paneExitCode: (_s, id) => (id === S1 ? 3 : 4) },
      events,
    );
    startExitWatcher(ctx, S1, "d-sock", 10_000);
    startExitWatcher(ctx, S2, "d-sock", 10_000);
    await runExitWatchTick(ctx); // both alive
    await runExitWatchTick(ctx); // both gone in ONE batched answer
    expect(events).toEqual([
      { type: "exit", subshellId: S1, exitCode: 3, at: new Date(FIXED_NOW).toISOString() },
      { type: "exit", subshellId: S2, exitCode: 4, at: new Date(FIXED_NOW).toISOString() },
    ]);
    await runExitWatchTick(ctx); // supervision already drained — a third tick reports nothing
    expect(events.length).toBe(2);
    expect(ctx.watchTick).toBeUndefined(); // last pane left ⇒ shared loop stopped itself
  });

  /* Phase-3 debt (P2 review): a relaunch of the SAME id must survive a tick
     that snapshotted the old pane — the forget/drop tail of the exit path may
     only run for the registration the tick actually owned. */

  it("relaunch DURING the tick's gated forget ⇒ the newer registration survives: one exit event, meta kept, tails not swept, supervision kept", async () => {
    const dataDir = await freshDataDir("watcher-relaunch");
    const events: NodeEvent[] = [];
    const gated = new GateHeldMetaStore(dataDir);
    const { ctx } = makeCtx(
      dataDir,
      {
        listSubshellNames: (socket) => (socket === "w-sock" ? [] : [S1]), // old pane dead; relaunched pane alive
        paneExitCode: () => 5,
        newSubshell: () => {},
        pipePane: () => {},
      },
      events,
      gated,
    );
    await recordMeta(gated, S1, "w-sock");
    startExitWatcher(ctx, S1, "w-sock", 10_000); // the timer never fires; the tick runs manually and deterministically
    let tailStopped = false;

    const tick = runExitWatchTick(ctx);
    try {
      await gated.forgetEntered.promise; // the tick is suspended inside `await ctx.meta.forget(S1)`
      // Relaunch the same row through the REAL launch path: execLaunch writes
      // the fresh meta (step 4) before it re-arms the watcher (step 9).
      const relaunch = await dispatchCommand(
        ctx,
        launchCmd({ socket: "w-sock-2", subshellName: "relaunched", cols: undefined, rows: undefined }),
      );
      expect(relaunch).toEqual({ ok: true });
      // A tail of the relaunched pane attaches before the old forget returns.
      ctx.tails.set("sub-relaunch", { subshellId: S1, stop: () => (tailStopped = true) });
    } finally {
      gated.forgetGate.resolve();
    }
    await tick;

    // The old pane got its ONE death event; the relaunch keeps everything the
    // blind cleanup used to steal.
    expect(events).toEqual([{ type: "exit", subshellId: S1, exitCode: 5, at: new Date(FIXED_NOW).toISOString() }]);
    expect(ctx.watchers.has(S1)).toBe(true); // the NEWER registration still supervises
    expect(await ctx.meta.get(S1)).toMatchObject({ subshellId: S1, socket: "w-sock-2", name: "relaunched" }); // new record intact
    expect(tailStopped).toBe(false); // the death sweep must not stop a live relaunch's tail pumps
    await runExitWatchTick(ctx); // the new socket lists S1 alive — no second event ever
    expect(events.length).toBe(1);
    stopWatcher(ctx, S1);
    expect(ctx.watchTick).toBeUndefined();
  });

  it("execKill landing mid-tick (while the batched answer is being processed) ⇒ the deliberately killed id reports nothing", async () => {
    const dataDir = await freshDataDir("watcher-kill-midt");
    const events: NodeEvent[] = [];
    const gated = new GateHeldMetaStore(dataDir);
    const { ctx } = makeCtx(
      dataDir,
      {
        listSubshellNames: () => [], // BOTH panes are gone per the batch answer
        paneExitCode: () => 8,
        killSubshell: () => {},
        run: () => ({ stdout: "", stderr: "" }),
      },
      events,
      gated,
    );
    await recordMeta(gated, S1, "k-sock");
    await recordMeta(gated, S2, "k-sock");
    startExitWatcher(ctx, S1, "k-sock", 10_000);
    startExitWatcher(ctx, S2, "k-sock", 10_000);

    const tick = runExitWatchTick(ctx);
    try {
      await gated.forgetEntered.promise; // inside S1's forget — S2's branch has NOT run since the list-sessions answer
      expect(await dispatchCommand(ctx, { type: "kill", subshellId: S2 })).toEqual({ ok: true });
    } finally {
      gated.forgetGate.resolve();
    }
    await tick;

    // S1 died naturally (one event); S2 was deliberately killed after the
    // snapshot and must never arrive as a surprise death (re-check pin).
    expect(events).toEqual([{ type: "exit", subshellId: S1, exitCode: 8, at: new Date(FIXED_NOW).toISOString() }]);
    expect(ctx.watchers.size).toBe(0);
    expect(ctx.watchTick).toBeUndefined();
  });

  it("arm-once + tokens: re-registration mints a fresh token and replaces the entry, but never re-arms the shared interval", async () => {
    const dataDir = await freshDataDir("watcher-armonce");
    const { ctx } = makeCtx(dataDir, {}, []);
    const spy = spyOn(globalThis, "setInterval");
    try {
      const t1 = startExitWatcher(ctx, S1, "a-sock", 10_000); // arms the ONE loop
      startExitWatcher(ctx, S2, "a-sock", 10_000); // second pane rides it
      const t2 = startExitWatcher(ctx, S1, "a-sock-2", 30_000); // relaunch: new entry, same loop, intervalMs ignored
      expect(spy.mock.calls).toHaveLength(1); // arm-once (intervalMs applies to the FIRST call only)
      expect(typeof t1).toBe("symbol");
      expect(typeof t2).toBe("symbol");
      expect(t2).not.toBe(t1); // the re-registration is a NEW identity, not the old one
      expect(ctx.watchers.get(S1)?.token).toBe(t2);
      expect(ctx.watchers.get(S1)?.socket).toBe("a-sock-2"); // supervised on the RELAUNCH socket
      expect(ctx.watchers.size).toBe(2);
    } finally {
      spy.mockRestore();
      for (const id of [...ctx.watchers.keys()]) stopWatcher(ctx, id);
      expect(ctx.watchTick).toBeUndefined();
    }
  });

  it("regression: plain natural death with a live tail ⇒ exactly ONE exit event, meta forgotten, tail stopped, loop drains when empty", async () => {
    const dataDir = await freshDataDir("watcher-natural");
    const events: NodeEvent[] = [];
    const { ctx } = makeCtx(dataDir, { listSubshellNames: () => [], paneExitCode: () => 6 }, events);
    await recordMeta(ctx.meta, S1, "n-sock");
    startExitWatcher(ctx, S1, "n-sock", 10_000);
    let stops = 0;
    ctx.tails.set("sub-n", { subshellId: S1, stop: () => (stops += 1) });

    await runExitWatchTick(ctx);

    expect(events).toEqual([{ type: "exit", subshellId: S1, exitCode: 6, at: new Date(FIXED_NOW).toISOString() }]);
    expect(stops).toBe(1); // the owned registration's death STILL sweeps its tails
    expect(ctx.tails.size).toBe(0);
    expect(await ctx.meta.get(S1)).toBeUndefined();
    expect(ctx.watchers.size).toBe(0);
    expect(ctx.watchTick).toBeUndefined(); // the shared loop stops when the set empties
  });
});

/* ------------------------------------------------------------------ */

/**
 * Design 2026-09-02 §1: a single failed probe must not report a LIVE pane
 * dead. ok:false ticks count toward a consecutive-unreachable threshold
 * (NODE_EXIT_UNREACHABLE_TICKS); ok:true stays authoritative. Each test also
 * scripts the legacy `listSubshellNames` switch with the `[]`-via-error answer
 * the old swallow-everything probe produced — the RED marker: against the old
 * tick those fixtures fire an exit event on the FIRST blip.
 */
describe("exit watcher — unreachable threshold (design §1)", () => {
  it("blip: ok:false then ok:true-with-pane ⇒ ZERO exit events, counter reset by the ok tick", async () => {
    const dataDir = await freshDataDir("watcher-blip");
    const events: NodeEvent[] = [];
    let tick = 0;
    const { ctx, calls } = makeCtx(
      dataDir,
      {
        listSubshellsChecked: () =>
          tick++ === 0
            ? { ok: false, detail: "error connecting to /tmp/tmux-1000/b-sock (No such file or directory)" }
            : { ok: true, names: [S1] }, // probe recovered; the pane is RIGHT THERE
        listSubshellNames: () => [], // what the old probe returned for a blip — and what the old tick treated as death
        paneExitCode: () => 42,
      },
      events,
    );
    await recordMeta(ctx.meta, S1, "b-sock");
    startExitWatcher(ctx, S1, "b-sock", 10_000); // timer never fires; ticks run manually

    await runExitWatchTick(ctx); // tick 1: blip — below threshold, stay watched
    expect(events).toEqual([]);
    expect(ctx.watchers.get(S1)?.unreachable).toBe(1);

    await runExitWatchTick(ctx); // tick 2: alive on an authoritative answer
    expect(events).toEqual([]);
    expect(ctx.watchers.get(S1)?.unreachable).toBe(0); // streak broken
    expect(calls.some((c) => c.method === "paneExitCode")).toBe(false); // the death path was never entered
    expect(await ctx.meta.get(S1)).toBeDefined(); // meta untouched

    stopWatcher(ctx, S1);
    expect(ctx.watchTick).toBeUndefined();
  });

  it("sustained: two consecutive ok:false ticks ⇒ EXACTLY ONE exit {exitCode: null}, forgotten + tails dropped", async () => {
    const dataDir = await freshDataDir("watcher-sustained");
    const events: NodeEvent[] = [];
    const { ctx } = makeCtx(
      dataDir,
      {
        listSubshellsChecked: () => ({ ok: false, detail: "no server running on /tmp/tmux-1000/u-sock" }),
        listSubshellNames: () => [], // old-probe answer: the old tick reported death on tick 1 (RED marker)
        paneExitCode: () => null, // unreachable server ⇒ no status to read (the shape a dead socket always gave)
      },
      events,
    );
    await recordMeta(ctx.meta, S1, "u-sock");
    startExitWatcher(ctx, S1, "u-sock", 10_000);
    let stops = 0;
    ctx.tails.set("sub-u", { subshellId: S1, stop: () => (stops += 1) });

    await runExitWatchTick(ctx); // first unreachable tick — silent, below threshold
    expect(events).toEqual([]);
    expect(ctx.watchers.get(S1)?.unreachable).toBe(1);

    await runExitWatchTick(ctx); // second consecutive ⇒ at threshold: the SAME death sequence as confirmed
    expect(events).toEqual([{ type: "exit", subshellId: S1, exitCode: null, at: new Date(FIXED_NOW).toISOString() }]);
    expect(ctx.watchers.size).toBe(0); // registration dropped — at most one event
    expect(stops).toBe(1); // the escalation runs the tail sweep too
    expect(await ctx.meta.get(S1)).toBeUndefined(); // and the forget
    expect(ctx.watchTick).toBeUndefined();
  });

  it("confirmed death unchanged: ok:true with the pane absent ⇒ immediate exit on the FIRST tick", async () => {
    const dataDir = await freshDataDir("watcher-confirmed");
    const events: NodeEvent[] = [];
    const { ctx } = makeCtx(
      dataDir,
      {
        listSubshellsChecked: () => ({ ok: true, names: [] }), // socket ANSWERED; the pane is gone — authoritative
        paneExitCode: () => 6,
      },
      events,
    );
    await recordMeta(ctx.meta, S1, "c-sock");
    startExitWatcher(ctx, S1, "c-sock", 10_000);
    await runExitWatchTick(ctx);
    expect(events).toEqual([{ type: "exit", subshellId: S1, exitCode: 6, at: new Date(FIXED_NOW).toISOString() }]);
    expect(ctx.watchers.size).toBe(0);
    expect(await ctx.meta.get(S1)).toBeUndefined();
    expect(ctx.watchTick).toBeUndefined();
  });

  it("relaunch resets the budget: blip (1) ⇒ same-id re-registration (fresh 0) ⇒ blip again ⇒ still zero exits", async () => {
    const dataDir = await freshDataDir("watcher-relaunch-budget");
    const events: NodeEvent[] = [];
    const { ctx } = makeCtx(
      dataDir,
      {
        listSubshellsChecked: () => ({ ok: false, detail: "no server running" }),
        listSubshellNames: () => [], // old-probe answer — RED marker: the old tick died on tick 1
        paneExitCode: () => null,
      },
      events,
    );
    startExitWatcher(ctx, S1, "r-sock", 10_000);
    await runExitWatchTick(ctx);
    expect(events).toEqual([]);
    expect(ctx.watchers.get(S1)?.unreachable).toBe(1);

    const t2 = startExitWatcher(ctx, S1, "r-sock", 10_000); // relaunch on the same row ⇒ new registration
    expect(ctx.watchers.get(S1)?.token).toBe(t2);
    expect(ctx.watchers.get(S1)?.unreachable).toBe(0); // a replaced registration starts fresh — budget reset

    await runExitWatchTick(ctx); // one unreachable tick on the NEW reg: 0→1, still below threshold
    expect(events).toEqual([]);
    expect(ctx.watchers.get(S1)?.unreachable).toBe(1);

    stopWatcher(ctx, S1);
    expect(ctx.watchTick).toBeUndefined();
  });
});

/* ------------------------------------------------------------------ */

describe("buildSubshellsReport (spec §3.3)", () => {
  it("one row per recorded meta: alive ⇒ null exit, dead ⇒ paneExitCode", async () => {
    const dataDir = await freshDataDir("subshells-report");
    const { ctx } = makeCtx(dataDir, { hasSubshell: (_s, id) => id === S1, paneExitCode: () => 2 }, []);
    await recordMeta(ctx.meta, S1, "sock-a");
    await recordMeta(ctx.meta, S2, "sock-b");
    const report = await buildSubshellsReport(ctx);
    expect(report).toEqual({
      type: "subshells_report",
      subshells: [
        { subshellId: S1, alive: true, exitCode: null },
        { subshellId: S2, alive: false, exitCode: 2 },
      ],
    });
  });

  it("no metas ⇒ an empty subshells list (still a valid event)", async () => {
    const dataDir = await freshDataDir("subshells-report-empty");
    const { ctx } = makeCtx(dataDir, {}, []);
    expect(await buildSubshellsReport(ctx)).toEqual({ type: "subshells_report", subshells: [] });
  });
});

/* ------------------------------------------------------------------ */
/* Task 7 (spec §6 "The node holds nothing"): the node owns NO plugin   */
/* concept. A launch needs no plugins directory — the argv and the     */
/* resolve rule ARE the launch, and the only node-side facts left are  */
/* the directory allowlist and the binary lookup.                      */
/* ------------------------------------------------------------------ */

describe("execLaunch on a node with no plugins (inversion §6)", () => {
  it("a launch succeeds on a node with no plugins directory at all", async () => {
    // NO installEmbedded: this data dir has never seen a plugins directory.
    const dir = join(base, "no-plugins-dir");
    mkdirSync(dir, { recursive: true });
    let paneCmd = "";
    const { ctx } = makeCtx(
      dir,
      { newSubshell: (_s, _i, _c, cmd) => (paneCmd = cmd), pipePane: () => {}, resizeWindow: () => {} },
      [],
    );
    expect(existsSync(join(dir, "plugins"))).toBe(false);
    const result = await dispatchCommand(
      ctx,
      launchCmd({
        argv: [HARNESS_BINARY_PLACEHOLDER, "--flag"],
        resolve: { binaryName: "pi", envOverride: "CLAUDE_PATH" },
      }),
    );
    expect(result).toEqual({ ok: true });
    expect(paneCmd).toInclude(`'/bin/sh' '--flag'`);
    expect(existsSync(join(dir, "plugins"))).toBe(false); // the launch created nothing
    stopWatcher(ctx, S1);
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
    const dataDir = await freshDataDir("smoke");
    const workDir = join(base, "smoke-work");
    mkdirSync(workDir, { recursive: true });
    const stub = join(base, "stub-harness");
    // argv-agnostic stub: claude's --settings/--name tokens are simply ignored.
    writeFileSync(stub, "#!/bin/sh\necho hi\nexec sleep 30\n", { mode: 0o755 });
    process.env.CLAUDE_PATH = stub;

    const socket = `subshell-test-${crypto.randomUUID().slice(0, 8)}`;
    const subshellId = crypto.randomUUID();
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
      meta: new SubshellMetaStore(dataDir),
      nowMs: () => Date.now(),
      ws: { send: (ev) => events.push(ev) },
      watchers: new Map(),
      tails: new Map(),
      uploads: new Map(),
    };
    try {
      const result = await dispatchCommand(
        ctx,
        launchCmd({ subshellId, socket, cwd: workDir, cols: undefined, rows: undefined }),
      );
      expect(result).toEqual({ ok: true });
      expect(runner.hasSubshell(socket, subshellId)).toBe(true); // the pane is LIVE through real tmux
      runner.killSubshell(socket, subshellId); // deliberate death — the watcher's job is to notice it
      await waitFor(() => events.some((e) => e.type === "exit"), "exit event from the real-death watcher", 15_000);
      const exit = events.find((e) => e.type === "exit") as Extract<NodeEvent, { type: "exit" }>;
      expect(exit.subshellId).toBe(subshellId);
      expect(Number.isNaN(Date.parse(exit.at))).toBe(false);
      await waitForAsync(
        async () => (await ctx.meta.get(subshellId)) === undefined,
        "meta forgotten after exit",
        15_000,
      );
    } finally {
      // Always reap: killSubshell, then the WHOLE server on this socket, then the
      // socket file — a failed assertion must not leak a tmux daemon.
      runner.killSubshell(socket, subshellId);
      spawnSync(["tmux", "-L", socket, "kill-server"], { stdout: "ignore", stderr: "ignore" });
      runner.cleanSocket(socket);
      for (const id of [...ctx.watchers.keys()]) stopWatcher(ctx, id); // drains the set + stops the shared loop
    }
  },
  30_000,
);
