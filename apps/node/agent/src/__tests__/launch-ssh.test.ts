import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSshConfigPath } from "@internal/pane-runtime";
import { HARNESS_BINARY_PLACEHOLDER, type NodeCommandBody, type NodeEvent } from "@internal/subshell-protocol";
import type { CommandContext } from "../commands/context.js";
import { dispatchCommand } from "../commands/index.js";
import { runExitWatchTick, startExitWatcher, stopWatcher } from "../commands/report.js";
import type { NodeConfig } from "../config.js";
import { SubshellMetaStore } from "../subshell-meta.js";

/**
 * Task 5 (spec 2026-10-07 decision 4): the ssh pane's rendered config, landed
 * by the SPAWNING machine at the byte-derived path, and swept when the pane
 * dies.
 *
 * Two halves, one contract:
 * - `execLaunch` writes `cmd.ssh` BEFORE meta/pane, at
 *   `buildSshConfigPath(dataDir, id)` — the plane names nothing: a frame whose
 *   `configPath` is not byte-equal to this machine's own derivation is
 *   refused. Modes mirror the MCP block exactly (dir 0700, file 0600,
 *   `enforceMode` on both).
 * - the exit watcher (report.ts) removes the per-pane ssh DIR when — and only
 *   when — the dead pane's recorded meta names harness `ssh`, best-effort and
 *   inside the same relaunch-ownership guard that protects the tails.
 *
 * Same fake-tmux discipline as commands-launch.test.ts: a plain-object double
 * records ordered calls, unstubbed methods throw.
 */

const S1 = "11111111-1111-4111-8111-111111111111";
const FIXED_NOW = 1_700_000_000_000;
const SSH_CONTENT = "Host *\n    StrictHostKeyChecking yes\n";

let base: string;
let claudePathOriginal: string | undefined;

beforeAll(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "subshell-launch-ssh-")));
});

beforeEach(() => {
  claudePathOriginal = process.env.CLAUDE_PATH;
  process.env.CLAUDE_PATH = "/bin/sh";
});

afterAll(() => {
  if (claudePathOriginal === undefined) delete process.env.CLAUDE_PATH;
  else process.env.CLAUDE_PATH = claudePathOriginal;
  rmSync(base, { recursive: true, force: true });
});

async function freshDataDir(tag: string): Promise<string> {
  const dir = join(base, tag);
  mkdirSync(dir, { recursive: true });
  return dir;
}

type ProbeAnswer = { ok: true; names: string[] } | { ok: false; detail: string };

interface Spec {
  newSubshell?: (socket: string, id: string, cwd: string, cmd: string, exitHook?: string) => void;
  pipePane?: (socket: string, id: string, out: string) => void;
  resizeWindow?: (socket: string, id: string, cols: number, rows: number) => void;
  listSubshellsChecked?: (socket: string) => ProbeAnswer | Promise<ProbeAnswer>;
  paneExitCode?: (socket: string, id: string) => number | null;
  killSubshell?: (socket: string, id: string) => void;
}

/** A one-shot promise plus its resolver (the gated-forget fixture drives these). */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

/**
 * Models a tick stuck INSIDE `await ctx.meta.forget(...)` (the relaunch
 * interleaving from commands-launch.test.ts, kept here because the ssh sweep
 * must respect the SAME ownership guard).
 */
class GateHeldMetaStore extends SubshellMetaStore {
  readonly forgetEntered = deferred();
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
  const raw = {
    newSubshell: method("newSubshell"),
    pipePane: method("pipePane"),
    resizeWindow: method("resizeWindow"),
    listSubshellsChecked: (socket: string): ProbeAnswer | Promise<ProbeAnswer> => {
      calls.push({ method: "listSubshellsChecked", args: [socket] });
      const scripted = spec.listSubshellsChecked;
      if (scripted) return scripted(socket);
      throw new Error("fake tmux: unstubbed listSubshellsChecked");
    },
    paneExitCode: method("paneExitCode"),
    killSubshell: method("killSubshell"),
  };
  const config: NodeConfig = {
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
    runtime: null,
    requestRestart: () => {},
  };
  return { ctx, calls };
}

type LaunchCmd = Extract<NodeCommandBody, { type: "launch" }>;

/** An ssh-harness launch frame: placeholder argv resolved via CLAUDE_PATH like every launch fixture here. */
function sshLaunchCmd(over: Partial<LaunchCmd> = {}): LaunchCmd {
  return {
    type: "launch",
    subshellId: S1,
    socket: "subshell-ssh-test",
    cwd: base,
    harnessId: "ssh",
    preset: { name: "p", env: {}, flags: [], settings: null, configIsolation: false },
    subshellEnv: { SUBSHELL_API_KEY: "k" },
    subshellName: "s1",
    argv: [HARNESS_BINARY_PLACEHOLDER],
    resolve: { binaryName: "claude", envOverride: "CLAUDE_PATH" },
    ...over,
  };
}

function spawnAndPipeStub() {
  return { newSubshell: () => {}, pipePane: () => {} };
}

/* ------------------------------------------------------------------ */
/* execLaunch: the config write (derived path, byte-equality, modes)   */
/* ------------------------------------------------------------------ */

describe("execLaunch ssh config write (spec 2026-10-07 decision 4)", () => {
  it("well-formed block: file at the derived path, 0600 in a 0700 dir, content byte-equal", async () => {
    const dataDir = await freshDataDir("write");
    const { ctx, calls } = makeCtx(dataDir, spawnAndPipeStub(), []);
    const configPath = buildSshConfigPath(dataDir, S1);
    const result = await dispatchCommand(ctx, sshLaunchCmd({ ssh: { configPath, fileContent: SSH_CONTENT } }));
    expect(result).toEqual({ ok: true });
    expect(await Bun.file(configPath).text()).toBe(SSH_CONTENT);
    expect(statSync(configPath).mode & 0o777).toBe(0o600);
    const parent = configPath.slice(0, configPath.lastIndexOf("/"));
    expect(statSync(parent).mode & 0o777).toBe(0o700);
    // The write precedes nothing observable in tmux ordering terms, but the
    // pane still spawns exactly once and the file survives the launch.
    expect(calls.map((c) => c.method)).toEqual(["newSubshell", "pipePane"]);
    stopWatcher(ctx, S1);
  });

  it("the write is visible at newSubshell time (config BEFORE spawn)", async () => {
    const dataDir = await freshDataDir("write-before-spawn");
    const configPath = buildSshConfigPath(dataDir, S1);
    let seenAtSpawn = false;
    const { ctx } = makeCtx(
      dataDir,
      {
        ...spawnAndPipeStub(),
        newSubshell: () => {
          seenAtSpawn = existsSync(configPath);
        },
      },
      [],
    );
    const result = await dispatchCommand(ctx, sshLaunchCmd({ ssh: { configPath, fileContent: SSH_CONTENT } }));
    expect(result).toEqual({ ok: true });
    expect(seenAtSpawn).toBe(true);
    stopWatcher(ctx, S1);
  });

  it("configPath not byte-equal to the derivation: refused, no file, no dir, no pane, no meta", async () => {
    const dataDir = await freshDataDir("mismatch");
    const { ctx, calls } = makeCtx(dataDir, spawnAndPipeStub(), []);
    // A plane naming anywhere else — a sibling path in the SAME derived shape
    // included — is refused: the path is this machine's derivation alone.
    const wrong = buildSshConfigPath(dataDir, `${S1}-elsewhere`);
    const result = await dispatchCommand(ctx, sshLaunchCmd({ ssh: { configPath: wrong, fileContent: SSH_CONTENT } }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toInclude("ssh config path refused");
    expect(calls).toEqual([]); // refused before the spawn
    expect(existsSync(join(dataDir, "ssh"))).toBe(false); // not even a dir
    expect(await ctx.meta.get(S1)).toBeUndefined();
  });

  it("absolute-path config outside dataDir: refused by the same gate (byte-equality is the first door)", async () => {
    const dataDir = await freshDataDir("outside");
    const { ctx, calls } = makeCtx(dataDir, spawnAndPipeStub(), []);
    const result = await dispatchCommand(
      ctx,
      sshLaunchCmd({ ssh: { configPath: "/etc/ssh/subshell-config", fileContent: SSH_CONTENT } }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toInclude("ssh config path refused");
    expect(calls).toEqual([]);
    expect(existsSync(join(dataDir, "ssh"))).toBe(false);
  });

  it("no ssh block on the frame: no dir is created for an ordinary pane", async () => {
    const dataDir = await freshDataDir("absent");
    const { ctx } = makeCtx(dataDir, spawnAndPipeStub(), []);
    const result = await dispatchCommand(ctx, sshLaunchCmd());
    expect(result).toEqual({ ok: true });
    expect(existsSync(join(dataDir, "ssh"))).toBe(false);
    stopWatcher(ctx, S1);
  });
});

/* ------------------------------------------------------------------ */
/* Exit watcher: the death sweep, gated on meta harnessId === "ssh"    */
/* ------------------------------------------------------------------ */

/** Seed meta with an explicit harnessId (the commands-launch twin hardcodes claude-code). */
async function recordMetaAs(
  store: SubshellMetaStore,
  subshellId: string,
  socket: string,
  harnessId: string,
): Promise<void> {
  await store.record({
    subshellId,
    cwd: base,
    socket,
    harnessId,
    name: "m",
    startedAt: "2026-10-07T00:00:00.000Z",
  });
}

/** Create a realistic per-pane ssh dir + config under dataDir. */
function seedSshConfig(dataDir: string, subshellId: string): { dir: string; file: string } {
  const file = buildSshConfigPath(dataDir, subshellId);
  const dir = file.slice(0, file.lastIndexOf("/"));
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, SSH_CONTENT, { mode: 0o600 });
  return { dir, file };
}

function deadSocketSpec(): Spec {
  return { listSubshellsChecked: () => ({ ok: true, names: [] }), paneExitCode: () => 0, killSubshell: () => {} };
}

describe("exit watcher ssh config sweep (report.ts, decision 4)", () => {
  it("ssh pane dies: the per-pane ssh dir is gone, best-effort, and the death still reports", async () => {
    const dataDir = await freshDataDir("sweep-ssh");
    const events: NodeEvent[] = [];
    const { ctx } = makeCtx(dataDir, deadSocketSpec(), events);
    await recordMetaAs(ctx.meta, S1, "s-sock", "ssh");
    const { dir, file } = seedSshConfig(dataDir, S1);
    startExitWatcher(ctx, S1, "s-sock", 10_000); // the timer never fires; the tick runs manually

    await runExitWatchTick(ctx);

    expect(events).toEqual([{ type: "exit", subshellId: S1, exitCode: 0, at: new Date(FIXED_NOW).toISOString() }]);
    expect(existsSync(file)).toBe(false);
    expect(existsSync(dir)).toBe(false); // the DIR goes, not just the file
    expect(await ctx.meta.get(S1)).toBeUndefined();
    expect(ctx.watchTick).toBeUndefined();
  });

  it("non-ssh pane dies: a same-named dir on disk is left untouched", async () => {
    const dataDir = await freshDataDir("sweep-claude");
    const events: NodeEvent[] = [];
    const { ctx } = makeCtx(dataDir, deadSocketSpec(), events);
    await recordMetaAs(ctx.meta, S1, "s-sock", "claude-code");
    const { dir, file } = seedSshConfig(dataDir, S1);
    startExitWatcher(ctx, S1, "s-sock", 10_000);

    await runExitWatchTick(ctx);

    expect(events.length).toBe(1); // the death still reports
    expect(existsSync(file)).toBe(true);
    expect(existsSync(dir)).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  it("pane with NO meta record: nothing is removed (the kind fact is the gate, absence never asserts)", async () => {
    const dataDir = await freshDataDir("sweep-nometa");
    const events: NodeEvent[] = [];
    const { ctx } = makeCtx(dataDir, deadSocketSpec(), events);
    const { dir, file } = seedSshConfig(dataDir, S1);
    startExitWatcher(ctx, S1, "s-sock", 10_000);

    await runExitWatchTick(ctx);

    expect(events.length).toBe(1);
    expect(existsSync(file)).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  it("relaunch DURING the forget: the stale tick never sweeps the live relaunch's config", async () => {
    const dataDir = await freshDataDir("sweep-relaunch");
    const events: NodeEvent[] = [];
    const gated = new GateHeldMetaStore(dataDir);
    const { ctx } = makeCtx(dataDir, { ...deadSocketSpec(), ...spawnAndPipeStub() }, events, gated);
    await recordMetaAs(gated, S1, "s-sock", "ssh");
    const configPath = buildSshConfigPath(dataDir, S1);
    const dir = configPath.slice(0, configPath.lastIndexOf("/"));
    mkdirSync(dir, { recursive: true });
    writeFileSync(configPath, "OLD", { mode: 0o600 });
    startExitWatcher(ctx, S1, "s-sock", 10_000);

    const tick = runExitWatchTick(ctx);
    try {
      await gated.forgetEntered.promise; // the tick is suspended inside `await ctx.meta.forget(S1)`
      // Relaunch through the REAL launch path: it re-records meta and rewrites
      // the config while the old tick is still in flight.
      const relaunch = await dispatchCommand(
        ctx,
        sshLaunchCmd({ socket: "s-sock-2", ssh: { configPath, fileContent: SSH_CONTENT } }),
      );
      expect(relaunch).toEqual({ ok: true });
    } finally {
      gated.forgetGate.resolve();
    }
    await tick;

    expect(events).toEqual([{ type: "exit", subshellId: S1, exitCode: 0, at: new Date(FIXED_NOW).toISOString() }]);
    // The relaunched pane is live and its config is INTACT: the sweep ran
    // inside the ownership guard, not after the forget blindly.
    expect(await Bun.file(configPath).text()).toBe(SSH_CONTENT);
    expect(ctx.watchers.has(S1)).toBe(true);
    stopWatcher(ctx, S1);
  });
});
