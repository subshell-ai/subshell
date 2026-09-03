import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tmuxSocketFor } from "@internal/harnesses";
import {
  NODE_MAX_FRAME_BYTES,
  type NodeEvent,
  parseNodeCaptureResult,
  parseNodeProbeEntries,
  parseNodeProbeResume,
  parseNodeStatDirResult,
} from "@internal/subshell-protocol";
import { PROBE_RESULT_BUDGET_BYTES } from "../commands/basics.js";
import type { CommandContext } from "../commands/context.js";
import { dispatchCommand } from "../commands/index.js";
import type { AgentConfig } from "../config.js";
import { SubshellMetaStore } from "../subshell-meta.js";

/**
 * The phase-2 command executors under a scripted fake tmux (spec §7). One real
 * `SubshellMetaStore` on a temp dataDir (the preload already moved
 * SUBSHELL_CONFIG_HOME), a fake `ws` collecting events, and a plain-object
 * TmuxRunner double — every emitted result `data` is additionally run through
 * the Task-1 contract validators (`parse*`) so the agent side can never drift
 * from the backend's expectations.
 */

const S1 = "11111111-1111-4111-8111-111111111111";
const S2 = "22222222-2222-4222-8222-222222222222";

let base: string;
let dataDir: string;
let workDir: string; // a tracked subshell's recorded launch cwd
let outside: string; // under no root

beforeAll(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "subshell-cmds-")));
  dataDir = join(base, "data");
  workDir = join(base, "work");
  outside = join(base, "outside");
  for (const d of [dataDir, workDir, outside]) mkdirSync(d, { recursive: true });
});

afterAll(() => rmSync(base, { recursive: true, force: true }));

/** Method → recorded argv, collected by the double. */
interface FakeTmux {
  calls: Array<{ method: string; args: unknown[] }>;
  raw: Record<string, (...args: unknown[]) => unknown>;
}

interface Spec {
  run?: (args: string[]) => { stdout: string; stderr: string };
  hasSubshell?: (socket: string, id: string) => boolean;
  killSubshell?: (socket: string, id: string) => void;
  sendInput?: (socket: string, id: string, input: string) => void;
  resizeWindow?: (socket: string, id: string, cols: number, rows: number) => void;
  capturePane?: (socket: string, id: string) => string;
  paneTitle?: (socket: string, id: string) => { title: string; command: string } | null;
  paneExitCode?: (socket: string, id: string) => number | null;
}

/** Build a CommandContext over a scripted double; unstubbed methods throw (a test calling one is a bug). */
function makeCtx(spec: Spec, events: NodeEvent[]): { ctx: CommandContext; tmux: FakeTmux } {
  const calls: FakeTmux["calls"] = [];
  const method = (name: keyof Spec) => {
    const impl = spec[name];
    return (...args: unknown[]) => {
      calls.push({ method: name, args });
      if (!impl) throw new Error(`fake tmux: unstubbed call ${String(name)}(${JSON.stringify(args)})`);
      return (impl as (...a: unknown[]) => unknown)(...args);
    };
  };
  const raw = {
    run: method("run"),
    hasSubshell: method("hasSubshell"),
    killSubshell: method("killSubshell"),
    sendInput: method("sendInput"),
    resizeWindow: method("resizeWindow"),
    capturePane: method("capturePane"),
    paneTitle: method("paneTitle"),
    paneExitCode: method("paneExitCode"),
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
    meta: new SubshellMetaStore(dataDir),
    nowMs: () => 1_700_000_000_000,
    ws: { send: (ev) => events.push(ev) },
    watchers: new Map(),
    tails: new Map(),
    uploads: new Map(),
  };
  return { ctx, tmux: { calls, raw } };
}

function argsOf(tmux: FakeTmux, method: string): unknown[][] {
  return tmux.calls.filter((c) => c.method === method).map((c) => c.args);
}

describe("command executors (spec §7)", () => {
  it("ping answers pong", async () => {
    const { ctx } = makeCtx({}, []);
    expect(await dispatchCommand(ctx, { type: "ping" })).toEqual({ ok: true, data: "pong" });
  });

  it("inventory sends the EVENT first, then answers ok (verbatim phase-1 move)", async () => {
    const events: NodeEvent[] = [];
    const { ctx } = makeCtx({}, events);
    const result = await dispatchCommand(ctx, { type: "inventory" });
    expect(result).toEqual({ ok: true });
    expect(events.map((e) => e.type)).toEqual(["inventory"]);
  });

  it("terminate: strict kill-session — recorded socket wins, tmuxSocketFor is the orphan fallback", async () => {
    const { ctx, tmux } = makeCtx({ run: () => ({ stdout: "", stderr: "" }) }, []);
    await ctx.meta.record({
      subshellId: S1,
      cwd: workDir,
      socket: "recorded-sock",
      harnessId: "pi",
      name: "s1",
      startedAt: "2026-09-01T00:00:00.000Z",
    });
    expect(await dispatchCommand(ctx, { type: "terminate", subshellId: S1 })).toEqual({ ok: true });
    expect(argsOf(tmux, "run")).toEqual([[["-L", "recorded-sock", "kill-session", "-t", S1], {}]]);

    expect(await dispatchCommand(ctx, { type: "terminate", subshellId: S2 })).toEqual({ ok: true });
    expect(argsOf(tmux, "run")[1]?.[0]).toEqual(["-L", tmuxSocketFor(S2), "kill-session", "-t", S2]);
  });

  it("terminate surfaces the tmux throw as ok:false", async () => {
    const { ctx } = makeCtx(
      {
        run: () => {
          throw new Error("no server running");
        },
      },
      [],
    );
    expect(await dispatchCommand(ctx, { type: "terminate", subshellId: S1 })).toEqual({
      ok: false,
      error: "no server running",
    });
  });

  it("kill swallows the tmux throw (already-gone is success)", async () => {
    const { ctx, tmux } = makeCtx(
      {
        killSubshell: () => {
          throw new Error("no server running");
        },
      },
      [],
    );
    expect(await dispatchCommand(ctx, { type: "kill", subshellId: S2 })).toEqual({ ok: true });
    expect(argsOf(tmux, "killSubshell")).toEqual([[tmuxSocketFor(S2), S2]]);
  });

  it("input/resize delegate to sendInput/resizeWindow", async () => {
    const { ctx, tmux } = makeCtx({ sendInput: () => {}, resizeWindow: () => {} }, []);
    expect(await dispatchCommand(ctx, { type: "input", subshellId: S2, data: "hello\r" })).toEqual({ ok: true });
    expect(await dispatchCommand(ctx, { type: "resize", subshellId: S2, cols: 132, rows: 43 })).toEqual({ ok: true });
    expect(argsOf(tmux, "sendInput")).toEqual([[tmuxSocketFor(S2), S2, "hello\r"]]);
    expect(argsOf(tmux, "resizeWindow")).toEqual([[tmuxSocketFor(S2), S2, 132, 43]]);
  });

  it("capture answers the bare screen string", async () => {
    const { ctx } = makeCtx({ capturePane: () => "screen" }, []);
    const result = await dispatchCommand(ctx, { type: "capture", subshellId: S1 });
    expect(result).toEqual({ ok: true, data: "screen" });
    expect(parseNodeCaptureResult(result.ok ? result.data : null)).toBe("screen");
  });

  it("capture forwards the optional scrollback budget to capturePane (attach replay)", async () => {
    const { ctx, tmux } = makeCtx({ capturePane: () => "screen" }, []);
    expect(await dispatchCommand(ctx, { type: "capture", subshellId: S1, lines: 100 })).toEqual({
      ok: true,
      data: "screen",
    });
    // S1's socket comes from the recorded meta ("recorded-sock", seeded by
    // the terminate test on the same dataDir) — the resolveSocket precedence.
    expect(argsOf(tmux, "capturePane")).toEqual([["recorded-sock", S1, 100]]);
  });

  it("probe: live row carries title/command/capture; dead row carries the exit code and NO capture", async () => {
    const { ctx } = makeCtx(
      {
        hasSubshell: (_s, id) => id === S1,
        paneTitle: () => ({ title: "Doing", command: "node" }),
        capturePane: () => "CAP",
        paneExitCode: () => 3,
      },
      [],
    );
    const result = await dispatchCommand(ctx, { type: "probe", subshellIds: [S1, S2] });
    expect(result.ok).toBe(true);
    const entries = parseNodeProbeEntries(result.ok ? result.data : null);
    expect(entries).not.toBeNull();
    expect(entries?.[0]).toEqual({
      subshellId: S1,
      alive: true,
      exitCode: null,
      title: "Doing",
      command: "node",
      capture: "CAP",
    });
    expect(entries?.[1]).toEqual({ subshellId: S2, alive: false, exitCode: 3 });
    expect(entries?.[1]).not.toHaveProperty("capture");
  });

  it("probe: capture-stuffing past the budget re-BUILDS every entry without captures (one rebuild)", async () => {
    expect(PROBE_RESULT_BUDGET_BYTES).toBe(NODE_MAX_FRAME_BYTES - 64 * 1024);
    const ids = Array.from({ length: 200 }, (_, i) => i.toString(16).padStart(4, "0")); // 200 × 8 KiB ≈ 1.6 MiB
    const { ctx } = makeCtx(
      {
        hasSubshell: () => true,
        paneTitle: () => ({ title: "t", command: "c" }),
        capturePane: () => "x".repeat(8 * 1024),
      },
      [],
    );
    const result = await dispatchCommand(ctx, { type: "probe", subshellIds: ids });
    expect(result.ok).toBe(true);
    const data = result.ok ? result.data : null;
    expect(Buffer.byteLength(JSON.stringify(data))).toBeLessThanOrEqual(PROBE_RESULT_BUDGET_BYTES);
    const entries = parseNodeProbeEntries(data);
    expect(entries?.length).toBe(200);
    expect(entries?.every((e) => e.alive)).toBe(true);
    // `not.toHaveProperty` (not `capture === undefined`): the rebuild must DROP
    // the key entirely — a stored `capture: undefined` would round-trip as a
    // phantom field through JSON.parse on the backend side.
    for (const e of entries ?? []) expect(e).not.toHaveProperty("capture");
  });

  it("stat_dir: realpath + isDirectory; ENOENT / ENOTDIR answer ok:false", async () => {
    const { ctx } = makeCtx({}, []);
    const hit = await dispatchCommand(ctx, { type: "stat_dir", path: workDir });
    expect(hit).toEqual({ ok: true, data: { path: realpathSync(workDir), isDirectory: true } });
    expect(parseNodeStatDirResult(hit.ok ? hit.data : null)).not.toBeNull();

    const missing = await dispatchCommand(ctx, { type: "stat_dir", path: join(base, "nope") });
    expect(missing.ok).toBe(false);
    expect(!missing.ok && missing.error.startsWith("ENOENT: ")).toBe(true);

    const file = join(dataDir, "a-file.txt");
    writeFileSync(file, "x");
    const notDir = await dispatchCommand(ctx, { type: "stat_dir", path: file });
    expect(notDir.ok).toBe(false);
    expect(!notDir.ok && notDir.error.startsWith("ENOTDIR: ")).toBe(true);
  });

  it("probe_resume: unknown harness errors; a harness without resume answers canResume:false", async () => {
    const { ctx } = makeCtx({}, []);
    expect(
      await dispatchCommand(ctx, { type: "probe_resume", harnessId: "no-such", harnessSessionId: "x", cwd: workDir }),
    ).toEqual({
      ok: false,
      error: "unknown harness",
    });
    const result = await dispatchCommand(ctx, {
      type: "probe_resume",
      harnessId: "pi",
      harnessSessionId: "x",
      cwd: workDir,
    });
    expect(result).toEqual({ ok: true, data: { canResume: false } });
    expect(parseNodeProbeResume(result.ok ? result.data : null)).toEqual({ canResume: false });
  });

  it("remove_paths: unlinks what exists under the roots; an absent path counts not", async () => {
    const { ctx } = makeCtx({}, []);
    await ctx.meta.record({
      subshellId: S1,
      cwd: workDir,
      socket: "s",
      harnessId: "pi",
      name: "s1",
      startedAt: "2026-09-01T00:00:00.000Z",
    });
    const keepWork = join(workDir, "b.txt");
    const gone = join(dataDir, "gone.txt"); // under a root, but absent
    const here = join(dataDir, "a.txt");
    writeFileSync(keepWork, "b");
    writeFileSync(here, "a");
    const result = await dispatchCommand(ctx, { type: "remove_paths", paths: [here, gone, keepWork] });
    expect(result).toEqual({ ok: true, data: { removed: 2 } }); // absent path counts not
    expect(existsSync(here)).toBe(false);
    expect(existsSync(keepWork)).toBe(false);
  });

  it("remove_paths: one path outside every root refuses the WHOLE batch, atomically, before any delete", async () => {
    const keep = join(dataDir, "keep.txt");
    const victim = join(outside, "victim.txt");
    writeFileSync(keep, "k");
    writeFileSync(victim, "v");
    const { ctx } = makeCtx({}, []);
    const result = await dispatchCommand(ctx, { type: "remove_paths", paths: [keep, victim] });
    expect(result).toEqual({ ok: false, error: `path refused: ${victim}` });
    expect(existsSync(keep)).toBe(true); // atomicity: nothing deleted
    expect(existsSync(victim)).toBe(true);
  });

  it("remove_paths: a `..`-bearing (bad-id style) path refuses via the SAME check and message", async () => {
    const keep = join(dataDir, "keep2.txt");
    writeFileSync(keep, "k");
    const hostile = `${join(dataDir, "subshells")}/../../escape.txt`; // interpolating a hostile subshell id
    const { ctx } = makeCtx({}, []);
    const result = await dispatchCommand(ctx, { type: "remove_paths", paths: [keep, hostile] });
    expect(result).toEqual({ ok: false, error: `path refused: ${hostile}` });
    expect(existsSync(keep)).toBe(true);
  });

  it("a malformed subshellId answers invalid subshell id BEFORE the meta store is touched", async () => {
    const { ctx, tmux } = makeCtx(
      {
        run: () => {
          throw new Error("must not reach tmux");
        },
      },
      [],
    );
    expect(await dispatchCommand(ctx, { type: "terminate", subshellId: "../evil" })).toEqual({
      ok: false,
      error: "invalid subshell id",
    });
    expect(await dispatchCommand(ctx, { type: "probe", subshellIds: [S1, "has space"] })).toEqual({
      ok: false,
      error: "invalid subshell id",
    });
    expect(tmux.calls).toEqual([]);
  });
  // `launch` flipped to the real executor in Task 4 (see
  // commands-launch.test.ts); `write_file` flipped in Task 6 (see
  // commands-write-file.test.ts). The `default: unsupported` arm is the
  // contract answer for any FUTURE unknown type — no pin test needed.
});
