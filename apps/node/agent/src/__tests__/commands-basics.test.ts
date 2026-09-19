import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tmuxSocketFor } from "@internal/pane-runtime";
import {
  NODE_MAX_FRAME_BYTES,
  type NodeEvent,
  parseNodeCaptureResult,
  parseNodeDetectResults,
  parseNodePaneSizeResult,
  parseNodePathExistsResult,
  parseNodeProbeEntries,
  parseNodeStatDirResult,
} from "@internal/subshell-protocol";
import { PROBE_RESULT_BUDGET_BYTES } from "../commands/basics.js";
import type { CommandContext } from "../commands/context.js";
import { dispatchCommand } from "../commands/index.js";
import type { NodeConfig } from "../config.js";
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
  paneSize?: (socket: string, id: string) => { cols: number; rows: number } | null;
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
    paneSize: method("paneSize"),
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
    meta: new SubshellMetaStore(dataDir),
    nowMs: () => 1_700_000_000_000,
    ws: { send: (ev) => events.push(ev) },
    watchers: new Map(),
    tails: new Map(),
    uploads: new Map(),
    runtime: null,
    requestRestart: () => {},
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

  it("pane_size answers the pane's real grid, in the shape the server parses", async () => {
    // This half ships INSIDE the compiled agent binary and cannot be
    // hot-fixed from the server, so the contract is asserted against the
    // server's own parser rather than a hand-written shape.
    const { ctx, tmux } = makeCtx({ paneSize: () => ({ cols: 132, rows: 43 }) }, []);
    const result = await dispatchCommand(ctx, { type: "pane_size", subshellId: S1 });
    expect(result).toEqual({ ok: true, data: { cols: 132, rows: 43 } });
    expect(parseNodePaneSizeResult(result.ok ? result.data : null)).toEqual({ cols: 132, rows: 43 });
    expect(argsOf(tmux, "paneSize")).toEqual([["recorded-sock", S1]]);
  });

  it("pane_size answers ok:true with null data for a pane that is gone", async () => {
    // The dead-pane contract the SERVER now depends on: a vanished pane is a
    // successful answer of "no size", NOT an error. The server reads that
    // null as "the pane died" and announces nothing — if this ever became an
    // error result instead, the server would read it as a wedged node and the
    // distinction it draws would collapse.
    const { ctx } = makeCtx({ paneSize: () => null }, []);
    const result = await dispatchCommand(ctx, { type: "pane_size", subshellId: S1 });
    expect(result).toEqual({ ok: true, data: null });
    expect(parseNodePaneSizeResult(result.ok ? result.data : null)).toBeNull();
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

  it("path_exists: stats the given path; absence is a successful `exists:false`, never an error", async () => {
    // The command-census entry (inversion spec §5): `probe_resume` is gone,
    // the node is a stat endpoint for a path the CONTROL PLANE computed. An
    // absent path is DATA, not a failure — the caller reads `exists:false` as
    // "start fresh", and an error result would mean "node broken" instead.
    const { ctx } = makeCtx({}, []);
    const transcript = join(workDir, "abc.jsonl");
    writeFileSync(transcript, "{}");
    const hit = await dispatchCommand(ctx, { type: "path_exists", path: transcript });
    expect(hit).toEqual({ ok: true, data: { exists: true } });
    expect(parseNodePathExistsResult(hit.ok ? hit.data : null)).toEqual({ exists: true });

    const miss = await dispatchCommand(ctx, { type: "path_exists", path: join(base, "never-here.jsonl") });
    expect(miss).toEqual({ ok: true, data: { exists: false } });
    expect(parseNodePathExistsResult(miss.ok ? miss.data : null)).toEqual({ exists: false });

    // A relative path is answered honestly too: the plane computes from the
    // node's reported home, and a node that reported NO home gets a relative
    // default — which stats under the agent's cwd and, being absent there,
    // degrades to a fresh conversation rather than a crash.
    const relative = await dispatchCommand(ctx, {
      type: "path_exists",
      path: `.subshell-path-exists-probe-${crypto.randomUUID()}.jsonl`,
    });
    expect(relative).toEqual({ ok: true, data: { exists: false } });
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
  // contract answer for any FUTURE unknown type, and for exactly that now:
  // `plugin_install`/`plugin_uninstall` left the wire at protocol 3, so the
  // parser answers them `null` before dispatch can reach this arm — the
  // census that Task 7 pinned here moved to the protocol test
  // (`__tests__/node-frames.test.ts`, "plugin commands (removed in protocol
  // 3)"), and no dispatch case for them may quietly re-grow.
});

describe("detect (inversion spec §4)", () => {
  // ── detect (inversion spec §4) ─────────────────────────────────────────────
  // Pure data in, data out: the plane names the binaries, the node probes and
  // answers RAW text. `parseVersion` is plugin code and does not run here —
  // that half moved to the control plane (see the server's detectOnNode tests).

  const DETECT_ENV = "SUBSHELL_DETECT_TEST_BINARY";
  const DETECT_ENV_ANSWERED = "SUBSHELL_DETECT_TEST_ANSWERED";
  const DETECT_BANNER = "Hermes Agent v0.16.0 (2026.6.5) - upstream 5e01a5db\nbuilt 2026-06-05";
  // Path computed in beforeAll, not at collection: `base` is assigned by the
  // file-level beforeAll, which has not run while this describe body evaluates.
  let fakeHarness = "";

  beforeAll(async () => {
    // A deterministic "harness binary": ignores its args, prints a banner
    // (hermes-style) over two lines. probeVersion trims; nothing else may
    // touch the text.
    fakeHarness = join(base, "fake-harness.sh");
    await Bun.write(
      fakeHarness,
      `#!/bin/sh\nprintf '%s\\n' 'Hermes Agent v0.16.0 (2026.6.5) - upstream 5e01a5db' 'built 2026-06-05'\n`,
    );
    chmodSync(fakeHarness, 0o755);
  });

  it("detect: one row per spec; found answers RAW unparsed text; misses answer with a reason; env answers the asked names", async () => {
    expect(fakeHarness).toBeTruthy();
    process.env[DETECT_ENV] = fakeHarness;
    // §5-as-amended: the plane names the env vars; the node answers the ones
    // it HAS. One set, one unset — and one set-but-never-asked, which must
    // not appear (the answer is never a scan).
    process.env[DETECT_ENV_ANSWERED] = "/custom/config";
    try {
      const { ctx } = makeCtx({}, []);
      const res = await dispatchCommand(ctx, {
        type: "detect",
        specs: [
          { id: "hermesish", binaryName: "anything", envOverride: DETECT_ENV, knownPaths: [] },
          {
            id: "ghost",
            binaryName: "definitely-not-here-9f3c",
            envOverride: "SUBSHELL_DETECT_TEST_MISSING",
            knownPaths: [],
          },
        ],
        envNames: [DETECT_ENV_ANSWERED, "SUBSHELL_DETECT_TEST_UNSET"],
      });
      expect(res.ok).toBe(true);
      const data = (res as { ok: true; data: unknown }).data;
      // The Task-1 contract validator round trip (suite idiom): the agent's
      // answer is exactly what the backend expects to parse.
      const answer = parseNodeDetectResults(data);
      expect(answer?.rows).toHaveLength(2);
      const found = answer?.rows.find((r) => r.harnessId === "hermesish");
      expect(found).toMatchObject({ installed: true, binaryPath: fakeHarness });
      // RAW text, unparsed: the full banner, second line included. A node that
      // ran parseVersion here could never produce this byte-for-byte.
      expect(found?.rawVersion).toBe(DETECT_BANNER);
      expect(found?.rawVersion).not.toBe("0.16.0");
      expect(found).not.toHaveProperty("version");
      expect(answer?.rows.find((r) => r.harnessId === "ghost")).toMatchObject({
        installed: false,
        reason: "not-on-path",
      });
      // present-only: the set name answered, the unset one ABSENT, the
      // unasked one invisible.
      expect(answer?.env).toEqual({ [DETECT_ENV_ANSWERED]: "/custom/config" });
    } finally {
      delete process.env[DETECT_ENV];
      delete process.env[DETECT_ENV_ANSWERED];
    }
  });

  it("detect: an empty binaryName answers no-binary WITHOUT searching (a set override is not consulted)", async () => {
    process.env[DETECT_ENV] = fakeHarness; // present on purpose: no-binary must beat it
    try {
      const { ctx } = makeCtx({}, []);
      const res = await dispatchCommand(ctx, {
        type: "detect",
        specs: [{ id: "term", binaryName: "", envOverride: DETECT_ENV, knownPaths: [] }],
        envNames: [],
      });
      const rows = parseNodeDetectResults((res as { ok: true; data: unknown }).data)?.rows;
      expect(rows?.[0]).toMatchObject({ harnessId: "term", installed: false, reason: "no-binary" });
      expect(rows?.[0]).not.toHaveProperty("rawVersion");
    } finally {
      delete process.env[DETECT_ENV];
    }
  });

  it("detect: an invalid override answers override-invalid; no specs is a legal empty batch", async () => {
    process.env[DETECT_ENV] = join(base, "nowhere-at-all"); // set but not executable
    try {
      const { ctx } = makeCtx({}, []);
      const res = await dispatchCommand(ctx, {
        type: "detect",
        specs: [{ id: "x", binaryName: "anything", envOverride: DETECT_ENV, knownPaths: [] }],
        envNames: [],
      });
      const rows = parseNodeDetectResults((res as { ok: true; data: unknown }).data)?.rows;
      expect(rows?.[0]).toMatchObject({ installed: false, reason: "override-invalid" });
      const empty = await dispatchCommand(ctx, { type: "detect", specs: [], envNames: [] });
      // An empty envNames answers an empty env — the `{}` half of the result
      // shape is REQUIRED, never omitted.
      expect(empty).toEqual({ ok: true, data: { results: [], env: {} } });
    } finally {
      delete process.env[DETECT_ENV];
    }
  });
});
