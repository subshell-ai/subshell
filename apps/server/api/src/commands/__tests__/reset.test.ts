import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { serverPaths } from "../../services/server-paths.js";
import { buildResetPlan, type ResetDeps, type ResetPlan, runReset, sweepPaneSockets } from "../reset.js";

/**
 * The CLI reset/uninstall chain (issue #232), tested against a REAL temp
 * filesystem (the deletions are the feature) with the manager, the tmux sweep,
 * and the plan all injected. The machine name is the constant below.
 */
const MACHINE = "reset-test-box";

interface Fixture {
  root: string;
  plan: ResetPlan;
  /** The non-null binary path the fixture lays down, for the assertions. */
  binary: string;
  deps: ResetDeps & { lines: string[]; errors: string[] };
  manager: { installed: boolean; stops: number; stopFails: boolean; uninstalls: number };
  sweep: { calls: number; failWith?: string };
}

let fx: Fixture;

beforeEach(() => {
  const root = mkdtempSync(join(tmpdir(), "reset-test-"));
  const dataDir = join(root, "data");
  const configDir = join(root, "config");
  const configEnv = join(configDir, "config.env");
  mkdirSync(join(dataDir, "logs"), { recursive: true });
  mkdirSync(join(dataDir, "artifacts"), { recursive: true });
  mkdirSync(join(dataDir, "backups"), { recursive: true });
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(dataDir, "subshell.db"), "db");
  writeFileSync(join(dataDir, "logs", "subshell-abc.log"), "pane bytes");
  writeFileSync(join(dataDir, "artifacts", "bin"), "artifact");
  writeFileSync(configEnv, "SERVER_PORT=3080\n");
  const binary = join(root, "subshell-server");
  writeFileSync(binary, "#!/binary");
  writeFileSync(`${binary}.previous`, "#!/previous");

  const lines: string[] = [];
  const errors: string[] = [];
  const manager = { installed: true, stops: 0, stopFails: false, uninstalls: 0 };
  const sweep: { calls: number; failWith?: string } = { calls: 0 };
  fx = {
    root,
    binary,
    plan: {
      configEnv,
      dataDir,
      database: join(dataDir, "subshell.db"),
      logsDir: join(dataDir, "logs"),
      nodeArtifacts: join(dataDir, "artifacts"),
      binary,
      listenPort: 0,
    },
    manager,
    sweep,
    deps: {
      log: (l) => lines.push(l),
      error: (l) => errors.push(l),
      isTTY: true,
      machineName: () => MACHINE,
      plan: () => fx.plan,
      ask: mock(() => Promise.resolve(MACHINE)),
      // Default: the port is quiet (the chain proceeds) and no real sleep.
      probePort: () => false,
      sleep: async () => {},
      manager: {
        installed: () => manager.installed,
        stop: () => {
          manager.stops++;
          return manager.stopFails ? { code: 1, err: "the port refused to go quiet" } : { code: 0, err: "" };
        },
        uninstall: () => {
          manager.uninstalls++;
          return { code: 0, err: "" };
        },
      },
      sweepPanes: () => {
        sweep.calls++;
        return sweep.failWith ? { ok: false, detail: sweep.failWith } : { ok: true };
      },
      lines,
      errors,
    },
  };
});

afterEach(() => {
  rmSync(fx.root, { recursive: true, force: true });
});

const typedAsk = (answer: string | null) => {
  fx.deps.ask = mock(() => Promise.resolve(answer));
};

describe("consent", () => {
  test("a wrong typed machine name changes NOTHING, before any manager call", async () => {
    typedAsk("some-other-box");
    const code = await runReset({ uninstall: false }, fx.deps);
    expect(code).toBe(1);
    expect(fx.deps.errors.join("\n")).toContain("did not match");
    expect(fx.manager.stops).toBe(0);
    expect(existsSync(fx.plan.database)).toBe(true);
    expect(existsSync(fx.plan.configEnv)).toBe(true);
  });

  test("a cancelled prompt refuses by name and touches nothing", async () => {
    typedAsk(null);
    const code = await runReset({ uninstall: false }, fx.deps);
    expect(code).toBe(1);
    expect(fx.deps.errors.join("\n")).toContain("cancelled");
    expect(fx.manager.stops).toBe(0);
  });

  test("headless without --confirm refuses and names the flag", async () => {
    fx.deps.isTTY = false;
    const code = await runReset({ uninstall: false }, fx.deps);
    expect(code).toBe(1);
    expect(fx.deps.errors.join("\n")).toContain("--confirm");
    expect(fx.manager.stops).toBe(0);
  });

  test("--confirm <name> is the scripted spelling of the same consent", async () => {
    const code = await runReset({ uninstall: false, confirm: MACHINE }, fx.deps);
    expect(code).toBe(0);
    // The prompt seam was never asked.
    expect((fx.deps.ask as ReturnType<typeof mock>).mock.calls.length).toBe(0);
    expect(existsSync(fx.plan.database)).toBe(false);
  });

  test("--confirm with the WRONG name is still a mismatch", async () => {
    const code = await runReset({ uninstall: false, confirm: "not-this-box" }, fx.deps);
    expect(code).toBe(1);
    expect(existsSync(fx.plan.database)).toBe(true);
  });
});

describe("the chain", () => {
  test("reset stops, sweeps, uninstalls the definition, deletes data, KEEPS the binary", async () => {
    const code = await runReset({ uninstall: false }, fx.deps);
    expect(code).toBe(0);
    expect(fx.manager.stops).toBe(1);
    expect(fx.sweep.calls).toBe(1);
    expect(fx.manager.uninstalls).toBe(1);
    expect(existsSync(fx.plan.database)).toBe(false);
    expect(existsSync(fx.plan.logsDir)).toBe(false);
    expect(existsSync(fx.plan.nodeArtifacts)).toBe(false);
    expect(existsSync(fx.plan.configEnv)).toBe(false);
    // The tidies: both homes are empty by now, so both went.
    expect(existsSync(fx.plan.dataDir)).toBe(false);
    // The one promise reset makes about the binary: it survives.
    expect(existsSync(fx.binary)).toBe(true);
    expect(fx.deps.lines.join("\n")).toContain("init");
  });

  test("a machine with no service definition walks past the absent stop and uninstall", async () => {
    fx.manager.installed = false;
    const code = await runReset({ uninstall: false }, fx.deps);
    expect(code).toBe(0);
    expect(fx.manager.stops).toBe(0);
    expect(fx.manager.uninstalls).toBe(0);
    expect(existsSync(fx.plan.database)).toBe(false);
    expect(fx.deps.lines.join("\n")).toContain("no service definition");
  });

  test("a failed stop ends the chain with every byte left", async () => {
    fx.manager.stopFails = true;
    const code = await runReset({ uninstall: false }, fx.deps);
    expect(code).toBe(1);
    expect(fx.sweep.calls).toBe(0);
    expect(existsSync(fx.plan.database)).toBe(true);
    expect(existsSync(fx.plan.configEnv)).toBe(true);
  });

  test("a surviving pane server ends the chain BEFORE any deletion", async () => {
    fx.sweep.failWith = "tmux -L subshell-x kill-server failed";
    const code = await runReset({ uninstall: false }, fx.deps);
    expect(code).toBe(1);
    expect(fx.manager.uninstalls).toBe(0);
    expect(existsSync(fx.plan.database)).toBe(true);
    expect(fx.deps.errors.join("\n")).toContain("pane server survived");
  });
});

describe("deletion shape", () => {
  test("config.env nested INSIDE dataDir survives the tree walk and is deleted last", async () => {
    // The documented non-default layout: config home and data home are one
    // directory. The walk must skip the kept file, and the consent covers its
    // deletion as the chain's LAST act.
    const nested = join(fx.plan.dataDir, "config.env");
    writeFileSync(nested, "SERVER_PORT=3080\n");
    fx.plan = { ...fx.plan, configEnv: nested };
    const code = await runReset({ uninstall: false }, fx.deps);
    expect(code).toBe(0);
    expect(existsSync(nested)).toBe(false);
    expect(existsSync(join(fx.plan.dataDir, "logs"))).toBe(false);
    expect(existsSync(fx.plan.dataDir)).toBe(false);
  });

  test("a surviving third file in a shared config home keeps that home on disk", async () => {
    const stranger = join(dirname(fx.plan.configEnv), "someone-else.txt");
    writeFileSync(stranger, "not ours");
    const code = await runReset({ uninstall: false }, fx.deps);
    expect(code).toBe(0);
    expect(existsSync(stranger)).toBe(true);
    expect(existsSync(dirname(fx.plan.configEnv))).toBe(true);
  });
});

describe("uninstall", () => {
  test("uninstall removes the binary AND the .previous an update left", async () => {
    const code = await runReset({ uninstall: true }, fx.deps);
    expect(code).toBe(0);
    expect(existsSync(fx.binary)).toBe(false);
    expect(existsSync(`${fx.binary}.previous`)).toBe(false);
    expect(fx.deps.lines.join("\n")).toContain("uninstalled");
  });

  test("a source checkout (no installed binary) is left alone, named out loud", async () => {
    fx.plan = { ...fx.plan, binary: null };
    const code = await runReset({ uninstall: true }, fx.deps);
    expect(code).toBe(0);
    expect(existsSync(join(fx.root, "subshell-server"))).toBe(true);
    expect(fx.deps.lines.join("\n")).toContain("checkout");
  });

  test("an uninstall that cannot remove the binary ends non-zero with the data already gone", async () => {
    unlinkSync(fx.binary);
    mkdirSync(fx.binary, { recursive: true }); // unlinkSync on a directory fails
    const code = await runReset({ uninstall: true }, fx.deps);
    expect(code).toBe(1);
    expect(fx.deps.errors.join("\n")).toContain("binary");
  });
});

describe("the plan authority", () => {
  test("buildResetPlan reads the SAME paths the status view publishes", () => {
    // Not a second source, checked: status.ts's paths block and this plan
    // both read serverPaths(), so equality here IS the single-source fact.
    // The config and data homes are pinned to the fixture's temp dirs so the
    // developer's real ~/.config/subshell-server/config.env is never read
    // (the suite's own rule: ambient state stays out of the plan's view).
    const prevCfg = process.env.SUBSHELL_SERVER_CONFIG_DIR;
    const prevData = process.env.SUBSHELL_SERVER_DATA_DIR;
    process.env.SUBSHELL_SERVER_CONFIG_DIR = dirname(fx.plan.configEnv);
    process.env.SUBSHELL_SERVER_DATA_DIR = fx.plan.dataDir;
    let plan: ResetPlan;
    let paths: ReturnType<typeof serverPaths>;
    try {
      plan = buildResetPlan();
      paths = serverPaths();
    } finally {
      if (prevCfg === undefined) delete process.env.SUBSHELL_SERVER_CONFIG_DIR;
      else process.env.SUBSHELL_SERVER_CONFIG_DIR = prevCfg;
      if (prevData === undefined) delete process.env.SUBSHELL_SERVER_DATA_DIR;
      else process.env.SUBSHELL_SERVER_DATA_DIR = prevData;
    }
    expect(plan.dataDir).toBe(paths.dataDir);
    expect(plan.database).toBe(paths.database);
    expect(plan.logsDir).toBe(paths.logsDir);
    expect(plan.nodeArtifacts).toBe(paths.nodeArtifacts);
    expect(plan.configEnv.endsWith("config.env")).toBe(true);
    // A malformed SERVER_PORT plans port 0 (nobody's listener), never a
    // plausible one: the range check is the same rule status reports.
    expect(plan.listenPort >= 0 && plan.listenPort < 65_536).toBe(true);
  });
});

describe("the plan's shape guards (issue #232 review)", () => {
  test("a data dir the rules refuse (root) ends the chain BEFORE consent", async () => {
    fx.plan = { ...fx.plan, dataDir: "/" };
    const code = await runReset({ uninstall: false }, fx.deps);
    expect(code).toBe(1);
    expect(fx.deps.errors.join("\n")).toContain("unsafe path");
    // The prompt seam was never asked: nobody types a name at an unsafe plan.
    expect((fx.deps.ask as ReturnType<typeof mock>).mock.calls.length).toBe(0);
    expect(fx.manager.stops).toBe(0);
    expect(existsSync(fx.plan.database)).toBe(true);
  });

  test("a mistyped data dir that IS the home directory is refused too", async () => {
    fx.plan = { ...fx.plan, dataDir: homedir() };
    const code = await runReset({ uninstall: false }, fx.deps);
    expect(code).toBe(1);
    expect(fx.deps.errors.join("\n")).toContain("unsafe path");
    expect(existsSync(fx.plan.database)).toBe(true);
  });

  test("reset refuses a data dir that contains the binary it promises to keep", async () => {
    // The Rust `delete_guard_ok` case: a `~/.local` data dir with the binary
    // at `~/.local/bin/subshell-server` would rm -rf its own promise.
    fx.plan = { ...fx.plan, binary: join(fx.plan.dataDir, "bin", "subshell-server") };
    const code = await runReset({ uninstall: false }, fx.deps);
    expect(code).toBe(1);
    expect(fx.deps.errors.join("\n")).toContain("promises to keep");
    expect((fx.deps.ask as ReturnType<typeof mock>).mock.calls.length).toBe(0);
    expect(existsSync(fx.plan.database)).toBe(true);
  });

  test("the same shape is LEGAL for uninstall: the binary is going anyway", async () => {
    const nested = join(fx.plan.dataDir, "bin", "subshell-server");
    mkdirSync(dirname(nested), { recursive: true });
    writeFileSync(nested, "#!/binary");
    fx.plan = { ...fx.plan, binary: nested };
    const code = await runReset({ uninstall: true }, fx.deps);
    expect(code).toBe(0);
    // The tree walk took it with the data dir; the chain says so, not throws.
    expect(existsSync(nested)).toBe(false);
    expect(fx.deps.lines.join("\n")).toContain("went with the data directory");
  });

  test("containment through a SYMLINKED data home is refused (the Rust caller rule)", async () => {
    // Lexical spellings say disjoint, the inodes say one: dataDir is a
    // symlink whose resolved root contains the binary. The walk deletes the
    // RESOLVED dir, so the guard must compare resolved spellings too.
    const realDir = join(fx.root, "real-data");
    mkdirSync(join(realDir, "bin"), { recursive: true });
    const nested = join(realDir, "bin", "subshell-server");
    writeFileSync(nested, "#!/binary");
    const link = join(fx.root, "data-link");
    symlinkSync(realDir, link);
    fx.plan = { ...fx.plan, dataDir: link, binary: nested };
    const code = await runReset({ uninstall: false }, fx.deps);
    expect(code).toBe(1);
    expect(fx.deps.errors.join("\n")).toContain("promises to keep");
    expect(existsSync(nested)).toBe(true);
  });
});

describe("the port that must go quiet", () => {
  test("a port still answering after the stop deletes NOTHING", async () => {
    // A daemon started BY HAND has no unit this verb can reach: the port
    // answering is the fact, and the chain refuses on it (the desktop's
    // `wait_for_port_closed`, mirrored). portWaitMs 0 = no waiting at all.
    fx.plan = { ...fx.plan, listenPort: 31997 };
    fx.deps.probePort = () => true;
    fx.deps.portWaitMs = 0;
    const code = await runReset({ uninstall: false }, fx.deps);
    expect(code).toBe(1);
    expect(fx.deps.errors.join("\n")).toContain("still answering");
    expect(existsSync(fx.plan.database)).toBe(true);
    expect(existsSync(fx.plan.configEnv)).toBe(true);
    // The ORDER pin (round-2 review): the refusal comes before the sweep and
    // before the definition removal. A live daemon's panes are still running,
    // and "nothing was deleted" must also mean "nothing was disturbed".
    expect(fx.sweep.calls).toBe(0);
    expect(fx.manager.uninstalls).toBe(0);
  });

  test("a port that goes quiet within the wait proceeds with the deletes", async () => {
    fx.plan = { ...fx.plan, listenPort: 31997 };
    let probes = 0;
    fx.deps.probePort = () => ++probes < 3; // answering, answering, then quiet
    fx.deps.portWaitMs = 5_000;
    const code = await runReset({ uninstall: false }, fx.deps);
    expect(code).toBe(0);
    expect(probes).toBe(3);
    expect(existsSync(fx.plan.database)).toBe(false);
  });
});

describe("deeper keep chains", () => {
  test("a config home NESTED TWO LEVELS inside the data dir survives until its own turn", async () => {
    // The regression the review named: the first walk version only spared a
    // DIRECT child. `<dataDir>/config/config.env` must not have its parent
    // subtree rm -rf'd mid-walk: the chain's LAST act deletes config.env,
    // and a mid-chain failure has to leave the machine still self-describing.
    const nested = join(fx.plan.dataDir, "config", "home", "config.env");
    mkdirSync(dirname(nested), { recursive: true });
    writeFileSync(nested, "SERVER_PORT=3080\n");
    fx.plan = { ...fx.plan, configEnv: nested };
    const code = await runReset({ uninstall: false }, fx.deps);
    expect(code).toBe(0);
    expect(existsSync(nested)).toBe(false);
    expect(existsSync(join(fx.plan.dataDir, "logs"))).toBe(false);
    // The keep chain's mid ancestors were empty by the last act, and the
    // tidy prunes them all the way up, so the data home itself goes too.
    expect(existsSync(join(fx.plan.dataDir, "config"))).toBe(false);
    expect(existsSync(fx.plan.dataDir)).toBe(false);
  });
});

describe("the tmux sweep", () => {
  test("tmux missing from PATH is a SURVIVING-PANE refusal, not a silent skip", () => {
    // Sockets on disk mean panes ran HERE; a spawn that cannot even start
    // must end the chain (the round-1 crash was a raw throw out of the CLI).
    const tmuxDir = join(fx.root, "tmux-run", `tmux-${process.getuid?.() ?? 0}`);
    mkdirSync(tmuxDir, { recursive: true });
    writeFileSync(join(tmuxDir, "subshell-dead"), "socket");
    const prev = process.env.TMUX_TMPDIR;
    process.env.TMUX_TMPDIR = join(fx.root, "tmux-run");
    try {
      const res = sweepPaneSockets(() => {}, (() => {
        throw new Error("posix_spawn failed: no such file or directory");
      }) as unknown as typeof Bun.spawnSync);
      expect(res.ok).toBe(false);
      expect(res.detail).toContain("subshell-dead");
    } finally {
      if (prev === undefined) delete process.env.TMUX_TMPDIR;
      else process.env.TMUX_TMPDIR = prev;
    }
  });

  test("an absent socket directory is a pass, LOGGED with the directory named", () => {
    // A wrong TMUX_TMPDIR and a true-empty one must be distinguishable
    // afterward; the silent zero-kill is the defect the desktop measured.
    const prev = process.env.TMUX_TMPDIR;
    process.env.TMUX_TMPDIR = join(fx.root, "no-such-tmux-dir");
    try {
      const lines: string[] = [];
      const res = sweepPaneSockets((l) => lines.push(l));
      expect(res.ok).toBe(true);
      expect(lines.join("\n")).toContain("no-such-tmux-dir");
    } finally {
      if (prev === undefined) delete process.env.TMUX_TMPDIR;
      else process.env.TMUX_TMPDIR = prev;
    }
  });
});
