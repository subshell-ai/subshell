import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type DisplayChild, type XvfbDisplayDeps as DisplayDeps, XvfbDisplayProvider } from "@internal/pane-runtime";
import { HARNESS_BINARY_PLACEHOLDER, type NodeEvent, parseNodePreviewPortsResult } from "@internal/subshell-protocol";
import type { Cmd, CommandContext } from "../commands/context.js";
import { execLaunch } from "../commands/launch.js";
import { execPreviewPorts, PREVIEW_NODE_OFF, type PreviewPortsSeams } from "../commands/preview-ports-exec.js";
import { runExitWatchTick } from "../commands/report.js";
import type { NodeConfig } from "../config.js";
import { runDisplaySweep } from "../daemon.js";
import {
  PreviewDisplays as NodePreviewDisplays,
  PREVIEW_DISPLAY_MISSING_REQUIREMENTS,
  PREVIEW_DISPLAY_NOT_READY,
  PREVIEW_DISPLAY_UNSUPPORTED,
} from "../preview/display.js";
import { setPreviewEnabled } from "../preview/flags.js";
import { SubshellMetaStore } from "../subshell-meta.js";

class PreviewDisplays extends NodePreviewDisplays {
  constructor(dataDir: string, deps: DisplayDeps = {}) {
    super(dataDir, { provider: new XvfbDisplayProvider(dataDir, deps) });
  }
}
function xauthorityPath(dataDir: string, paneId: string) {
  return join(dataDir, "display-providers", "xvfb-x11vnc", "displays", paneId, "Xauthority");
}

/**
 * Virtual displays (pane-preview spec §5, Task 7): the Xvfb + x11vnc pair a
 * `screen` launch allocates, the ports answer's `screen` half, and the
 * orphan sweep. NO real Xvfb or x11vnc is ever spawned here: every mechanic
 * runs through the injected `{ spawn, spawnSync, which, sleep, now, bindProbe,
 * kill }` deps, and the argv-exactness case is what makes the fakes honest -
 * it is the only assertion that can catch a broken invocation, because
 * everything else in this suite runs on doubles. Posture copied from
 * preview-ports.test.ts: real temp dirs, the mirror written by its own
 * writer, refusals asserted as thrown words.
 */

const STAMP = "2026-10-22T10:00:00.000Z";
const PANE = "11111111-2222-4333-8444-555555555555";
const HOUR_MS = 3_600_000;

let base: string;
let claudePathOriginal: string | undefined;

beforeAll(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "subshell-preview-display-")));
  // The harness binary "exists" (/bin/sh - never spawned; the pane command
  // is assembled against it and thrown away). Same determinism trick as
  // commands-launch.test.ts: the resolve rule reads CLAUDE_PATH, so the
  // binary-found branch is real on every host.
  claudePathOriginal = process.env.CLAUDE_PATH;
  process.env.CLAUDE_PATH = "/bin/sh";
});

afterAll(() => {
  if (claudePathOriginal === undefined) delete process.env.CLAUDE_PATH;
  else process.env.CLAUDE_PATH = claudePathOriginal;
  rmSync(base, { recursive: true, force: true });
});

/** A per-test data dir with the preview mirror switched ON. */
function onDir(tag: string): string {
  const dataDir = join(base, tag, "data");
  mkdirSync(dataDir, { recursive: true });
  setPreviewEnabled(dataDir, { on: true, changedAt: STAMP });
  return dataDir;
}

/** A child double: the test fires `exited` when it wants the watch to run. */
class FakeChild implements DisplayChild {
  readonly pid: number;
  readonly exited: Promise<number>;
  #resolve!: (code: number) => void;

  constructor(pid: number) {
    this.pid = pid;
    this.exited = new Promise<number>((r) => {
      this.#resolve = r;
    });
  }

  fireExit(code = 1): void {
    this.#resolve(code);
  }
}

type DepCall =
  | { kind: "spawnSync"; argv: string[] }
  | { kind: "spawn"; argv: string[]; logPath: string; child: FakeChild; jsonAtSpawn: string | null }
  | { kind: "kill"; pid: number; signal: number | string };

interface DepOverrides {
  /** Binary presence table (name -> path, or null for missing). */
  which?: Record<string, string | null>;
  /** Exit code the xauth mint answers (default 0). */
  xauthRc?: number;
  /** Ports already occupied BEFORE anything spawns (the collision case). */
  busyRfbPorts?: Set<number>;
  /** Default true: the x11vnc spawn marks its chosen rfb port occupied, the way a listening server occupies it. */
  x11vncListens?: boolean;
  /** Default true: the X socket answers immediately (fake for `/tmp/.X11-unix/XNN`). */
  xSocketReady?: boolean;
  /** Readiness budget override. */
  readyBudgetMs?: number;
}

/**
 * The injected-deps harness. `calls` is the ONE ordered log across xauth,
 * both spawns, and every kill, because the brief's load-bearing assertion is
 * that `xauth add` fires BEFORE the Xvfb spawn - two separate arrays cannot
 * show the ordering, one can. Every kill lands in the log, including the
 * signal-0 liveness probes; `killPids()` is the strikes-only view and
 * `probes()` the probe-only view.
 */
function makeDeps(over: DepOverrides = {}) {
  const busy = over.busyRfbPorts ?? new Set<number>();
  const alivePids = new Set<number>();
  const calls: DepCall[] = [];
  const whichMap: Record<string, string | null> = {
    Xvfb: "/usr/bin/Xvfb",
    x11vnc: "/usr/bin/x11vnc",
    xauth: "/usr/bin/xauth",
    ...over.which,
  };
  let pidSeq = 4100;
  let clock = Date.now();
  const deps: DisplayDeps = {
    spawnSync: (argv) => {
      calls.push({ kind: "spawnSync", argv });
      if (String(argv[0]).endsWith("xauth")) writeFileSync(String(argv[2]), "", { mode: 0o600 });
      return over.xauthRc ?? 0;
    },
    spawn: (argv, opts) => {
      const child = new FakeChild(pidSeq++);
      alivePids.add(child.pid);
      const rfbIdx = argv.indexOf("-rfbport");
      if (over.x11vncListens !== false && rfbIdx >= 0) busy.add(Number(argv[rfbIdx + 1]));
      const jsonFile = join(opts.logPath, "..", "display.json");
      calls.push({
        kind: "spawn",
        argv,
        logPath: opts.logPath,
        child,
        jsonAtSpawn: existsSync(jsonFile) ? readFileSync(jsonFile, "utf8") : null,
      });
      return child;
    },
    which: (name) => whichMap[name] ?? null,
    sleep: async () => {
      clock += 100;
    },
    now: () => clock,
    bindProbe: async (port) => busy.has(port),
    kill: (pid, signal = "SIGTERM") => {
      calls.push({ kind: "kill", pid, signal });
      if (!alivePids.has(pid)) throw Object.assign(new Error(`fake kill: no such pid ${pid}`), { code: "ESRCH" });
      if (signal !== 0) alivePids.delete(pid);
    },
    xSocketReady: () => over.xSocketReady ?? true,
    displayOccupied: () => false,
    matchesProcess: () => true,
    ...(over.readyBudgetMs === undefined ? {} : { readyBudgetMs: over.readyBudgetMs }),
  };
  const spawns = (): Array<Extract<DepCall, { kind: "spawn" }>> =>
    calls.filter((c): c is Extract<DepCall, { kind: "spawn" }> => c.kind === "spawn");
  const killPids = (): number[] => calls.flatMap((c) => (c.kind === "kill" && c.signal !== 0 ? [c.pid] : []));
  const probes = (): number[] => calls.flatMap((c) => (c.kind === "kill" && c.signal === 0 ? [c.pid] : []));
  return { deps, calls, busy, alivePids, spawns, killPids, probes, advanceClock: (ms: number) => (clock += ms) };
}

/** Let the resolved `exited` promises run their watch handlers. */
async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
}

/** Age a path (dir or lock) past the sweep's one-hour launch floor. */
function ageOut(...paths: string[]): void {
  const old = new Date(Date.now() - 2 * HOUR_MS);
  for (const p of paths) utimesSync(p, old, old);
}

/* Ports-executor test stand-ins (shared by the wiring group and round 1). */

function portsCtx(dataDir: string, previewDisplays?: PreviewDisplays): CommandContext {
  return {
    config: { dataDir, nodeId: "node-self" },
    meta: { get: async () => undefined },
    tmux: { panePid: async () => 100 },
    previewDisplays,
  } as unknown as CommandContext;
}

/** The scan seam that echoes the screen it is handed, as scanPanePorts does. */
function passthroughScan(seen: unknown[]): PreviewPortsSeams {
  return {
    scan: async (opts) => {
      seen.push(opts.screen);
      return { ports: [], cdpPort: null, screen: opts.screen ?? null };
    },
  };
}

const portsCmd = { type: "preview_ports_get", paneId: PANE } as Cmd<"preview_ports_get">;

/* ------------------------------------------------------------------ */
/* openFor: allocation, argv exactness, modes                          */
/* ------------------------------------------------------------------ */

describe("PreviewDisplays.openFor", () => {
  it("does not signal a recorded PID that now belongs to another process", async () => {
    const h = makeDeps();
    let matches = true;
    h.deps.matchesProcess = () => matches;
    const displays = new PreviewDisplays(onDir("reused-display-pid"), h.deps);
    await displays.openFor(PANE, { width: 1280, height: 800 });
    matches = false;
    displays.closeFor(PANE);
    expect(h.killPids()).toEqual([]);
  });
  it("skips display numbers used outside this data directory", async () => {
    const { deps } = makeDeps();
    deps.displayOccupied = (number) => number === 90 || number === 91;
    const displays = new PreviewDisplays(onDir("external-display"), deps);
    const screen = await displays.openFor(PANE, { width: 1280, height: 800 });
    expect(screen.display).toBe(":92");
    displays.closeFor(PANE);
  });
  it("allocates :90/5910 with the EXACT argv and ORDER, 0700 dir, 0600 files, incremental display.json", async () => {
    const dataDir = onDir("happy");
    const displaysRoot = join(dataDir, "display-providers", "xvfb-x11vnc", "displays");
    const paneDir = join(displaysRoot, PANE);
    const auth = xauthorityPath(dataDir, PANE);
    const { deps, calls, spawns } = makeDeps();
    const reg = new PreviewDisplays(dataDir, deps);

    const r = await reg.openFor(PANE, { width: 1280, height: 1024 });
    expect(r).toEqual({ display: ":90", viewer: { protocol: "vnc", port: 5910 } });

    // THE load-bearing assertion (the plan's earlier xauth line measured
    // broken while staying green): xauth `add` fires FIRST, then Xvfb, then
    // x11vnc, each with exactly these arguments. The argv[0] is the path
    // `which` resolved; the flags are the contract.
    expect(calls.map((c) => c.kind)).toEqual(["spawnSync", "spawn", "spawn"]);
    const xauth = calls[0] as Extract<DepCall, { kind: "spawnSync" }>;
    expect(xauth.argv[0]).toBe("/usr/bin/xauth");
    const cookie = xauth.argv[6] as string;
    expect(cookie).toMatch(/^[0-9a-f]{32}$/); // 32 hex, minted before anything spawns
    expect(xauth.argv.slice(1)).toEqual(["-f", auth, "add", ":90", ".", cookie]);
    const xvfb = spawns()[0];
    expect(xvfb?.argv).toEqual([
      "/usr/bin/Xvfb",
      ":90",
      "-auth",
      auth,
      "-screen",
      "0",
      "1280x1024x24",
      "-nolisten",
      "tcp",
    ]);
    const vnc = spawns()[1];
    expect(vnc?.argv).toEqual([
      "/usr/bin/x11vnc",
      "-display",
      ":90",
      "-auth",
      auth,
      "-localhost",
      "-forever",
      "-shared",
      "-rfbport",
      "5910",
    ]);

    // Modes: state dir 0700, every file this module writes 0600.
    expect(statSync(paneDir).mode & 0o777).toBe(0o700);
    for (const f of ["Xvfb.log", "x11vnc.log", "display.env", "display.json", "Xauthority"]) {
      expect(statSync(join(paneDir, f)).mode & 0o777, f).toBe(0o600);
    }
    expect(xvfb?.logPath).toBe(join(paneDir, "Xvfb.log"));
    expect(vnc?.logPath).toBe(join(paneDir, "x11vnc.log"));

    // display.json is written INCREMENTALLY: at the x11vnc spawn it already
    // names the Xvfb pid (every crash window leaves the pids that exist), and
    // the final record is the full four-field pair.
    const atVncSpawn = JSON.parse(String(vnc?.jsonAtSpawn));
    expect(atVncSpawn).toEqual({ display: ":90", xvfbPid: xvfb?.child.pid });
    const final = JSON.parse(readFileSync(join(paneDir, "display.json"), "utf8"));
    expect(final).toEqual({ display: ":90", rfbPort: 5910, xvfbPid: xvfb?.child.pid, x11vncPid: vnc?.child.pid });

    // The pinned env file an operator can source.
    const envFile = readFileSync(join(paneDir, "display.env"), "utf8");
    expect(envFile).toContain("DISPLAY=:90");
    expect(envFile).toContain(`XAUTHORITY=${auth}`);

    // The lock ties the NUMBER, the dir carries the pane: the pairing the
    // sweep reads off the layout.
    expect(existsSync(join(displaysRoot, ".display-90.lock"))).toBe(true);
    expect(reg.getFor(PANE)).toEqual({ display: ":90", viewer: { protocol: "vnc", port: 5910 } });
    expect(reg.lostFor(PANE)).toBeNull();
  });

  it("a taken lockfile pushes the allocation to :91", async () => {
    const dataDir = onDir("taken-lock");
    const displaysRoot = join(dataDir, "display-providers", "xvfb-x11vnc", "displays");
    mkdirSync(displaysRoot, { recursive: true });
    writeFileSync(join(displaysRoot, ".display-90.lock"), "", { mode: 0o600 });
    const { deps, spawns } = makeDeps();
    const reg = new PreviewDisplays(dataDir, deps);

    const r = await reg.openFor(PANE, { width: 800, height: 600 });
    expect(r.display).toBe(":91");
    expect(existsSync(join(displaysRoot, ".display-91.lock"))).toBe(true);
    expect(spawns()[0]?.argv).toEqual([
      "/usr/bin/Xvfb",
      ":91",
      "-auth",
      xauthorityPath(dataDir, PANE),
      "-screen",
      "0",
      "800x600x24",
      "-nolisten",
      "tcp",
    ]);
  });

  it("the rfb-port chooser retries on collision: a busy 5910 lands 5911 in the result", async () => {
    const dataDir = onDir("rfb-collision");
    const { deps } = makeDeps({ busyRfbPorts: new Set([5910]) });
    const reg = new PreviewDisplays(dataDir, deps);
    const r = await reg.openFor(PANE, { width: 640, height: 480 });
    expect(r).toEqual({ display: ":90", viewer: { protocol: "vnc", port: 5911 } });
  });

  it("a missing x11vnc refuses naming it, and leaves no lock and no dir behind", async () => {
    const dataDir = onDir("missing-vnc");
    const { deps, spawns } = makeDeps({ which: { x11vnc: null } });
    const reg = new PreviewDisplays(dataDir, deps);
    await expect(reg.openFor(PANE, { width: 640, height: 480 })).rejects.toThrow(
      `${PREVIEW_DISPLAY_MISSING_REQUIREMENTS}: x11vnc`,
    );
    expect(spawns()).toHaveLength(0);
    const root = join(dataDir, "display-providers", "xvfb-x11vnc", "displays");
    expect(existsSync(join(root, PANE))).toBe(false);
    expect(existsSync(join(root, ".display-90.lock"))).toBe(false);
  });

  it("readiness polls the X socket, then the rfb port, and refuses preview-display-not-ready after the budget", async () => {
    const dataDir = onDir("not-ready");
    const { deps, spawns, killPids } = makeDeps({ xSocketReady: false });
    const reg = new PreviewDisplays(dataDir, deps);
    await expect(reg.openFor(PANE, { width: 640, height: 480 })).rejects.toThrow(PREVIEW_DISPLAY_NOT_READY);
    // The refusal tears down what it started: both children signalled, lock
    // unlinked, dir gone - the caller refuses the launch, not half a display.
    expect(spawns()).toHaveLength(2);
    const pids = spawns().map((s) => s.child.pid);
    expect(pids.every((p) => killPids().includes(p))).toBe(true);
    expect(existsSync(join(dataDir, "display-providers", "xvfb-x11vnc", "displays", PANE))).toBe(false);
    expect(existsSync(join(dataDir, "display-providers", "xvfb-x11vnc", "displays", ".display-90.lock"))).toBe(false);
    expect(reg.getFor(PANE)).toBeNull();
  });

  it("an X socket that comes up but an rfb server that never listens also refuses preview-display-not-ready", async () => {
    // The second readiness phase, with its own pin: xSocketReady true, but the
    // x11vnc double never occupies the port, so the rfb poll exhausts the
    // budget and the teardown runs.
    const dataDir = onDir("rfb-never-ready");
    const { deps, killPids } = makeDeps({ x11vncListens: false });
    const reg = new PreviewDisplays(dataDir, deps);
    await expect(reg.openFor(PANE, { width: 640, height: 480 })).rejects.toThrow(PREVIEW_DISPLAY_NOT_READY);
    expect(killPids().length).toBe(2);
    expect(existsSync(join(dataDir, "display-providers", "xvfb-x11vnc", "displays", PANE))).toBe(false);
  });

  it.skipIf(process.platform === "linux")(
    "openFor refuses preview-display-unsupported on non-Linux, before touching fs",
    async () => {
      // Mirror of preview-ports.test.ts's twin: on a non-Linux host the
      // refusal must arrive with nothing spawned. On Linux the platform
      // branch cannot be exercised without a seam, and there is no seam
      // because a Linux node is where this runs.
      const dataDir = onDir("non-linux");
      const { deps, spawns } = makeDeps();
      const reg = new PreviewDisplays(dataDir, deps);
      await expect(reg.openFor(PANE, { width: 640, height: 480 })).rejects.toThrow(PREVIEW_DISPLAY_UNSUPPORTED);
      expect(spawns()).toHaveLength(0);
    },
  );

  it("openFor on a REGISTERED pane is idempotent and spawns nothing", async () => {
    const dataDir = onDir("idempotent");
    const { deps, spawns } = makeDeps();
    const reg = new PreviewDisplays(dataDir, deps);
    const first = await reg.openFor(PANE, { width: 640, height: 480 });
    const second = await reg.openFor(PANE, { width: 1024, height: 768 });
    expect(second).toEqual(first);
    expect(spawns()).toHaveLength(2); // still only the original Xvfb + x11vnc
  });
});

/* ------------------------------------------------------------------ */
/* the child-exit watch (spec §9 mid-pane loss)                        */
/* ------------------------------------------------------------------ */

describe("the child-exit watch", () => {
  it("a registered display whose x11vnc exits marks lostFor, reaps lock and dir, and leaves the pane alone", async () => {
    const dataDir = onDir("child-exit");
    const store = new SubshellMetaStore(dataDir);
    await store.record({
      subshellId: PANE,
      cwd: base,
      socket: "sock",
      harnessId: "claude-code",
      name: "m",
      startedAt: STAMP,
    });
    const { deps, spawns, killPids } = makeDeps();
    const reg = new PreviewDisplays(dataDir, deps);
    await reg.openFor(PANE, { width: 640, height: 480 });

    spawns()[1]?.child.fireExit();
    await flush();

    expect(reg.lostFor(PANE)).toBe("x11vnc"); // the ports answer names the loss
    expect(reg.getFor(PANE)).toBeNull();
    // The same teardown closeFor runs: the lock unlinked, the dir reaped.
    expect(killPids().length).toBeGreaterThan(0);
    expect(existsSync(join(dataDir, "display-providers", "xvfb-x11vnc", "displays", PANE))).toBe(false);
    expect(existsSync(join(dataDir, "display-providers", "xvfb-x11vnc", "displays", ".display-90.lock"))).toBe(false);
    // The pane's row is untouched: its terminal keeps streaming on a dead
    // DISPLAY, which is spec §9's posture.
    expect(await store.get(PANE)).toBeDefined();

    // The next openFor clears the marker.
    const r = await reg.openFor(PANE, { width: 640, height: 480 });
    expect(reg.lostFor(PANE)).toBeNull();
    expect(r.display).toBe(":90");
  });

  it("a teardown through closeFor does not re-enter as a loss", async () => {
    const dataDir = onDir("close-not-loss");
    const { deps, spawns, killPids } = makeDeps();
    const reg = new PreviewDisplays(dataDir, deps);
    await reg.openFor(PANE, { width: 640, height: 480 });

    reg.closeFor(PANE);
    spawns()[0]?.child.fireExit();
    spawns()[1]?.child.fireExit();
    await flush();

    expect(reg.lostFor(PANE)).toBeNull(); // a deliberate close is not a loss
    const pids = spawns().map((s) => s.child.pid);
    expect(pids.every((p) => killPids().includes(p))).toBe(true);
    expect(existsSync(join(dataDir, "display-providers", "xvfb-x11vnc", "displays", PANE))).toBe(false);
    expect(existsSync(join(dataDir, "display-providers", "xvfb-x11vnc", "displays", ".display-90.lock"))).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* the ports executor wiring (decision 6's supply line)                */
/* ------------------------------------------------------------------ */

describe("the preview_ports_get executor reads the display registry", () => {
  it("a registered display answers screen { display, rfbPort } and survives the Task 1 validator", async () => {
    const dataDir = onDir("ports-registered");
    const { deps } = makeDeps();
    const reg = new PreviewDisplays(dataDir, deps);
    const r = await reg.openFor(PANE, { width: 640, height: 480 });
    const seen: unknown[] = [];
    const res = await execPreviewPorts(portsCtx(dataDir, reg), portsCmd, passthroughScan(seen));
    expect(res).toEqual({ ok: true, data: { ports: [], cdpPort: null, screen: r } });
    const parsed = parseNodePreviewPortsResult(res.ok ? res.data : null);
    expect(parsed).toEqual({
      ports: [],
      cdpPort: null,
      screen: { display: ":90", viewer: { protocol: "vnc", port: 5910 } },
    });
    expect(parsed?.screenLost).toBeUndefined();
  });

  it("a pane with no display answers screen null and NO screenLost", async () => {
    const dataDir = onDir("ports-none");
    const { deps } = makeDeps();
    const reg = new PreviewDisplays(dataDir, deps);
    const seen: unknown[] = [];
    const res = await execPreviewPorts(portsCtx(dataDir, reg), portsCmd, passthroughScan(seen));
    expect(res.ok && res.data).toEqual({ ports: [], cdpPort: null, screen: null });
    const parsed = parseNodePreviewPortsResult(res.ok ? res.data : null);
    expect(parsed).toEqual({ ports: [], cdpPort: null, screen: null });
    expect(parsed?.screenLost).toBeUndefined();
  });

  it("the dead-marker shape screen null + screenLost rides the validator with the marker SURVIVING the rebuild", async () => {
    // Task 1 Step 5's hand-rolled validator strips unlisted members, so this
    // is the only line between the node naming the loss and Task 14's manual
    // leg seeing nothing.
    const dataDir = onDir("ports-lost");
    const { deps, spawns } = makeDeps();
    const reg = new PreviewDisplays(dataDir, deps);
    await reg.openFor(PANE, { width: 640, height: 480 });
    spawns()[1]?.child.fireExit(); // x11vnc dies mid-pane
    await flush();

    const seen: unknown[] = [];
    const res = await execPreviewPorts(portsCtx(dataDir, reg), portsCmd, passthroughScan(seen));
    expect(res.ok && res.data).toEqual({ ports: [], cdpPort: null, screen: null, screenLost: "x11vnc" });
    const parsed = parseNodePreviewPortsResult(res.ok ? res.data : null);
    expect(parsed).not.toBeNull();
    expect(parsed?.screen).toBeNull();
    expect(parsed?.screenLost).toBe("x11vnc"); // the pairing rule: null screen + named loss
  });

  it("a context with no display registry answers screen null (every pre-Task-7 fake keeps compiling)", async () => {
    const dataDir = onDir("ports-no-registry");
    const seen: unknown[] = [];
    const res = await execPreviewPorts(portsCtx(dataDir), portsCmd, passthroughScan(seen));
    expect(res.ok && res.data).toEqual({ ports: [], cdpPort: null, screen: null });
  });
});

/* ------------------------------------------------------------------ */
/* the switch-off gate, on both entry points                           */
/* ------------------------------------------------------------------ */

describe("the preview switch, off", () => {
  it("openFor refuses preview-node-off BEFORE any spawn, lock, or directory", async () => {
    const dataDir = join(base, "off-open", "data");
    mkdirSync(dataDir, { recursive: true }); // mirror file deliberately absent
    const { deps, calls } = makeDeps();
    const reg = new PreviewDisplays(dataDir, deps);
    await expect(reg.openFor(PANE, { width: 640, height: 480 })).rejects.toThrow("preview-node-off");
    expect(calls).toHaveLength(0);
    expect(existsSync(join(dataDir, "display-providers", "xvfb-x11vnc", "displays"))).toBe(false);
  });

  it("the launch.screen path refuses naming the switch with the same voice, before the meta record", async () => {
    const dataDir = join(base, "off-launch", "data");
    mkdirSync(dataDir, { recursive: true });
    const { deps, calls } = makeDeps();
    const reg = new PreviewDisplays(dataDir, deps);
    const { ctx, calls: tmuxCalls, events } = makeLaunchCtx(dataDir, reg);
    const res = await execLaunch(ctx, launchCmd({ screen: { width: 640, height: 480 } }));
    expect(res).toEqual({ ok: false, error: PREVIEW_NODE_OFF });
    expect(tmuxCalls).toHaveLength(0); // the pane never spawned
    expect(calls).toHaveLength(0); // neither did a display
    expect(events).toHaveLength(0);
    expect(await ctx.meta.get(PANE)).toBeUndefined(); // refused BEFORE the meta record
    expect(existsSync(join(dataDir, "display-providers", "xvfb-x11vnc", "displays"))).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* pane death + the sweep                                              */
/* ------------------------------------------------------------------ */

describe("pane death and the orphan sweep", () => {
  it("a pane death reported through the exit watcher closes its display (SIGTERM both children, lock unlinked)", async () => {
    const dataDir = onDir("death-close");
    const { deps, spawns, killPids } = makeDeps();
    const reg = new PreviewDisplays(dataDir, deps);
    await reg.openFor(PANE, { width: 640, height: 480 });
    const pids = spawns().map((s) => s.child.pid);

    const { ctx } = makeLaunchCtx(dataDir, reg);
    // The record rides on ctx.meta's OWN store: the meta store's authoritative
    // mirror is per-instance, and two stores over one dir would test the
    // cache, not the death report.
    await ctx.meta.record({
      subshellId: PANE,
      cwd: base,
      socket: "sock",
      harnessId: "claude-code",
      name: "m",
      startedAt: STAMP,
    });
    ctx.watchers.set(PANE, { socket: "sock", token: Symbol(PANE), unreachable: 0 });
    await runExitWatchTick(ctx);

    expect(pids.every((p) => killPids().includes(p))).toBe(true);
    expect(existsSync(join(dataDir, "display-providers", "xvfb-x11vnc", "displays", ".display-90.lock"))).toBe(false);
    expect(existsSync(join(dataDir, "display-providers", "xvfb-x11vnc", "displays", PANE))).toBe(false);
    expect(reg.getFor(PANE)).toBeNull();
    expect(await ctx.meta.get(PANE)).toBeUndefined(); // the death itself still reported
  });

  it("sweepOrphans closes a REGISTERED display whose pane id is absent from the alive list", async () => {
    const dataDir = onDir("sweep-registered");
    const { deps, spawns, killPids, advanceClock } = makeDeps();
    const reg = new PreviewDisplays(dataDir, deps);
    await reg.openFor(PANE, { width: 640, height: 480 });
    const pids = spawns().map((s) => s.child.pid);
    // Past the fresh-entry floor (round 1): the census-absent reap waits out
    // the launch/census race, pinned in both directions by the round 1 group.
    advanceClock(61_000);

    const r = await reg.sweepOrphans(["someone-else"]);
    expect(r.reaped).toBe(1);
    expect(reg.getFor(PANE)).toBeNull();
    expect(pids.every((p) => killPids().includes(p))).toBe(true);
    expect(existsSync(join(dataDir, "display-providers", "xvfb-x11vnc", "displays", PANE))).toBe(false);
    expect(existsSync(join(dataDir, "display-providers", "xvfb-x11vnc", "displays", ".display-90.lock"))).toBe(false);
  });

  it("the restart trio: a live pane's dir rehydrates, a dead pane's dir is reaped, and a live pane whose recorded children are gone is reaped, not rehydrated", async () => {
    // A plain daemon restart clears the in-memory registry but leaves the
    // dirs; a service-manager restart can take the whole cgroup while tmux
    // and the pane survive, leaving a dir whose sockets answer nothing. Only
    // the DISK walk can tell these apart, which is why this case rebuilds the
    // module state against the same temp dataDir.
    const dataDir = onDir("restart-trio");
    const LIVE = "11111111-2222-4333-8444-555555555555";
    const DEAD = "22222222-2222-4222-8222-222222222222";
    const GONE = "33333333-3333-4333-8333-333333333333";

    const shared = makeDeps(); // ONE busy/alive world across all three opens
    const reg1 = new PreviewDisplays(dataDir, shared.deps);
    const rLive = await reg1.openFor(LIVE, { width: 640, height: 480 }); // :90 / 5910
    const rDead = await reg1.openFor(DEAD, { width: 640, height: 480 }); // :91 / 5911
    const rGone = await reg1.openFor(GONE, { width: 640, height: 480 }); // :92 / 5912
    expect([rLive.display, rDead.display, rGone.display]).toEqual([":90", ":91", ":92"]);

    // The DEAD record BEFORE the restart wipes the process world: the sweep
    // must at least PROBE its pids (a dead pid is skipped, never SIGTERM'd).
    const deadRecord = JSON.parse(
      readFileSync(join(dataDir, "display-providers", "xvfb-x11vnc", "displays", DEAD, "display.json"), "utf8"),
    ) as {
      xvfbPid: number;
      x11vncPid: number;
    };

    // Age the dirs past the sweep's launch-window floor: the pass that matters
    // here is about crashes, not races, and the ssh sweep's floor rule is
    // cloned verbatim.
    ageOut(
      join(dataDir, "display-providers", "xvfb-x11vnc", "displays", LIVE),
      join(dataDir, "display-providers", "xvfb-x11vnc", "displays", DEAD),
      join(dataDir, "display-providers", "xvfb-x11vnc", "displays", GONE),
      join(dataDir, "display-providers", "xvfb-x11vnc", "displays", ".display-90.lock"),
      join(dataDir, "display-providers", "xvfb-x11vnc", "displays", ".display-91.lock"),
      join(dataDir, "display-providers", "xvfb-x11vnc", "displays", ".display-92.lock"),
    );

    // The cleared in-memory registry: a NEW instance over the same data dir,
    // with the rfb sockets that survived re-verified (5910 and 5911 still
    // occupied) and GONE's 5912 refusing - the cgroup took it.
    shared.busy.delete(5912);
    shared.alivePids.clear(); // the restart took every child process down with it
    const reg2 = new PreviewDisplays(dataDir, shared.deps);
    expect(reg2.getFor(LIVE)).toBeNull();

    const r = await reg2.sweepOrphans([LIVE, GONE]); // LIVE and GONE's panes survived tmux-wise; DEAD did not

    // LIVE: children alive, so the registry entry comes back from
    // display.json and the ports-style read answers again.
    expect(reg2.getFor(LIVE)).toEqual({ display: ":90", viewer: { protocol: "vnc", port: 5910 } });
    expect(existsSync(join(dataDir, "display-providers", "xvfb-x11vnc", "displays", LIVE))).toBe(true);
    expect(existsSync(join(dataDir, "display-providers", "xvfb-x11vnc", "displays", ".display-90.lock"))).toBe(true);

    // DEAD: reaped, dir and lock gone.
    expect(reg2.getFor(DEAD)).toBeNull();
    expect(existsSync(join(dataDir, "display-providers", "xvfb-x11vnc", "displays", DEAD))).toBe(false);
    expect(existsSync(join(dataDir, "display-providers", "xvfb-x11vnc", "displays", ".display-91.lock"))).toBe(false);

    // GONE: pane alive but children dead -> REAP, not rehydrate. Installing a
    // record for a dead socket would strand the Screen affordance and aim
    // every later openFor at `preview-display-not-ready` forever.
    expect(reg2.getFor(GONE)).toBeNull();
    expect(existsSync(join(dataDir, "display-providers", "xvfb-x11vnc", "displays", GONE))).toBe(false);
    expect(existsSync(join(dataDir, "display-providers", "xvfb-x11vnc", "displays", ".display-92.lock"))).toBe(false);

    expect(r.reaped).toBe(2);
    expect(r.rehydrated).toBe(1);
    // The reap went through the kill seam: DEAD's recorded children were
    // probed (and, being dead, never struck).
    const probed = shared.probes();
    expect(probed).toContain(deadRecord.xvfbPid);
    expect(probed).toContain(deadRecord.x11vncPid);
    const struck = new Set(shared.killPids());
    expect(struck.has(deadRecord.xvfbPid)).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* review round 1: sweep trust, rehydrated death, fresh-entry floor    */
/* ------------------------------------------------------------------ */

describe("review round 1: what the sweep sees", () => {
  it("restores a complete display for a live pane immediately after restart, while the directory is fresh", async () => {
    const dataDir = onDir("fresh-live-rehydrate");
    const shared = makeDeps();
    const original = new PreviewDisplays(dataDir, shared.deps);
    await original.openFor(PANE, { width: 640, height: 480 });
    const restarted = new PreviewDisplays(dataDir, shared.deps);
    await restarted.sweepOrphans([PANE]);
    expect(restarted.getFor(PANE)).toEqual({ display: ":90", viewer: { protocol: "vnc", port: 5910 } });
  });

  it("a rehydrated entry whose recorded child dies is probed, marked lost, and reaped by the next sweep", async () => {
    const dataDir = onDir("round1-rehydrated-death");
    const shared = makeDeps();
    const reg = new PreviewDisplays(dataDir, shared.deps);
    await reg.openFor(PANE, { width: 640, height: 480 });
    const [xvfbPid, vncPid] = shared.spawns().map((s) => s.child.pid);
    ageOut(join(dataDir, "display-providers", "xvfb-x11vnc", "displays", PANE));

    // The daemon restart: a fresh instance over the same data dir, rfb still
    // answering, both recorded pids still alive -> the entry rehydrates.
    const reg2 = new PreviewDisplays(dataDir, shared.deps);
    expect(reg2.getFor(PANE)).toBeNull();
    await reg2.sweepOrphans([PANE]);
    expect(reg2.getFor(PANE)).toEqual({ display: ":90", viewer: { protocol: "vnc", port: 5910 } });

    // x11vnc dies of natural causes afterwards. THIS process has no child
    // handle to watch, so only the sweep's signal-0 probe can notice - and
    // it must, or the registry answers `screen` for a dead server forever.
    shared.alivePids.delete(vncPid);
    await reg2.sweepOrphans([PANE]);

    expect(reg2.getFor(PANE)).toBeNull(); // deregistered
    expect(reg2.lostFor(PANE)).toBe("x11vnc"); // named, like the exit watch would
    expect(existsSync(join(dataDir, "display-providers", "xvfb-x11vnc", "displays", PANE))).toBe(false); // dir reaped
    expect(existsSync(join(dataDir, "display-providers", "xvfb-x11vnc", "displays", ".display-90.lock"))).toBe(false); // lock freed
    expect(shared.killPids()).toContain(xvfbPid); // the surviving Xvfb is not orphaned
    expect(shared.probes()).toContain(vncPid); // it was the probe that saw the death

    // And the ports answer now names the loss through Task 1's validator.
    const seen: unknown[] = [];
    const res = await execPreviewPorts(portsCtx(dataDir, reg2), portsCmd, passthroughScan(seen));
    const parsed = parseNodePreviewPortsResult(res.ok ? res.data : null);
    expect(parsed?.screen).toBeNull();
    expect(parsed?.screenLost).toBe("x11vnc");
  });

  it("closeFor on a pane whose dir is already gone clears the stale lost marker", async () => {
    const dataDir = onDir("round1-belt-clear");
    const { deps, spawns } = makeDeps();
    const reg = new PreviewDisplays(dataDir, deps);
    await reg.openFor(PANE, { width: 640, height: 480 });
    spawns()[1]?.child.fireExit(); // x11vnc dies mid-pane: the watch marks and reaps
    await flush();
    expect(reg.lostFor(PANE)).toBe("x11vnc");

    reg.closeFor(PANE); // a late death report or plane close hits the unregistered belt
    expect(reg.lostFor(PANE)).toBeNull(); // the belt path must clear the marker too
  });

  it("a display registered moments ago survives a sweep whose census does not list its pane, and dies aged", async () => {
    const dataDir = onDir("round1-fresh-floor");
    const { deps, advanceClock } = makeDeps();
    const reg = new PreviewDisplays(dataDir, deps);
    await reg.openFor(PANE, { width: 640, height: 480 });

    // The census raced the launch: the meta row lands after the scan read it,
    // so "absent from this census" is not yet "dead".
    await reg.sweepOrphans([]);
    expect(reg.getFor(PANE)).toEqual({ display: ":90", viewer: { protocol: "vnc", port: 5910 } });
    expect(existsSync(join(dataDir, "display-providers", "xvfb-x11vnc", "displays", PANE))).toBe(true);

    advanceClock(61_000); // past the one-minute fresh-entry floor
    await reg.sweepOrphans([]);
    expect(reg.getFor(PANE)).toBeNull();
    expect(existsSync(join(dataDir, "display-providers", "xvfb-x11vnc", "displays", PANE))).toBe(false);
    expect(existsSync(join(dataDir, "display-providers", "xvfb-x11vnc", "displays", ".display-90.lock"))).toBe(false);
  });

  it("a meta scan that did not complete skips the whole sweep (a live display survives)", async () => {
    const dataDir = onDir("round1-untrusted-census");
    const { deps } = makeDeps();
    const reg = new PreviewDisplays(dataDir, deps);
    await reg.openFor(PANE, { width: 640, height: 480 });
    const { ctx } = makeLaunchCtx(dataDir, reg);
    // A broken scan arrives as an empty census through the old list(); the
    // trust gate reads listComplete and refuses to sweep on it at all. (The
    // ENOTDIR-is-emptiness side is pinned in subshell-meta.test.ts.)
    ctx.meta = { listComplete: async () => ({ metas: [], scanOk: false }) } as unknown as SubshellMetaStore;
    await runDisplaySweep(ctx, reg);
    expect(reg.getFor(PANE)).toEqual({ display: ":90", viewer: { protocol: "vnc", port: 5910 } });
    expect(existsSync(join(dataDir, "display-providers", "xvfb-x11vnc", "displays", PANE))).toBe(true);
    expect(existsSync(join(dataDir, "display-providers", "xvfb-x11vnc", "displays", ".display-90.lock"))).toBe(true);
  });

  it("a TRUSTED empty census still reaps a registered display (the legitimate cleanup direction)", async () => {
    const dataDir = onDir("round1-trusted-census");
    const { deps, advanceClock } = makeDeps();
    const reg = new PreviewDisplays(dataDir, deps);
    await reg.openFor(PANE, { width: 640, height: 480 });
    advanceClock(61_000); // past the fresh-entry floor, so the census alone decides
    const { ctx } = makeLaunchCtx(dataDir, reg);
    ctx.meta = { listComplete: async () => ({ metas: [], scanOk: true }) } as unknown as SubshellMetaStore;
    await runDisplaySweep(ctx, reg);
    expect(reg.getFor(PANE)).toBeNull();
    expect(existsSync(join(dataDir, "display-providers", "xvfb-x11vnc", "displays", PANE))).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* the launch.screen path                                              */
/* ------------------------------------------------------------------ */

describe("the launch.screen path", () => {
  it("opens the display before assembling, injects DISPLAY/XAUTHORITY into the pane env, builds the exit hook from that same env, and echoes screen in the result", async () => {
    const dataDir = onDir("launch-happy");
    const { deps, spawns } = makeDeps();
    const reg = new PreviewDisplays(dataDir, deps);
    const { ctx, calls } = makeLaunchCtx(dataDir, reg);
    let paneCmd = "";
    let hook = "";
    try {
      // Re-stub newSubshell to capture the assembled pane command and hook.
      (ctx.tmux as unknown as { newSubshell: (...a: unknown[]) => void }).newSubshell = (...args: unknown[]) => {
        calls.push({ method: "newSubshell", args });
        paneCmd = String(args[3]);
        hook = String(args[4] ?? "");
      };
      const res = await execLaunch(
        ctx,
        launchCmd({
          screen: { width: 1280, height: 1024 },
          // The preset overrides a REPORTER key: the hook string carries only
          // those three keys, so a preset-sourced value inside it is what
          // proves the hook env came from the full paneEnvFor chain (the one
          // map DISPLAY rides at :267) rather than raw subshellEnv.
          preset: {
            name: "p",
            env: { SUBSHELL_BASE_URL: "http://from-preset" },
            flags: [],
            settings: null,
            configIsolation: false,
          },
        }),
      );
      expect(res).toEqual({ ok: true, data: { screen: { display: ":90", viewer: { protocol: "vnc", port: 5910 } } } });
    } finally {
      // disarm the real exit watcher execLaunch armed, before its first tick
      ctx.watchers.clear();
      clearInterval(ctx.watchTick);
      ctx.watchTick = undefined;
    }
    expect(spawns()).toHaveLength(2);
    expect(paneCmd).toContain("DISPLAY=':90'");
    expect(paneCmd).toContain(`XAUTHORITY='${xauthorityPath(dataDir, PANE)}'`);
    // The death report must be built from the pane's env, not a partial slice
    // of it (launch.ts's parity rule): the hook string is assembled from the
    // SAME paneEnvFor map the pane command is, and the display layer rides
    // that map too. `exitHookFor` keeps only the credential keys in the
    // string, so the observable agreement is the preset-sourced credential
    // showing through; the display-in-the-map property is pinned by the
    // pane-runtime trio (one map, two consumers).
    expect(hook).not.toBe("");
    expect(hook).toContain("SUBSHELL_BASE_URL='http://from-preset'");
    expect(hook).toContain("'exit'");
  });

  it("a display that refuses fails the launch with its named reason and rolls back the meta record", async () => {
    const dataDir = onDir("launch-refuses");
    const { deps } = makeDeps({ which: { Xvfb: null } });
    const reg = new PreviewDisplays(dataDir, deps);
    const { ctx, calls } = makeLaunchCtx(dataDir, reg);
    await expect(execLaunch(ctx, launchCmd({ screen: { width: 640, height: 480 } }))).rejects.toThrow(
      `${PREVIEW_DISPLAY_MISSING_REQUIREMENTS}: Xvfb`,
    );
    expect(calls.some((c) => c.method === "newSubshell")).toBe(false);
    expect(await ctx.meta.get(PANE)).toBeUndefined(); // meta recorded, then forgotten
    expect(existsSync(join(dataDir, "display-providers", "xvfb-x11vnc", "displays", PANE))).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* shared launch-context harness (shape copied from                    */
/* commands-launch.test.ts, trimmed to what these cases exercise)      */
/* ------------------------------------------------------------------ */

interface RecordedCall {
  method: string;
  args: unknown[];
}

function makeLaunchCtx(
  dataDir: string,
  previewDisplays: PreviewDisplays,
): { ctx: CommandContext; calls: RecordedCall[]; events: NodeEvent[] } {
  const calls: RecordedCall[] = [];
  const events: NodeEvent[] = [];
  const method =
    (name: string, impl?: (...a: unknown[]) => unknown) =>
    (...args: unknown[]): unknown => {
      calls.push({ method: name, args });
      if (!impl) throw new Error(`fake tmux: unstubbed call ${name}(${JSON.stringify(args)})`);
      return impl(...args);
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
    tmux: {
      newSubshell: method("newSubshell", () => undefined),
      pipePane: method("pipePane", () => undefined),
      resizeWindow: method("resizeWindow", () => undefined),
      listSubshellsChecked: method("listSubshellsChecked", () => ({ ok: true, names: [] })),
      paneExitCode: method("paneExitCode", () => null),
      killSubshell: method("killSubshell", () => undefined),
      hasSubshell: method("hasSubshell", () => false),
    } as unknown as CommandContext["tmux"],
    meta: new SubshellMetaStore(dataDir),
    nowMs: () => Date.parse("2026-10-22T00:00:00.000Z"),
    ws: { send: (ev) => events.push(ev) },
    watchers: new Map(),
    tails: new Map(),
    uploads: new Map(),
    runtime: null,
    requestRestart: () => {},
    previewDisplays,
  };
  return { ctx, calls, events };
}

type LaunchCmd = Cmd<"launch">;

/** The server-shaped launch frame, screen left to the caller. */
function launchCmd(over: Partial<LaunchCmd> = {}): LaunchCmd {
  return {
    type: "launch",
    subshellId: PANE,
    socket: "subshell-preview-display-test",
    cwd: base,
    harnessId: "claude-code",
    preset: { name: "p", env: {}, flags: [], settings: null, configIsolation: false },
    // The full REPORTER_ENV_KEYS set: `exitHookFor` registers nothing without
    // all three, and the hook is one thing this frame exists to observe (it
    // must carry the same display layer as the pane command).
    subshellEnv: { SUBSHELL_API_KEY: "k", SUBSHELL_BASE_URL: "http://plane.invalid", SUBSHELL_ID: PANE },
    subshellName: "s",
    cols: 120,
    rows: 30,
    argv: [HARNESS_BINARY_PLACEHOLDER],
    resolve: { binaryName: "claude", envOverride: "CLAUDE_PATH" },
    ...over,
  } as unknown as LaunchCmd;
}
