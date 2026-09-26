import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildNodeResetPlan,
  type NodeResetDeps,
  type NodeResetPlan,
  runNodeReset,
  sweepNodePaneSockets,
} from "../reset-cli.js";

/**
 * The node CLI reset/uninstall chain (issue #232), tested against a REAL temp
 * filesystem (the deletions are the feature) with the service facts, the tmux
 * sweep, the lock fact and the plan all injected. Consent is the MACHINE'S
 * name, the constant below.
 */
const MACHINE = "node-reset-test-box";

interface Fixture {
  root: string;
  plan: NodeResetPlan;
  binary: string;
  deps: NodeResetDeps;
  service: { installed: boolean; stops: number; stopFails: boolean; removes: number };
  sweep: { calls: number; failWith?: string };
  live: { pid: number } | null;
}

let fx: Fixture;

beforeEach(() => {
  const root = mkdtempSync(join(tmpdir(), "node-reset-test-"));
  const configHome = join(root, "config-home");
  const dataDir = join(configHome, "data");
  mkdirSync(join(dataDir, "subshells"), { recursive: true });
  mkdirSync(join(configHome, "logs"), { recursive: true });
  mkdirSync(join(root, "bin"), { recursive: true });
  // The agent's own log exists beside the tree, so the chain's log line can
  // claim it STAYED; the swallowed variant repoints agentLog into the data dir.
  writeFileSync(join(configHome, "logs", "agent.log"), "reset happened");
  writeFileSync(join(dataDir, "identity.json"), "{}");
  writeFileSync(join(dataDir, "subshells", "abc.log"), "pane bytes");
  const configJson = join(configHome, "config.json");
  writeFileSync(configJson, JSON.stringify({ dataDir, name: "box-1" }));
  const lockFile = join(configHome, "daemon.lock");
  writeFileSync(
    lockFile,
    JSON.stringify({
      pid: 999999,
      startedAt: "2026-01-01T00:00:00Z",
      nodeId: "n-test",
      lastTickAt: "2026-01-01T00:00:00Z",
    }),
  );
  const binary = join(root, "bin", "subshell");
  writeFileSync(binary, "#!/binary");
  writeFileSync(`${binary}.previous`, "#!/previous");

  fx = {
    root,
    binary,
    plan: {
      configJson,
      lockFile,
      dataDir,
      binary,
      binaryReason: null,
      agentLog: join(configHome, "logs", "agent.log"),
    },
    service: { installed: true, stops: 0, stopFails: false, removes: 0 },
    sweep: { calls: 0 },
    live: null,
    deps: {
      interactive: true,
      machineName: () => MACHINE,
      ask: mock(() => Promise.resolve(MACHINE)),
      askConfirm: mock(() => Promise.resolve(true)),
      plan: () => fx.plan,
      liveDaemon: () => fx.live,
      sweepPanes: () => {
        fx.sweep.calls++;
        return fx.sweep.failWith ? { ok: false, detail: fx.sweep.failWith } : { ok: true };
      },
      service: {
        installed: () => fx.service.installed,
        stop: () => {
          fx.service.stops++;
          return fx.service.stopFails ? { code: 1, err: "the unit refused to stop" } : { code: 0, err: "" };
        },
        remove: () => {
          fx.service.removes++;
          return { code: 0, err: "" };
        },
      },
    },
  };
});

afterEach(() => {
  rmSync(fx.root, { recursive: true, force: true });
});

describe("consent", () => {
  test("a wrong typed machine name changes NOTHING, before any service call", async () => {
    fx.deps.ask = mock(() => Promise.resolve("some-other-box"));
    const r = await runNodeReset({ uninstall: false }, fx.deps);
    expect(r.code).toBe(1);
    expect(r.err).toContain("did not match");
    expect(fx.service.stops).toBe(0);
    expect(existsSync(fx.plan.configJson)).toBe(true);
  });

  test("a machine that cannot name itself grants nothing, typed or scripted", async () => {
    // The Rust twin's consent_granted rule pinned for the CLI: the empty
    // name answers NO question, and `--confirm` with an empty value is the
    // same empty answer, never a wildcard.
    fx.deps.machineName = () => "   ";
    fx.deps.ask = mock(() => Promise.resolve(""));
    const r = await runNodeReset({ uninstall: false }, fx.deps);
    expect(r.code).toBe(1);
    expect(fx.service.stops).toBe(0);
    expect(existsSync(fx.plan.configJson)).toBe(true);
    const r2 = await runNodeReset({ uninstall: false, confirm: "" }, fx.deps);
    expect(r2.code).toBe(1);
    expect(fx.service.stops).toBe(0);
    expect(existsSync(fx.plan.configJson)).toBe(true);
  });

  test("headless without --confirm refuses and names the flag", async () => {
    fx.deps.interactive = false;
    const r = await runNodeReset({ uninstall: false }, fx.deps);
    expect(r.code).toBe(1);
    expect(r.err).toContain("--confirm");
    expect(fx.service.stops).toBe(0);
  });

  test("--confirm <name> is the scripted spelling of the same consent", async () => {
    const r = await runNodeReset({ uninstall: false, confirm: MACHINE }, fx.deps);
    expect(r.code).toBe(0);
    expect((fx.deps.ask as ReturnType<typeof mock>).mock.calls.length).toBe(0);
    expect(existsSync(fx.plan.configJson)).toBe(false);
  });

  test("a cancelled prompt touches nothing", async () => {
    fx.deps.ask = mock(() => Promise.resolve(null));
    const r = await runNodeReset({ uninstall: false }, fx.deps);
    expect(r.code).toBe(1);
    expect(r.err).toContain("cancelled");
    expect(fx.service.stops).toBe(0);
  });
});

describe("the plan's shape guards", () => {
  test("a data dir the rules refuse (root) ends the chain BEFORE consent", async () => {
    fx.plan = { ...fx.plan, dataDir: "/" };
    const r = await runNodeReset({ uninstall: false }, fx.deps);
    expect(r.code).toBe(1);
    expect(r.err).toContain("unsafe path");
    expect((fx.deps.ask as ReturnType<typeof mock>).mock.calls.length).toBe(0);
    expect(existsSync(fx.plan.configJson)).toBe(true);
  });

  test("reset refuses a data dir that contains the binary it promises to keep", async () => {
    fx.plan = { ...fx.plan, binary: join(fx.plan.dataDir, "bin", "subshell") };
    const r = await runNodeReset({ uninstall: false }, fx.deps);
    expect(r.code).toBe(1);
    expect(r.err).toContain("promises to keep");
    expect((fx.deps.ask as ReturnType<typeof mock>).mock.calls.length).toBe(0);
  });

  test("containment through a SYMLINKED data home is refused (the Rust caller rule)", async () => {
    const realDir = join(fx.root, "real-data");
    mkdirSync(join(realDir, "bin"), { recursive: true });
    const nested = join(realDir, "bin", "subshell");
    writeFileSync(nested, "#!/binary");
    const link = join(fx.root, "data-link");
    symlinkSync(realDir, link);
    fx.plan = { ...fx.plan, dataDir: link, binary: nested };
    const r = await runNodeReset({ uninstall: false }, fx.deps);
    expect(r.code).toBe(1);
    expect(r.err).toContain("promises to keep");
    expect(existsSync(nested)).toBe(true);
  });

  test("a SYMLINKED data home is guarded by its TARGET: a link to the home dir is refused", async () => {
    // The reproduced failure: a symlinked dataDir (a routine "moved it to
    // another disk" admin act) whose SPELLING passes the rules while
    // removeTreeBut walks the RESOLVED directory. Guarding the resolved
    // spelling is what closes the back door; the refusal names both.
    const link = join(fx.root, "data-symlink");
    symlinkSync(homedir(), link);
    fx.plan = { ...fx.plan, dataDir: link };
    const r = await runNodeReset({ uninstall: false }, fx.deps);
    expect(r.code).toBe(1);
    expect(r.err).toContain("unsafe path");
    expect(r.err).toContain("->");
    expect((fx.deps.ask as ReturnType<typeof mock>).mock.calls.length).toBe(0);
    expect(fx.service.stops).toBe(0);
    expect(existsSync(join(fx.root, "bin", "subshell"))).toBe(true);
  });

  test("the shape guards cover the lock and the config, not just the data dir", async () => {
    fx.plan = { ...fx.plan, lockFile: "/" };
    const r = await runNodeReset({ uninstall: false }, fx.deps);
    expect(r.code).toBe(1);
    expect(r.err).toContain("unsafe path");
    expect((fx.deps.ask as ReturnType<typeof mock>).mock.calls.length).toBe(0);
  });

  test("a data-keeping uninstall is not blocked by a data dir the guards would refuse", async () => {
    fx.deps.askConfirm = mock(() => Promise.resolve(false));
    fx.plan = { ...fx.plan, dataDir: "/" };
    const r = await runNodeReset({ uninstall: true }, fx.deps);
    expect(r.code).toBe(0);
    expect(r.err).not.toContain("unsafe path");
    expect(existsSync(fx.binary)).toBe(false);
  });
});

describe("the chain (clear-everything after consent)", () => {
  test("reset stops, sweeps, removes the definition, deletes, KEEPS the binary", async () => {
    const r = await runNodeReset({ uninstall: false }, fx.deps);
    expect(r.code).toBe(0);
    expect(fx.service.stops).toBe(1);
    expect(fx.sweep.calls).toBe(1);
    expect(fx.service.removes).toBe(1);
    expect(existsSync(fx.plan.dataDir)).toBe(false);
    expect(existsSync(fx.plan.lockFile)).toBe(false);
    expect(existsSync(fx.plan.configJson)).toBe(false);
    expect(existsSync(fx.binary)).toBe(true);
    expect(r.out).toContain("subshell setup");
    expect(r.out).toContain("agent's own log"); // the record that STAYS is named
  });

  test("a machine with no service definition walks past the absent stop and remove", async () => {
    fx.service.installed = false;
    const r = await runNodeReset({ uninstall: false }, fx.deps);
    expect(r.code).toBe(0);
    expect(fx.service.stops).toBe(0);
    expect(fx.service.removes).toBe(0);
    expect(existsSync(fx.plan.configJson)).toBe(false);
  });

  test("a failed stop is reported and the chain still clears everything", async () => {
    fx.service.stopFails = true;
    const r = await runNodeReset({ uninstall: false }, fx.deps);
    expect(r.code).toBe(1);
    expect(r.err).toContain("did not stop");
    expect(existsSync(fx.plan.configJson)).toBe(false);
    expect(r.err).toContain("finished with failures");
  });

  test("a live hand-started daemon is NAMED, and the clear goes on", async () => {
    fx.live = { pid: 4242 };
    fx.service.installed = false; // no unit to reach it: the exact by-hand shape
    const r = await runNodeReset({ uninstall: false }, fx.deps);
    expect(r.code).toBe(1);
    expect(r.err).toContain("pid 4242");
    expect(existsSync(fx.plan.configJson)).toBe(false);
    expect(existsSync(fx.plan.dataDir)).toBe(false);
    expect(r.err).toContain("finished with failures");
    // The heartbeat survivor writes its lock back under the deletes: the
    // summary may not claim the files are simply gone.
    expect(r.out).toContain("can write some of it back");
    expect(r.out).not.toContain("deleted the data directory (identity and pane logs)");
  });

  test("a stop whose daemon takes a beat to die CONVERGES: no failure, the success line is honest", async () => {
    // macOS `bootout` is async in this codebase's own words: the manager
    // says stopped while the job still unwinds, and the lock clears only on
    // the daemon's exit path. One immediate read would call that success a
    // survivor; the wait must give it time to become true.
    let reads = 0;
    fx.deps.liveDaemon = () => (++reads < 3 ? { pid: 7 } : null);
    fx.deps.sleep = async () => {};
    const r = await runNodeReset({ uninstall: false }, fx.deps);
    expect(r.code).toBe(0);
    expect(r.out).toContain("stopped the node service");
    expect(reads).toBe(3);
  });

  test("a daemon that will not die by the deadline is NAMED after the wait, and the clear goes on", async () => {
    fx.live = { pid: 7 };
    fx.deps.daemonWaitMs = 0; // the wait expires on its first look
    const r = await runNodeReset({ uninstall: false }, fx.deps);
    expect(r.code).toBe(1);
    expect(r.err).toContain("pid 7");
    expect(r.err).toContain("finished with failures");
    expect(existsSync(fx.plan.configJson)).toBe(false);
    expect(existsSync(fx.plan.dataDir)).toBe(false);
  });

  test("a failed stop spends NO settle wait: the lock is read once", async () => {
    // Nothing was commanded down, so there is no promise to wait to become
    // true; the survivor (if any) is named beside the failed stop at once.
    fx.service.stopFails = true;
    let reads = 0;
    fx.deps.liveDaemon = () => {
      reads++;
      return null;
    };
    fx.deps.sleep = () => {
      throw new Error("the failed-stop path must not wait");
    };
    const r = await runNodeReset({ uninstall: false }, fx.deps);
    expect(r.code).toBe(1);
    expect(r.err).toContain("did not stop");
    expect(reads).toBe(1);
  });

  test("a code-0 stop that was really a no-op says ALREADY stopped, not stopped", async () => {
    // service.ts's idempotent stop answers the NOT-LOADED job code 0 with
    // "subshell is already stopped." — converging on it proves nothing was
    // stopped now.
    fx.deps.service = {
      installed: () => true,
      stop: () => ({ code: 0, err: "", out: "subshell is already stopped.\n" }),
      remove: () => ({ code: 0, err: "" }),
    };
    const r = await runNodeReset({ uninstall: false }, fx.deps);
    expect(r.code).toBe(0);
    expect(r.out).toContain("the node service was already stopped");
    expect(r.out).not.toContain("stopped the node service");
  });

  test("a stop's code-0 warning (the pane-safety note) is carried, never silenced", async () => {
    fx.deps.service = {
      installed: () => true,
      stop: () => ({ code: 0, err: "subshell: warning: stopping this service SIGKILLs live panes\n" }),
      remove: () => ({ code: 0, err: "" }),
    };
    const r = await runNodeReset({ uninstall: false }, fx.deps);
    expect(r.code).toBe(0);
    expect(r.err).toContain("SIGKILLs live panes");
  });

  test("a definition that vanished between the probe and the remove says ALREADY GONE", async () => {
    // service.ts answers this case code 0 with "nothing installed" in OUT;
    // printing "removed the service definition" for it would be a lie.
    fx.deps.service = {
      installed: () => true,
      stop: () => ({ code: 0, err: "" }),
      remove: () => ({ code: 0, err: "", out: "nothing installed: no systemd user unit at /x\n" }),
    };
    const r = await runNodeReset({ uninstall: false }, fx.deps);
    expect(r.code).toBe(0);
    expect(r.out).toContain("the service definition was already gone");
    expect(r.out).not.toContain("removed the service definition");
  });

  test("pane survivors are reported and the deletion goes on without them", async () => {
    fx.sweep.failWith = "tmux -L subshell-x kill-server failed";
    const r = await runNodeReset({ uninstall: false }, fx.deps);
    expect(r.code).toBe(1);
    expect(r.err).toContain("pane sweep reported problems");
    expect(existsSync(fx.plan.configJson)).toBe(false);
  });

  test("config.json INSIDE the data dir survives the walk until its own last act", async () => {
    // The custom-dataDir shape where the config home IS the data dir: the
    // tree walk must not recursively take the file the chain's LAST act is
    // named for.
    const shared = join(fx.root, "everywhere");
    mkdirSync(shared, { recursive: true });
    const cfg = join(shared, "config.json");
    writeFileSync(cfg, "{}");
    fx.plan = { ...fx.plan, dataDir: shared, configJson: cfg };
    const r = await runNodeReset({ uninstall: false }, fx.deps);
    expect(r.code).toBe(0);
    expect(existsSync(cfg)).toBe(false);
    expect(existsSync(shared)).toBe(false);
  });
});

describe("the uninstall data question", () => {
  test("answering NO uninstalls the binary and leaves every byte", async () => {
    fx.deps.askConfirm = mock(() => Promise.resolve(false));
    const r = await runNodeReset({ uninstall: true }, fx.deps);
    expect(r.code).toBe(0);
    expect(existsSync(fx.binary)).toBe(false);
    expect(existsSync(`${fx.binary}.previous`)).toBe(false);
    expect(existsSync(fx.plan.configJson)).toBe(true);
    expect(existsSync(fx.plan.dataDir)).toBe(true);
    expect(r.out).toContain("left the data");
  });

  test("--reset-data is the scripted yes: the question seam is never asked", async () => {
    const r = await runNodeReset({ uninstall: true, resetData: true }, fx.deps);
    expect(r.code).toBe(0);
    expect((fx.deps.askConfirm as ReturnType<typeof mock>).mock.calls.length).toBe(0);
    expect(existsSync(fx.plan.configJson)).toBe(false);
    expect(existsSync(fx.binary)).toBe(false);
  });

  test("headless without --reset-data keeps the bytes and names the flag", async () => {
    fx.deps.interactive = false;
    const r = await runNodeReset({ uninstall: true, confirm: MACHINE }, fx.deps);
    expect(r.code).toBe(0);
    expect(existsSync(fx.plan.configJson)).toBe(true);
    expect(existsSync(fx.binary)).toBe(false);
    expect(r.out).toContain("--reset-data");
  });

  test("a cancelled data question changes nothing", async () => {
    fx.deps.askConfirm = mock(() => Promise.resolve(null));
    const r = await runNodeReset({ uninstall: true }, fx.deps);
    expect(r.code).toBe(1);
    expect(r.err).toContain("cancelled");
    expect(fx.service.stops).toBe(0);
    expect(existsSync(fx.binary)).toBe(true);
    expect(existsSync(fx.plan.configJson)).toBe(true);
  });

  test("a log the walk swallowed (its dir IS the data dir) is reported as gone, not left", async () => {
    mkdirSync(join(fx.plan.dataDir, "logs"), { recursive: true });
    const swallowed = join(fx.plan.dataDir, "logs", "agent.log");
    writeFileSync(swallowed, "bytes");
    fx.plan = { ...fx.plan, agentLog: swallowed };
    const r = await runNodeReset({ uninstall: false }, fx.deps);
    expect(r.code).toBe(0);
    expect(r.out).toContain("went with the data directory");
    expect(r.out).not.toContain("left the agent's own log at");
  });

  test("a node that never wrote a log is not CLAIMED to have kept one, nor to have lost one", async () => {
    rmSync(join(fx.root, "config-home", "logs"), { recursive: true, force: true });
    const r = await runNodeReset({ uninstall: false }, fx.deps);
    expect(r.code).toBe(0);
    expect(r.out).not.toContain("agent's own log");
  });

  test("reset never asks: clearing the data IS reset", async () => {
    const r = await runNodeReset({ uninstall: false }, fx.deps);
    expect(r.code).toBe(0);
    expect((fx.deps.askConfirm as ReturnType<typeof mock>).mock.calls.length).toBe(0);
  });

  test("a source checkout (no binary from the ladder) is left alone, reason named", async () => {
    fx.plan = { ...fx.plan, binary: null, binaryReason: "the service runs this agent from a source checkout" };
    const r = await runNodeReset({ uninstall: true, resetData: true }, fx.deps);
    expect(r.code).toBe(0);
    expect(r.out).toContain("source checkout");
  });
});

describe("the tmux sweep", () => {
  test("all three dead-server spellings are LITTER; a real failure is collected without abandoning the rest", () => {
    const tmuxDir = join(fx.root, "tmux-run", `tmux-${process.getuid?.() ?? 0}`);
    mkdirSync(tmuxDir, { recursive: true });
    for (const n of ["subshell-stale", "subshell-angry", "subshell-last"]) writeFileSync(join(tmuxDir, n), "sock");
    const prev = process.env.TMUX_TMPDIR;
    process.env.TMUX_TMPDIR = join(fx.root, "tmux-run");
    try {
      const seen: string[] = [];
      const res = sweepNodePaneSockets(() => {}, ((opts: { cmd: string[] }) => {
        const name = opts.cmd[2];
        seen.push(name);
        if (name === "subshell-stale")
          return { exitCode: 1, stdout: "", stderr: "no server running on /x/subshell-stale" };
        if (name === "subshell-angry") return { exitCode: 1, stdout: "", stderr: "Input/output error" };
        return { exitCode: 0, stdout: "", stderr: "" };
      }) as unknown as typeof Bun.spawnSync);
      expect(existsSync(join(tmuxDir, "subshell-stale"))).toBe(false);
      expect(res.ok).toBe(false);
      expect(res.detail).toContain("subshell-angry");
      expect(seen.slice().sort()).toEqual(["subshell-angry", "subshell-last", "subshell-stale"]);
    } finally {
      if (prev === undefined) delete process.env.TMUX_TMPDIR;
      else process.env.TMUX_TMPDIR = prev;
    }
  });

  test("an absent socket directory is a pass, LOGGED with the directory named", () => {
    const prev = process.env.TMUX_TMPDIR;
    process.env.TMUX_TMPDIR = join(fx.root, "no-such-tmux-dir");
    try {
      const lines: string[] = [];
      const res = sweepNodePaneSockets((l) => lines.push(l));
      expect(res.ok).toBe(true);
      expect(lines.join("\n")).toContain("no-such-tmux-dir");
    } finally {
      if (prev === undefined) delete process.env.TMUX_TMPDIR;
      else process.env.TMUX_TMPDIR = prev;
    }
  });

  test("tmux missing from PATH is a surviving-pane suspicion, never a silent skip", () => {
    const tmuxDir = join(fx.root, "tmux-miss", `tmux-${process.getuid?.() ?? 0}`);
    mkdirSync(tmuxDir, { recursive: true });
    writeFileSync(join(tmuxDir, "subshell-dead"), "sock");
    const prev = process.env.TMUX_TMPDIR;
    process.env.TMUX_TMPDIR = join(fx.root, "tmux-miss");
    try {
      const res = sweepNodePaneSockets(() => {}, (() => {
        throw new Error("posix_spawn failed");
      }) as unknown as typeof Bun.spawnSync);
      expect(res.ok).toBe(false);
      expect(res.detail).toContain("subshell-dead");
    } finally {
      if (prev === undefined) delete process.env.TMUX_TMPDIR;
      else process.env.TMUX_TMPDIR = prev;
    }
  });
});

describe("the plan reads the places status reads", () => {
  test("buildNodeResetPlan follows SUBSHELL_CONFIG_HOME, config dataDir, and the hostname-free paths", async () => {
    const prevHome = process.env.SUBSHELL_CONFIG_HOME;
    process.env.SUBSHELL_CONFIG_HOME = join(fx.root, "env-home");
    try {
      // Unenrolled: the default data home is still this role's litter.
      const empty = await buildNodeResetPlan();
      expect(empty.configJson).toBe(join(fx.root, "env-home", "config.json"));
      expect(empty.dataDir).toBe(join(fx.root, "env-home", "data"));
      // Enrolled: config.json's dataDir wins.
      mkdirSync(join(fx.root, "env-home"), { recursive: true });
      writeFileSync(join(fx.root, "env-home", "config.json"), JSON.stringify({ dataDir: join(fx.root, "elsewhere") }));
      const full = await buildNodeResetPlan();
      expect(full.dataDir).toBe(join(fx.root, "elsewhere"));
      // The binary may or may not resolve on the test host; only the SHAPE is pinned.
      expect(full.binary === null ? typeof full.binaryReason : typeof full.binary).toBe("string");
      expect(full.agentLog.length > 1).toBe(true);
    } finally {
      if (prevHome === undefined) delete process.env.SUBSHELL_CONFIG_HOME;
      else process.env.SUBSHELL_CONFIG_HOME = prevHome;
    }
  });
});
