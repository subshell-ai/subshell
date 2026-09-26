import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { type CliDeps, dispatchCli, parseUpdateFlags } from "../cli.js";
import { acquirePromptInput, type TtyIo } from "../commands/tty-input.js";
import { DATABASE_PATH, SUBSHELL_PLUGIN_REGISTRY_URL, SUBSHELL_SERVER_DATA_DIR } from "../constants.js";
import { consoleVerbose, setConsoleVerbose } from "../utils/logger.js";

/**
 * Save/restore guard for env-mutating tests (client `config.test.ts` idiom)
 * — `status` reads the whole config ladder, so these suites pin every key
 * they touch and restore all of them in `finally`.
 */
function withEnv<T>(vars: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const saved = new Map<string, string | undefined>();
  for (const key of Object.keys(vars)) saved.set(key, process.env[key]);
  const apply = () => {
    for (const [key, value] of Object.entries(vars)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
  try {
    apply();
  } catch (err) {
    restore();
    throw err;
  }
  function restore() {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
  return fn().finally(restore);
}

function newConfigDir(): string {
  return mkdtempSync(join(tmpdir(), `subshell-cli-test-${process.pid}-`));
}

/** Collecting CliDeps: stdout/stderr lines, exit codes, canned port probe. */
function collectingDeps(overrides: Partial<CliDeps> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const exits: number[] = [];
  const deps: CliDeps = {
    log: (line) => out.push(line),
    error: (line) => err.push(line),
    exit: (code) => exits.push(code),
    probePort: () => false,
    ...overrides,
  };
  return { deps, out, err, exits };
}

describe("dispatchCli — boot-path passthrough", () => {
  test("no argv → false (boot the server)", async () => {
    const { deps, out, err } = collectingDeps();
    expect(await dispatchCli([], deps)).toBe(false);
    expect(out).toEqual([]);
    expect(err).toEqual([]);
  });

  test("a leading flag is NOT a subcommand → false (systemd boot form)", async () => {
    const { deps } = collectingDeps();
    expect(await dispatchCli(["--help"], deps)).toBe(false);
    expect(await dispatchCli(["-v", "extra"], deps)).toBe(false);
  });

  // The 2026-09-26 extension of pre-boot recognition: `--verbose` is the one
  // leading flag that is RECOGNIZED (it raises this process's console
  // transport) WITHOUT the pinned contract changing — a leading flag is
  // still boot, `dispatchCli` still returns false.
  test("leading --verbose is recognized pre-boot and still returns false (boot path intact)", async () => {
    const { deps } = collectingDeps();
    expect(consoleVerbose()).toBe(false);
    try {
      expect(await dispatchCli(["--verbose"], deps)).toBe(false);
      expect(consoleVerbose()).toBe(true);
    } finally {
      setConsoleVerbose(false); // the logger is one module per test process
    }
    expect(consoleVerbose()).toBe(false);
  });

  test("--verbose after a non-verbose leading flag is still no one's business (unknown leading flag boots)", async () => {
    const { deps } = collectingDeps();
    expect(await dispatchCli(["--help", "--verbose"], deps)).toBe(false);
    expect(consoleVerbose()).toBe(false);
  });
});

/**
 * `--verbose` (operator addendum 2026-09-26): console-only debug for the
 * life of the process. The logger is a module singleton and `IS_TEST`
 * disables EMISSION, so what these can pin is the level gate the flag moves
 * (read back through `consoleVerbose()`) and nothing that emits.
 */
describe("dispatchCli — --verbose (2026-09-26)", () => {
  test("init --verbose parses (it used to be an unknown flag) and raises the console", async () => {
    const h = initHandoffHarness();
    try {
      expect(await dispatchCli(["init", "--yes", "--no-service", "--verbose"], h.deps)).toBe(true);
      expect(h.exits).toEqual([0]);
      expect(consoleVerbose()).toBe(true);
    } finally {
      setConsoleVerbose(false);
    }
  });

  test("update --verbose --json is REFUSED: JSON on stdout and debug lines are mutually exclusive", async () => {
    const { deps, err, exits } = collectingDeps();
    expect(await dispatchCli(["update", "--verbose", "--json"], deps)).toBe(true);
    expect(exits).toEqual([1]);
    expect(err.join("\n")).toMatch(/--verbose and --json are mutually exclusive/);
    // Refused BEFORE raising: the refusal itself must not arrive as debug spam.
    expect(consoleVerbose()).toBe(false);
  });

  test("service status accepts --verbose; --verbose + --json is refused the same way", async () => {
    try {
      const ok = collectingDeps({ platform: "linux", home: "/home/nobody-here" });
      expect(await dispatchCli(["service", "status", "--verbose"], ok.deps)).toBe(true);
      expect(ok.exits).toEqual([0]);
      expect(consoleVerbose()).toBe(true);
      setConsoleVerbose(false);

      const bad = collectingDeps({ platform: "linux", home: "/home/nobody-here" });
      expect(await dispatchCli(["service", "status", "--verbose", "--json"], bad.deps)).toBe(true);
      expect(bad.exits).toEqual([1]);
      expect(bad.err.join("\n")).toMatch(/--verbose and --json are mutually exclusive/);
      expect(consoleVerbose()).toBe(false);
    } finally {
      setConsoleVerbose(false);
    }
  });

  test("status --verbose is a usage error: status is NOT on the accepted set (its view must not need the flag)", async () => {
    const { deps, err, exits } = collectingDeps();
    expect(await dispatchCli(["status", "--verbose"], deps)).toBe(true);
    expect(exits).toEqual([1]);
    expect(err.join("\n")).toContain("unexpected argument '--verbose'");
  });

  test("usage lists the flag", async () => {
    const { deps, err } = collectingDeps();
    await dispatchCli(["frobnicate"], deps);
    expect(err.join("\n")).toContain("--verbose");
  });
});

describe("dispatchCli — pane-log (the pipe-pane capture child)", () => {
  // The argv contract TmuxRunner.pipePane builds against. Only NON-BLOCKING
  // paths run in-process: a well-formed absolute path would make the verb read
  // this test process's stdin for a pane that never writes (the streaming and
  // success paths live in pane-runtime's pane-log.test.ts and the node CLI's
  // cli-panlog.test.ts, which spawn a child).
  test("missing --file, a flag-as-path, a bare positional, and a relative path all refuse with exit 1", async () => {
    const { deps, err, exits } = collectingDeps();
    expect(await dispatchCli(["pane-log"], deps)).toBe(true);
    // The old indexOf-based parse would have taken `--force` as the path.
    expect(await dispatchCli(["pane-log", "--file", "--force"], deps)).toBe(true);
    expect(await dispatchCli(["pane-log", "rel.log"], deps)).toBe(true);
    expect(await dispatchCli(["pane-log", "--file", "rel.log"], deps)).toBe(true);
    expect(exits).toEqual([1, 1, 1, 1]);
    expect(err.join("\n")).toMatch(/pane-log requires --file <absolute path>/);
  });

  test("an absolute path whose open fails exits 1 with the errno, without reading stdin", async () => {
    const { deps, err, exits } = collectingDeps();
    expect(await dispatchCli(["pane-log", "--file", "/nonexistent-dir-panlog-test/pane.log"], deps)).toBe(true);
    expect(exits).toEqual([1]);
    expect(err.join("\n")).toMatch(/pane-log: .*(ENOENT|no such file)/i);
  });
});

describe("dispatchCli — version", () => {
  // The server binary ships bare too (a GitHub Release asset, or a file
  // copied onto a host), so `license` is its accompanying licence file.
  test("license prints the copyright, both halves of the split, and the URL", async () => {
    const { deps, out, err, exits } = collectingDeps();
    expect(await dispatchCli(["license"], deps)).toBe(true);
    expect(err).toEqual([]);
    expect(exits).toEqual([0]);
    const text = out.join("\n");
    expect(text).toContain("Copyright 2026 Disaresta, LLC");
    expect(text).toContain("AGPL-3.0-only");
    expect(text).toContain("Apache-2.0");
    expect(text).toContain("https://github.com/subshell-ai/subshell/blob/main/LICENSE");
    expect(text.split("\n")[0]).toMatch(/^subshell-server \d+\.\d+\.\d+$/);
  });

  // `version` is compared for EXACT equality by the release smoke
  // (.github/workflows/release.yml), so it must stay one bare line — that
  // constraint is the reason `license` exists separately at all.
  test("version stays exactly one line and gains nothing from license", async () => {
    const { deps, out } = collectingDeps();
    expect(await dispatchCli(["version"], deps)).toBe(true);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatch(/^subshell-server \d+\.\d+\.\d+$/);
    expect(out[0]).not.toContain("Copyright");
  });

  test("prints `subshell-server <package.json version>` and reports handled", async () => {
    const { deps, out, err, exits } = collectingDeps();
    expect(await dispatchCli(["version"], deps)).toBe(true);
    expect(out).toHaveLength(1);
    // The value must come from package.json — assert the shape (a real
    // semver), not a copy of the constant.
    expect(out[0]).toMatch(/^subshell-server \d+\.\d+\.\d+/);
    expect(err).toEqual([]);
    // A handled command exits synchronously through deps.exit(0) — Bun runs
    // the rest of the entry graph during ANY suspended TLA, so the binary's
    // handled path must never yield (see cli.ts invariants).
    expect(exits).toEqual([0]);
  });
});

describe("dispatchCli — report", () => {
  test("report forwards its verb words to the runner and exits 0", async () => {
    const seen: string[][] = [];
    const { deps, err, exits } = collectingDeps({
      reportRun: async (argv: string[]) => {
        seen.push(argv);
      },
    });

    expect(await dispatchCli(["report", "attention", "turn_complete"], deps)).toBe(true);
    expect(seen).toEqual([["attention", "turn_complete"]]);
    expect(err).toEqual([]);
    // Harness hooks read this exit code: a non-zero one prints into the
    // user's session, which is the whole failure mode `report` exists to end.
    expect(exits).toEqual([0]);
  });

  test("report exits 0 even when the runner rejects — a hook never prints", async () => {
    const { deps, err, exits } = collectingDeps({
      reportRun: async () => {
        throw new Error("ECONNREFUSED");
      },
    });

    expect(await dispatchCli(["report", "session"], deps)).toBe(true);
    expect(err).toEqual([]);
    expect(exits).toEqual([0]);
  });
});

describe("dispatchCli — mcp", () => {
  test("mcp runs the injected stdio server, then PARKS — nothing exits on attach (T18)", async () => {
    let calls = 0;
    const { deps, exits } = collectingDeps({
      mcpRun: async () => {
        calls++;
      },
    });
    // The fake runner resolves immediately (that is what connect() does);
    // dispatch must NOT: exiting — or even resolving `true`, which
    // cli-bootstrap's `.then(handled ⇒ exit 0)` would act on — kills a live
    // stdio transport milliseconds after `ready` (apps/node/agent's T18 lesson;
    // e2e-cross-subshell.test.ts owns the real two-process proof). The
    // parked promise means the transport owns the process lifetime.
    let settled = false;
    void dispatchCli(["mcp"], deps).then(() => {
      settled = true;
    });
    await Bun.sleep(50);
    expect(calls).toBe(1); // the runner ran
    expect(exits).toEqual([]); // nothing exited
    expect(settled).toBe(false); // dispatch stays parked, forever, by design
  });

  test("mcp refusal lands on stderr and exits 1 — never falls through to success", async () => {
    const { deps, err, exits } = collectingDeps({
      mcpRun: async () => {
        throw new Error("subshell mcp: SUBSHELL_API_KEY is not set");
      },
    });
    expect(await dispatchCli(["mcp"], deps)).toBe(true);
    // MESSAGE-first formatting (compiled bundles drop the stack header — see
    // cli.ts), and exactly one exit: the catch must not fall through to the
    // success `exit(0)` behind it.
    expect(err.join("\n")).toContain("SUBSHELL_API_KEY");
    expect(exits).toEqual([1]);
  });
});

describe("dispatchCli — unknown subcommand", () => {
  test("usage to stderr + exit(1), reported as handled (boot must NOT proceed)", async () => {
    const { deps, out, err, exits } = collectingDeps();
    expect(await dispatchCli(["frobnicate"], deps)).toBe(true);
    expect(out).toEqual([]);
    expect(err.join("\n")).toContain("unknown command 'frobnicate'");
    expect(err.join("\n")).toContain("usage:");
    expect(exits).toEqual([1]);
  });
});

describe("dispatchCli — status", () => {
  test("prints the resolved view: config path, values, MASKED secret, tmux, liveness", async () => {
    const dir = newConfigDir();
    writeFileSync(join(dir, "config.env"), 'SERVER_PORT=4321\nBETTER_AUTH_SECRET="super-secret-do-not-print"\n');
    const { deps, out, err, exits } = collectingDeps({ probePort: () => true });
    await withEnv(
      {
        SUBSHELL_SERVER_CONFIG_DIR: dir,
        SERVER_PORT: undefined,
        HOST: undefined,
        APP_BASE_URL: undefined,
        DATABASE_PATH: undefined,
        BETTER_AUTH_SECRET: undefined,
      },
      async () => {
        expect(await dispatchCli(["status"], deps)).toBe(true);
      },
    );
    const text = out.join("\n");
    expect(err).toEqual([]);
    expect(exits).toEqual([0]);
    // config.env location + existence, and the resolved values per layer.
    expect(text).toContain(join(dir, "config.env"));
    expect(text).toContain("(present)");
    expect(text).toContain("SERVER_PORT");
    expect(text).toContain("4321");
    expect(text).toContain("(config.env)");
    expect(text).toContain("0.0.0.0"); // HOST default (LAN by default; loopback is an opt-out)
    expect(text).toContain("data/subshell.db"); // DATABASE_PATH default
    // The secret is reported set but its value NEVER crosses stdout.
    expect(text).toContain("BETTER_AUTH_SECRET");
    expect(text).toContain("set (masked)");
    expect(text).not.toContain("super-secret-do-not-print");
    // tmux + liveness lines exist.
    expect(text).toContain("tmux");
    expect(text).toContain("likely running"); // the stub probe said yes
  });

  test("status reports the resolved mcp entrypoint — the server binary self-resolves", async () => {
    const dir = newConfigDir();
    const { deps, out } = collectingDeps({
      // A `subshell-server*` execPath always takes the SELF rung — no fs/PATH
      // seam can veto it (there is no fs left to veto).
      mcpIo: { execPath: "/srv/bin/subshell-server", which: () => null },
    });
    await withEnv({ SUBSHELL_SERVER_CONFIG_DIR: dir, SUBSHELL_MCP_COMMAND: undefined }, async () => {
      expect(await dispatchCli(["status"], deps)).toBe(true);
    });
    const text = out.join("\n");
    expect(text).toContain("mcp entrypoint");
    expect(text).toContain("/srv/bin/subshell-server mcp");
    expect(text).toContain("(via self)");
  });

  // Phase 3 opened a network door on the plugin install path, so "which
  // registry would a spec install fetch from" joins tmux and the MCP rung as
  // a deploy-time fact an operator must not discover by failure. The value is
  // asserted against the SAME constant the boot resolves (the
  // DEFAULT_TRUSTED_ORIGINS precedent), never a second copy of the default.
  test("status prints the plugin registry beside the mcp entrypoint", async () => {
    const dir = newConfigDir();
    const { deps, out } = collectingDeps({ probePort: () => false });
    await withEnv({ SUBSHELL_SERVER_CONFIG_DIR: dir }, async () => {
      expect(await dispatchCli(["status"], deps)).toBe(true);
    });
    const text = out.join("\n");
    // The one column every fact line shares: 21 characters before " = ".
    expect(text).toMatch(/^plugin registry {6}= \S/m);
    expect(text).toContain(`plugin registry      = ${SUBSHELL_PLUGIN_REGISTRY_URL}`);
  });

  test("status screams when no mcp entrypoint resolves — create would 500", async () => {
    const dir = newConfigDir();
    const { deps, out } = collectingDeps({
      // The miss must be forced through the NON-compiled shape: a
      // `subshell-server*` execPath self-resolves unconditionally, so pin an
      // unrelated executable with no usable argv1 and an empty PATH.
      mcpIo: { execPath: "/usr/bin/other", argv1: "", which: () => null },
    });
    await withEnv({ SUBSHELL_SERVER_CONFIG_DIR: dir, SUBSHELL_MCP_COMMAND: undefined }, async () => {
      expect(await dispatchCli(["status"], deps)).toBe(true);
    });
    const text = out.join("\n");
    expect(text).toContain("mcp entrypoint");
    expect(text).toContain("UNRESOLVED");
    expect(text).toContain("SUBSHELL_MCP_COMMAND");
  });

  test("a malformed SUBSHELL_MCP_ARGS still exits 0 — the probe never throws through status", async () => {
    const dir = newConfigDir();
    const { deps, out, exits } = collectingDeps();
    await withEnv(
      {
        SUBSHELL_SERVER_CONFIG_DIR: dir,
        SUBSHELL_MCP_COMMAND: "/opt/custom/mcp",
        SUBSHELL_MCP_ARGS: "mcp", // operator typo: not the JSON array the contract wants
      },
      async () => {
        expect(await dispatchCli(["status"], deps)).toBe(true);
      },
    );
    expect(exits).toEqual([0]);
    expect(out.join("\n")).toContain("SUBSHELL_MCP_ARGS");
  });

  test("process env shadows the file; unset secret → MISSING; nothing mutates", async () => {
    const dir = newConfigDir(); // no config.env inside
    // HOST may legitimately be set in the runner's environment (a host
    // sets 0.0.0.0) — capture it so the "status mutates nothing" assertion
    // compares against the real pre-state, not against undefined.
    const hostBefore = process.env.HOST;
    writeFileSync(join(dir, "config.env"), "HOST=from-file-host\n");
    const { deps, out } = collectingDeps();
    await withEnv(
      {
        SUBSHELL_SERVER_CONFIG_DIR: dir,
        SERVER_PORT: "7777", // process env wins over everything
        HOST: undefined,
        APP_BASE_URL: undefined,
        DATABASE_PATH: undefined,
        BETTER_AUTH_SECRET: undefined,
      },
      async () => {
        expect(await dispatchCli(["status"], deps)).toBe(true);
      },
    );
    const text = out.join("\n");
    expect(text).toContain("(present)"); // file exists in this scenario
    expect(text).toContain("7777");
    expect(text).toContain("(process env)");
    expect(text).toContain("from-file-host");
    expect(text).toContain("BETTER_AUTH_SECRET");
    expect(text).toContain("MISSING");
    expect(text).toContain("not listening"); // default stub probe said no
    // `status` is a pure view: it must not have written the file's values
    // (or anything else) into process.env — HOST is back exactly as found.
    expect(process.env.HOST).toBe(hostBefore);
  });

  test("missing config.env reports (missing) and the defaults", async () => {
    const dir = newConfigDir();
    const { deps, out } = collectingDeps();
    await withEnv(
      {
        SUBSHELL_SERVER_CONFIG_DIR: dir,
        SERVER_PORT: undefined,
        HOST: undefined,
        APP_BASE_URL: undefined,
        DATABASE_PATH: undefined,
        BETTER_AUTH_SECRET: undefined,
      },
      async () => {
        expect(await dispatchCli(["status"], deps)).toBe(true);
      },
    );
    const text = out.join("\n");
    expect(text).toContain(join(dir, "config.env"));
    expect(text).toContain("(missing)");
    expect(text).toContain("(default)");
    expect(text).toContain("3080"); // SERVER_PORT default mirrors constants.ts
  });

  test("secret only in process.env also reports set (masked)", async () => {
    const dir = newConfigDir();
    const { deps, out } = collectingDeps();
    await withEnv(
      {
        SUBSHELL_SERVER_CONFIG_DIR: dir,
        SERVER_PORT: undefined,
        HOST: undefined,
        APP_BASE_URL: undefined,
        DATABASE_PATH: undefined,
        BETTER_AUTH_SECRET: "process-level-secret",
      },
      async () => {
        await dispatchCli(["status"], deps);
      },
    );
    const text = out.join("\n");
    expect(text).toContain("set (masked)");
    expect(text).not.toContain("process-level-secret");
  });
});

describe("dispatchCli — tmux offer wiring (spec 2026-09-03)", () => {
  test("interactive configure: offer → yes → stubbed install CONTINUES end to end (exit 0, config written)", async () => {
    const dir = newConfigDir();
    let installed = false;
    const answers = ["y", "", "", "", ""];
    const { deps, out, err, exits } = collectingDeps({
      configDir: dir,
      isTTY: true,
      platform: "linux",
      env: {},
      which: (n) => (n === "apt-get" ? "/usr/bin/apt-get" : n === "tmux" && installed ? "/usr/bin/tmux" : null),
      // The offer reads `promptSync`: the preflight is shared with the
      // synchronous `installService`, so it cannot await a clack answer.
      promptSync: () => answers.shift() ?? "",
      prompt: () => answers.shift() ?? "",
      spawnInstall: () => {
        installed = true;
        return 0;
      },
    });
    expect(await dispatchCli(["configure"], deps)).toBe(true);
    expect(exits).toEqual([0]);
    expect(out.join("\n")).toMatch(/tmux installed/i);
    expect(err).toEqual([]);
    expect(readFileSync(join(dir, "config.env"), "utf8")).toContain("SERVER_PORT=3080");
  });

  test("non-TTY configure never asks: the refusal contract is unchanged through the CLI", async () => {
    let asked = 0;
    const { deps, err, exits } = collectingDeps({
      configDir: newConfigDir(),
      isTTY: false,
      platform: "linux",
      env: {},
      which: () => null,
      promptSync: () => {
        asked++;
        return "y";
      },
      prompt: () => {
        asked++;
        return "y";
      },
      spawnInstall: () => 0,
    });
    expect(await dispatchCli(["configure", "--yes"], deps)).toBe(true);
    expect(asked).toBe(0);
    expect(exits).toEqual([1]);
    expect(err.join("\n")).toMatch(/tmux not found/i);
  });
});

describe("dispatchCli — status names the build", () => {
  // "Which version is this host running?" was unanswerable from status: the
  // version lived only in the `version` subcommand, so an operator diagnosing
  // a stale deploy had to run a second command to learn the one fact that
  // decides whether the rest of the output is even relevant.
  test("status opens with the same string `version` prints", async () => {
    const dir = newConfigDir();
    const status = collectingDeps({ probePort: () => false });
    const version = collectingDeps({});
    await withEnv({ SUBSHELL_SERVER_CONFIG_DIR: dir }, async () => {
      expect(await dispatchCli(["status"], status.deps)).toBe(true);
      expect(await dispatchCli(["version"], version.deps)).toBe(true);
    });
    // Shape, not a copied constant — asserting the literal would just restate
    // package.json and pass while both drifted together.
    expect(status.out[0]).toMatch(/^subshell-server \d+\.\d+\.\d+/);
    // ONE fact, ONE spelling: status must not grow a second rendering of the
    // version that can disagree with the subcommand.
    expect(status.out[0]).toBe(version.out[0]);
    expect(status.err).toEqual([]);
    expect(status.exits).toEqual([0]);
  });
});

/**
 * `status --json` and the `service` verbs. The two rules worth pinning here:
 * a valid `status` invocation always exits 0 (a script must not have to
 * distinguish "not running" from "the call failed"), and the JSON must never
 * carry the auth secret in any form — the same scan `/api/admin/status`
 * already runs on its own serialized response.
 */
describe("dispatchCli — status --json", () => {
  const SECRET = "totally-real-secret-value-do-not-leak-8f3a";

  test("emits parseable JSON carrying the same facts as the text view", async () => {
    const dir = newConfigDir();
    writeFileSync(join(dir, "config.env"), `SERVER_PORT=4321\nHOST=127.0.0.1\nBETTER_AUTH_SECRET=${SECRET}\n`);
    const { deps, out, err, exits } = collectingDeps({
      probePort: () => false,
      platform: "linux",
      home: "/home/nobody",
    });
    await withEnv({ SUBSHELL_SERVER_CONFIG_DIR: dir, SERVER_PORT: undefined, HOST: undefined }, async () => {
      expect(await dispatchCli(["status", "--json"], deps)).toBe(true);
    });
    expect(err).toEqual([]);
    expect(exits).toEqual([0]);
    expect(out).toHaveLength(1);
    const v = JSON.parse(out[0] as string);
    expect(v.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(v.configEnv).toMatchObject({ path: join(dir, "config.env"), exists: true });
    // A machine consumer (the desktop console) reads the registry the same
    // way the text view prints it.
    expect(v.pluginRegistry).toBe(SUBSHELL_PLUGIN_REGISTRY_URL);
    expect(v.settings.SERVER_PORT).toEqual({ value: "4321", source: "config.env" });
    // A machine consumer gets a NUMBER; the raw text stays available so a
    // malformed value can still be quoted back at the operator.
    // This file stores HOST=127.0.0.1, so the dial host and the bind host are
    // the same address here — the wildcard case (0.0.0.0 dialed as loopback)
    // is covered by the text-view test above.
    expect(v.listen).toMatchObject({ host: "127.0.0.1", port: 4321, portRaw: "4321", portValid: true });
    expect(v.service.definitionPath).toContain("subshell-server.service");
  });

  /**
   * The desktop app's reset deletes exactly what this block names and nothing
   * else, so the four paths are a contract with a consumer that removes files.
   * They must be the constants THIS process resolved (under the test env that
   * is the per-process temp data dir and temp DB, and the assertions import the
   * same module-level constants, so they hold either way), and the block must
   * not become a second source for a fact `status` already reports.
   */
  test("paths reports the resolved data locations, the server's own log among them", async () => {
    const dir = newConfigDir();
    const { deps, out } = collectingDeps({ probePort: () => false });
    await withEnv({ SUBSHELL_SERVER_CONFIG_DIR: dir }, async () => {
      expect(await dispatchCli(["status", "--json"], deps)).toBe(true);
    });
    const view = JSON.parse(out[0] as string);
    expect(Object.keys(view.paths).sort()).toEqual([
      "backups",
      "binary",
      "dataDir",
      "database",
      "logsDir",
      "nodeArtifacts",
      "serverLog",
    ]);
    expect(isAbsolute(view.paths.dataDir)).toBe(true);
    expect(view.paths.dataDir).toBe(SUBSHELL_SERVER_DATA_DIR);
    expect(view.paths.database).toBe(DATABASE_PATH);
    expect(view.paths.logsDir).toBe(`${SUBSHELL_SERVER_DATA_DIR}/subshells`);
    // Inside dataDir on purpose: a reset deletes the data directory, and the
    // server log goes with it rather than needing a path of its own.
    expect(view.paths.serverLog).toBe(`${SUBSHELL_SERVER_DATA_DIR}/logs/server.log`);
    // Same reason for the database snapshots, which are the most sensitive
    // single file this app writes (spec 2026-09-15 §4.1).
    expect(view.paths.backups).toBe(`${SUBSHELL_SERVER_DATA_DIR}/backups`);
    // Already a StatusView fact: the paths block must not be a second source.
    expect(view.paths.nodeArtifacts).toBe(view.nodeArtifacts.dir);
  });

  /**
   * `paths.binary` is the file an update would REPLACE, and `binary` is how it
   * was decided. The suite runs under `bun src/index.ts` with a temp config
   * home, so there is no service definition and `process.execPath` is `bun`:
   * the honest answer is `unknown` with a reason, and `paths.binary` is null.
   * Writing a path here by convention is exactly the failure spec §4.2 names —
   * an update that reports success and changes nothing.
   */
  test("binary says which file an update would replace, or why it cannot", async () => {
    const dir = newConfigDir();
    const { deps, out } = collectingDeps({ probePort: () => false, home: newConfigDir() });
    await withEnv({ SUBSHELL_SERVER_CONFIG_DIR: dir }, async () => {
      expect(await dispatchCli(["status", "--json"], deps)).toBe(true);
    });
    const view = JSON.parse(out[0] as string);
    expect(["compiled", "source", "unknown"]).toContain(view.binary.kind);
    if (view.binary.kind === "compiled") {
      expect(isAbsolute(view.paths.binary)).toBe(true);
      expect(typeof view.binary.source).toBe("string");
    } else {
      expect(view.paths.binary).toBeNull();
      expect(typeof view.binary.reason).toBe("string");
    }
    // Backups are a count plus the newest, never the whole list.
    expect(Object.keys(view.backups).sort()).toEqual(["count", "latest"]);
    expect(typeof view.backups.count).toBe("number");
  });

  /**
   * The desktop console SEEDS its configure form from this view and passes
   * every field back, so a key the view cannot report is a key the console
   * silently clears on save. `TRUSTED_ORIGINS` therefore has to be here, and
   * has to carry the `default` source when unset — that is how the form tells
   * "the user chose this" from "nobody has chosen yet".
   */
  test("reports TRUSTED_ORIGINS with its layer, so the console can round-trip it", async () => {
    const dir = newConfigDir();
    writeFileSync(join(dir, "config.env"), "TRUSTED_ORIGINS=http://box.local:3080\n");
    const { deps, out } = collectingDeps({ probePort: () => false });
    await withEnv({ SUBSHELL_SERVER_CONFIG_DIR: dir, TRUSTED_ORIGINS: undefined }, async () => {
      await dispatchCli(["status", "--json"], deps);
    });
    expect(JSON.parse(out[0] as string).settings.TRUSTED_ORIGINS).toEqual({
      value: "http://box.local:3080",
      source: "config.env",
    });
  });

  test("an unset TRUSTED_ORIGINS reports the built-in list as source 'default'", async () => {
    const dir = newConfigDir();
    const { deps, out } = collectingDeps({ probePort: () => false });
    await withEnv({ SUBSHELL_SERVER_CONFIG_DIR: dir, TRUSTED_ORIGINS: undefined }, async () => {
      await dispatchCli(["status", "--json"], deps);
    });
    expect(JSON.parse(out[0] as string).settings.TRUSTED_ORIGINS.source).toBe("default");
  });

  /**
   * The diagnostic that replaced a boot-time check.
   *
   * Refusing at boot is impossible — `constants.ts` is imported by every
   * subcommand, so a throw bricks the `configure` that would repair the value
   * (the `SERVER_PORT=70000` precedent). And a boot WARNING cannot say which
   * LAYER supplied the value, so it sends an operator to edit a config.env
   * they already got right. `status` can: it is read-only, always exits 0,
   * already carries per-key attribution, and the desktop console reads it —
   * so the diagnosis lands on the surface someone runs BECAUSE sign-in is
   * failing.
   */
  test("reports a stored origin the browser will never match, WITH its layer", async () => {
    const dir = newConfigDir();
    writeFileSync(join(dir, "config.env"), "TRUSTED_ORIGINS=box.local:3080,http://ok.local:3080\n");
    const { deps, out } = collectingDeps({ probePort: () => false });
    await withEnv({ SUBSHELL_SERVER_CONFIG_DIR: dir, TRUSTED_ORIGINS: undefined }, async () => {
      await dispatchCli(["status", "--json"], deps);
    });
    const setting = JSON.parse(out[0] as string).settings.TRUSTED_ORIGINS;
    expect(setting.source).toBe("config.env"); // the layer is the actionable half
    expect(setting.problems).toHaveLength(1); // only the schemeless entry
    expect(setting.problems[0].entry).toBe("box.local:3080");
    expect(setting.problems[0].reason).toMatch(/scheme/i);
  });

  test("a usable list carries NO problems field at all", async () => {
    const dir = newConfigDir();
    writeFileSync(join(dir, "config.env"), "TRUSTED_ORIGINS=http://box.local:3080\n");
    const { deps, out } = collectingDeps({ probePort: () => false });
    await withEnv({ SUBSHELL_SERVER_CONFIG_DIR: dir, TRUSTED_ORIGINS: undefined }, async () => {
      await dispatchCli(["status", "--json"], deps);
    });
    // Absent rather than `[]`: every other key's shape stays unchanged, and a
    // console gating on `problems?.length` would draw an empty warning box.
    expect(JSON.parse(out[0] as string).settings.TRUSTED_ORIGINS.problems).toBeUndefined();
  });

  test("reports a malformed APP_BASE_URL, which silently drops the instance's own origin", async () => {
    const dir = newConfigDir();
    writeFileSync(join(dir, "config.env"), "APP_BASE_URL=box.local:3080\n");
    const { deps, out } = collectingDeps({ probePort: () => false });
    await withEnv({ SUBSHELL_SERVER_CONFIG_DIR: dir, APP_BASE_URL: undefined }, async () => {
      await dispatchCli(["status", "--json"], deps);
    });
    const setting = JSON.parse(out[0] as string).settings.APP_BASE_URL;
    expect(setting.problems).toHaveLength(1);
    expect(setting.problems[0].reason).toMatch(/own origin|allowlist/i);
  });

  /**
   * The property that keeps the secret-scan test below valid without touching
   * it: a problem's `entry` is always a slice of the setting's own value, so
   * the diagnostic introduces no new class of data into the payload. Whoever
   * later writes a reason mentioning another key has to break this first.
   */
  test("every problem entry is a substring of its own setting's value", async () => {
    const dir = newConfigDir();
    writeFileSync(join(dir, "config.env"), `APP_BASE_URL=nope\nTRUSTED_ORIGINS=box.local:1,also-bad:2\n`);
    const { deps, out } = collectingDeps({ probePort: () => false });
    await withEnv(
      { SUBSHELL_SERVER_CONFIG_DIR: dir, APP_BASE_URL: undefined, TRUSTED_ORIGINS: undefined },
      async () => {
        await dispatchCli(["status", "--json"], deps);
      },
    );
    const settings = JSON.parse(out[0] as string).settings as Record<
      string,
      { value: string; problems?: { entry: string }[] }
    >;
    let seen = 0;
    for (const setting of Object.values(settings)) {
      for (const problem of setting.problems ?? []) {
        expect(setting.value).toContain(problem.entry);
        seen += 1;
      }
    }
    expect(seen).toBeGreaterThan(0); // the assertion above must have actually run
  });

  test("the text view prints each problem under its setting", async () => {
    const dir = newConfigDir();
    writeFileSync(join(dir, "config.env"), "TRUSTED_ORIGINS=box.local:3080\n");
    const { deps, out } = collectingDeps({ probePort: () => false });
    await withEnv({ SUBSHELL_SERVER_CONFIG_DIR: dir, TRUSTED_ORIGINS: undefined }, async () => {
      await dispatchCli(["status"], deps);
    });
    const text = out.join("\n");
    expect(text).toContain("TRUSTED_ORIGINS");
    expect(text).toMatch(/scheme/i);
  });

  // The auth secret is the one value in the whole view that must never be
  // renderable. A field added later cannot regress this without failing here.
  test("NEVER serializes the auth secret — only its two-state presence", async () => {
    const dir = newConfigDir();
    writeFileSync(join(dir, "config.env"), `BETTER_AUTH_SECRET=${SECRET}\n`);
    const { deps, out } = collectingDeps({ probePort: () => false });
    await withEnv({ SUBSHELL_SERVER_CONFIG_DIR: dir, BETTER_AUTH_SECRET: undefined }, async () => {
      await dispatchCli(["status", "--json"], deps);
    });
    const raw = out[0] as string;
    expect(raw).not.toContain(SECRET);
    expect(JSON.parse(raw).authSecret).toMatchObject({ state: "set" });
  });

  // parseInt("3080abc") is 3080, but the boot path refuses it — reporting it
  // valid would promise a boot that fails.
  test("a malformed SERVER_PORT is portValid:false with a null port", async () => {
    const dir = newConfigDir();
    writeFileSync(join(dir, "config.env"), "SERVER_PORT=3080abc\n");
    const { deps, out } = collectingDeps({ probePort: () => false });
    await withEnv({ SUBSHELL_SERVER_CONFIG_DIR: dir, SERVER_PORT: undefined }, async () => {
      await dispatchCli(["status", "--json"], deps);
    });
    expect(JSON.parse(out[0] as string).listen).toMatchObject({
      port: null,
      portRaw: "3080abc",
      portValid: false,
      listening: false,
    });
  });

  test("a missing secret reads as missing, still without a value field", async () => {
    const dir = newConfigDir();
    const { deps, out } = collectingDeps({ probePort: () => false });
    await withEnv({ SUBSHELL_SERVER_CONFIG_DIR: dir, BETTER_AUTH_SECRET: undefined }, async () => {
      await dispatchCli(["status", "--json"], deps);
    });
    expect(JSON.parse(out[0] as string).authSecret.state).toBe("missing");
  });

  // Silently ignoring extras would hand a typo'd `--jsonn` prose that no
  // script can parse — the failure a machine consumer can least afford.
  test("an unknown flag is a usage error, not silently ignored", async () => {
    const { deps, out, err, exits } = collectingDeps();
    expect(await dispatchCli(["status", "--jsonn"], deps)).toBe(true);
    expect(out).toEqual([]);
    expect(err[0]).toContain("unexpected argument '--jsonn'");
    expect(exits).toEqual([1]);
  });
});

describe("dispatchCli — service verbs", () => {
  test("every verb is accepted; an unknown one is a usage error naming the set", async () => {
    const { deps, err, exits } = collectingDeps();
    expect(await dispatchCli(["service", "frobnicate"], deps)).toBe(true);
    expect(err[0]).toContain("unknown service command 'frobnicate'");
    expect(exits).toEqual([1]);

    const bare = collectingDeps();
    expect(await dispatchCli(["service"], bare.deps)).toBe(true);
    expect(bare.err[0]).toContain("install");
    expect(bare.err[0]).toContain("restart");
    expect(bare.exits).toEqual([1]);
  });

  test("service status is a VIEW — exit 0 even with nothing installed", async () => {
    const { deps, out, err, exits } = collectingDeps({ platform: "linux", home: "/home/nobody-here" });
    expect(await dispatchCli(["service", "status"], deps)).toBe(true);
    expect(err).toEqual([]);
    expect(exits).toEqual([0]);
    expect(out.join("\n")).toContain("not installed");
  });

  test("service status --json emits the ServiceState object", async () => {
    const { deps, out, exits } = collectingDeps({ platform: "linux", home: "/home/nobody-here" });
    expect(await dispatchCli(["service", "status", "--json"], deps)).toBe(true);
    expect(exits).toEqual([0]);
    const state = JSON.parse(out[0] as string);
    expect(state).toMatchObject({ installed: false, state: "not-installed" });
    expect(state.definitionPath).toContain("subshell-server.service");
  });

  test("start/stop/restart refuse when no definition exists", async () => {
    for (const verb of ["start", "stop", "restart"]) {
      const { deps, err, exits } = collectingDeps({ platform: "linux", home: "/home/nobody-here" });
      expect(await dispatchCli(["service", verb], deps)).toBe(true);
      expect(err.join("\n")).toContain("nothing installed");
      expect(exits).toEqual([1]);
    }
  });

  // Flags are per-verb: --force means something only for restart, and --json
  // only where there is structured state to emit.
  test("--force is accepted by restart and refused everywhere else", async () => {
    const ok = collectingDeps({ platform: "linux", home: "/home/nobody-here" });
    await dispatchCli(["service", "restart", "--force"], ok.deps);
    expect(ok.err.join("\n")).toContain("nothing installed");

    const bad = collectingDeps({ platform: "linux", home: "/home/nobody-here" });
    await dispatchCli(["service", "start", "--force"], bad.deps);
    expect(bad.err[0]).toContain("unexpected argument '--force'");
    expect(bad.exits).toEqual([1]);
  });

  // Every test above drives paths that reach DEFAULT_DEPS. Without an injected
  // runCmd a regression would silently shell out to the REAL systemctl on a
  // developer's machine, so these pin that nothing spawns.
  test("nothing spawns a manager command when no definition exists", async () => {
    const calls: string[][] = [];
    const { deps, exits } = collectingDeps({
      platform: "linux",
      home: "/home/nobody-here",
      runCmd: (cmd) => {
        calls.push(cmd);
        return { code: 0, out: "", err: "" };
      },
    });
    for (const verb of ["status", "start", "stop", "restart"]) {
      await dispatchCli(["service", verb], deps);
    }
    expect(calls).toEqual([]);
    expect(exits).toEqual([0, 1, 1, 1]);
  });

  test("install still refuses stray arguments", async () => {
    const { deps, err, exits } = collectingDeps();
    expect(await dispatchCli(["service", "install", "--json"], deps)).toBe(true);
    expect(err[0]).toContain("unexpected argument '--json'");
    expect(exits).toEqual([1]);
  });

  test("enable and disable are dispatchable words, and take no flags", async () => {
    // Nothing is installed here, so both refuse — the point is that they are
    // RECOGNISED rather than a usage error, which is what a missing entry in
    // SERVICE_COMMANDS would produce.
    for (const verb of ["enable", "disable"]) {
      const { deps, err, exits } = collectingDeps({ platform: "linux", home: "/home/nobody-here" });
      expect(await dispatchCli(["service", verb], deps)).toBe(true);
      expect(err.join("\n")).not.toContain("unknown service command");
      expect(err.join("\n")).toContain("nothing installed");
      expect(exits).toEqual([1]);
    }

    const flagged = collectingDeps();
    expect(await dispatchCli(["service", "enable", "--json"], flagged.deps)).toBe(true);
    expect(flagged.err[0]).toContain("unexpected argument '--json'");
  });

  test("install accepts --no-autostart, and only install does", async () => {
    // ISOLATED, and now provably so: `configDir` is pinned to a directory
    // that cannot hold a config.env, because on a DEVELOPER'S box the real
    // `~/.config/subshell-server/config.env` exists and `installService`
    // sails past its own "run init first" refusal into the write path, where
    // the service-write safety guard throws (the same host-leak class as the
    // "update refuses" case: the ladder sees the operator's install, CI does
    // not). With the refusal intact, nothing is written, no manager is
    // asked, and the test proves only what it means to: the flag PARSE.
    const calls: string[][] = [];
    const { deps, err } = collectingDeps({
      platform: "linux",
      home: "/home/nobody-here",
      configDir: "/no/such/config/subshell-server",
      runCmd: (cmd: string[]) => {
        calls.push(cmd);
        return { code: 0, out: "", err: "" };
      },
    });
    await dispatchCli(["service", "install", "--no-autostart"], deps);
    expect(err.join("\n")).not.toContain("unexpected argument");
    // Nothing reached a real machine: every manager command went to the stub.
    expect(calls.every((c) => c[0] === "systemctl")).toBe(true);

    const wrong = collectingDeps();
    expect(await dispatchCli(["service", "restart", "--no-autostart"], wrong.deps)).toBe(true);
    expect(wrong.err[0]).toContain("unexpected argument '--no-autostart'");
  });

  test("usage names the autostart verbs and the flag", async () => {
    const { deps, err } = collectingDeps();
    await dispatchCli(["service"], deps);
    const usage = err.join("\n");
    expect(usage).toContain("service enable");
    expect(usage).toContain("service disable");
    expect(usage).toContain("--no-autostart");
  });
});

/**
 * End-to-end through `dispatchCli` with a REAL unit file on disk (the
 * `readFile`/`fileExists` seams live in DEFAULT_DEPS, not CliDeps, so a temp
 * home is the only way to drive them) and a recording `runCmd`. This is the
 * only place the CLI's `--force` plumbing and the installed branch of
 * `serviceStateLines` are exercised.
 */
describe("dispatchCli — service against a real definition on disk", () => {
  /** A temp HOME carrying a systemd user unit with the given body. */
  function homeWithUnit(body: string): string {
    const home = mkdtempSync(join(tmpdir(), `subshell-svc-test-${process.pid}-`));
    const dir = join(home, ".config", "systemd", "user");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "subshell-server.service"), body);
    return home;
  }

  /**
   * collectingDeps plus a recording runCmd that answers `systemctl show` with
   * `props` — and logind's `Linger` with `linger`, whose default (no line at
   * all) is the "did not answer" shape.
   */
  function linuxDeps(home: string, props: Record<string, string>, linger: "yes" | "no" | null = null) {
    const calls: string[][] = [];
    const base = collectingDeps({
      platform: "linux",
      home,
      runCmd: (cmd) => {
        calls.push(cmd);
        if (cmd[0] === "loginctl") {
          return { code: 0, out: linger === null ? "" : `Linger=${linger}\n`, err: "" };
        }
        if (cmd.includes("show")) {
          return {
            code: 0,
            out: Object.entries(props)
              .map(([k, v]) => `${k}=${v}`)
              .join("\n"),
            err: "",
          };
        }
        return { code: 0, out: "", err: "" };
      },
    });
    return { ...base, calls };
  }

  const SAFE = {
    ActiveState: "active",
    SubState: "running",
    UnitFileState: "enabled",
    MainPID: "99",
    KillMode: "process",
  };
  const LETHAL = { ...SAFE, KillMode: "control-group" };

  test("service status renders the installed branch, including the pane verdict", async () => {
    const home = homeWithUnit("[Service]\nKillMode=process\n");
    const { deps, out, exits } = linuxDeps(home, SAFE);
    expect(await dispatchCli(["service", "status"], deps)).toBe(true);
    const text = out.join("\n");
    expect(text).toContain("definition installed");
    expect(text).toContain("state                = running (pid 99)");
    expect(text).toContain("starts at login      = yes");
    expect(text).toContain("teardown keeps panes = yes");
    expect(exits).toEqual([0]);
  });

  /**
   * "Starts at login" and "survives logout" are two questions, and on a
   * headless box the second is the one that decides whether a reboot brings
   * the server back. It is logind's answer, so it renders only for a systemd
   * definition.
   */
  test("service status renders the linger verdict, all three ways", async () => {
    const home = homeWithUnit("[Service]\nKillMode=process\n");

    const lingering = linuxDeps(home, SAFE, "yes");
    await dispatchCli(["service", "status"], lingering.deps);
    expect(lingering.out.join("\n")).toContain("survives logout      = yes (user lingers)");

    const notLingering = linuxDeps(home, SAFE, "no");
    await dispatchCli(["service", "status"], notLingering.deps);
    expect(notLingering.out.join("\n")).toContain("survives logout      = no: run `loginctl enable-linger $USER`");

    const silent = linuxDeps(home, SAFE, null);
    await dispatchCli(["service", "status"], silent.deps);
    expect(silent.out.join("\n")).toContain("survives logout      = unknown (could not be measured)");
  });

  // launchd has no lingering knob — a LaunchAgent's lifetime IS the login
  // session — so the line is absent rather than unknown.
  test("a launchd definition shows no linger line at all", async () => {
    const home = mkdtempSync(join(tmpdir(), `subshell-svc-plist-${process.pid}-`));
    mkdirSync(join(home, "Library", "LaunchAgents"), { recursive: true });
    writeFileSync(join(home, "Library", "LaunchAgents", "dev.subshell.server.plist"), "<plist/>");
    const { deps, out } = collectingDeps({ platform: "darwin", home, runCmd: () => ({ code: 0, out: "", err: "" }) });
    await dispatchCli(["service", "status"], deps);
    const text = out.join("\n");
    expect(text).toContain("definition installed");
    expect(text).not.toContain("survives logout");
  });

  test("service status names a lethal definition in plain words", async () => {
    const home = homeWithUnit("[Service]\nKillMode=process\n");
    const { deps, out } = linuxDeps(home, LETHAL);
    await dispatchCli(["service", "status"], deps);
    const text = out.join("\n");
    expect(text).toContain("teardown keeps panes = NO");
    expect(text).toContain("reinstall it before stopping or restarting");
  });

  test("service status --json carries the same verdict as a field", async () => {
    const home = homeWithUnit("[Service]\nKillMode=process\n");
    const { deps, out } = linuxDeps(home, LETHAL);
    await dispatchCli(["service", "status", "--json"], deps);
    expect(JSON.parse(out[0] as string)).toMatchObject({ installed: true, state: "running", paneSafety: "kills" });
  });

  test("restart is refused on a lethal definition, and --force carries through the CLI", async () => {
    const home = homeWithUnit("[Service]\nKillMode=process\n");
    const refused = linuxDeps(home, LETHAL);
    expect(await dispatchCli(["service", "restart"], refused.deps)).toBe(true);
    expect(refused.err.join("\n")).toContain("refusing to restart");
    expect(refused.exits).toEqual([1]);
    expect(refused.calls.flat()).not.toContain("restart");

    const forced = linuxDeps(home, LETHAL);
    expect(await dispatchCli(["service", "restart", "--force"], forced.deps)).toBe(true);
    expect(forced.exits).toEqual([0]);
    expect(forced.calls.at(-1)).toEqual(["systemctl", "--user", "restart", "subshell-server.service"]);
  });

  // stop is as lethal as restart but is not refused — it must still say so.
  test("stop warns on stderr and still exits 0", async () => {
    const home = homeWithUnit("[Service]\nKillMode=process\n");
    const { deps, err, exits, calls } = linuxDeps(home, LETHAL);
    expect(await dispatchCli(["service", "stop"], deps)).toBe(true);
    expect(err.join("\n")).toContain("warning");
    expect(exits).toEqual([0]);
    expect(calls.at(-1)).toEqual(["systemctl", "--user", "stop", "subshell-server.service"]);
  });

  test("a pane-safe definition drives the verbs with no warning at all", async () => {
    const home = homeWithUnit("[Service]\nKillMode=process\n");
    const { deps, err, exits } = linuxDeps(home, SAFE);
    await dispatchCli(["service", "restart"], deps);
    expect(err).toEqual([]);
    expect(exits).toEqual([0]);
  });
});

/**
 * `status` answers "is there an admin account yet?" (spec 2026-09-15 §4.3).
 *
 * `status` is documented as the first thing to run when something looks wrong,
 * and until now it could not answer the first question a stuck operator has:
 * the CLI never says the server hands its first visitor a setup wizard, so an
 * install that is working perfectly looks identical to one that is broken.
 *
 * The probe reads the database the BOOT would open — the config ladder's
 * `DATABASE_PATH`, which is what these tests pin — read-only and never
 * throwing: `status` always exits 0, so an unreadable file is an unknown
 * answer rather than a failed command.
 */
describe("dispatchCli — status says whether an admin account exists", () => {
  /**
   * Write a database with better-auth's `user` table holding `rows` accounts,
   * in WAL mode — which is what the server leaves behind, and the case the
   * obvious implementation gets wrong.
   *
   * The service account is seeded too, because the probe must not count it:
   * an instance that has minted a system API key has a `user` row and still
   * nobody who can sign in.
   */
  function seedDb(path: string, rows: number): void {
    const db = new Database(path, { create: true });
    db.run("PRAGMA journal_mode = WAL");
    db.run(`CREATE TABLE "user" (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE)`);
    db.run(`INSERT INTO "user" (id, email) VALUES ('sys', 'system@subshell.local')`);
    for (let i = 0; i < rows; i++) {
      db.run(`INSERT INTO "user" (id, email) VALUES (?, ?)`, [`u${i}`, `u${i}@subshell.local`]);
    }
    db.close();
  }

  test("no database file: the server has never booted, and the line says so", async () => {
    const dir = newConfigDir();
    const { deps, out } = collectingDeps({ probePort: () => false });
    await withEnv({ SUBSHELL_SERVER_CONFIG_DIR: dir, DATABASE_PATH: join(dir, "absent.db") }, async () => {
      expect(await dispatchCli(["status", "--json"], deps)).toBe(true);
    });
    expect(JSON.parse(out[0] as string).setup).toEqual({ database: "missing", hasUsers: null });
    const human = collectingDeps({ probePort: () => false });
    await withEnv({ SUBSHELL_SERVER_CONFIG_DIR: dir, DATABASE_PATH: join(dir, "absent.db") }, async () => {
      await dispatchCli(["status"], human.deps);
    });
    expect(human.out.join("\n")).toMatch(/setup .*= database not created yet/);
  });

  test("a database with no accounts: the line names the /setup URL to open", async () => {
    const dir = newConfigDir();
    const dbPath = join(dir, "empty.db");
    seedDb(dbPath, 0);
    writeFileSync(join(dir, "config.env"), "APP_BASE_URL=http://box.local:3080\n");
    const { deps, out } = collectingDeps({ probePort: () => false });
    await withEnv({ SUBSHELL_SERVER_CONFIG_DIR: dir, DATABASE_PATH: dbPath, APP_BASE_URL: undefined }, async () => {
      await dispatchCli(["status"], deps);
    });
    const text = out.join("\n");
    expect(text).toContain("http://box.local:3080/setup");
    expect(text).toMatch(/setup .*= no admin account yet/);
  });

  test("a database with an account: hasUsers is true and the line stops advertising the wizard", async () => {
    const dir = newConfigDir();
    const dbPath = join(dir, "seeded.db");
    seedDb(dbPath, 1);
    const { deps, out } = collectingDeps({ probePort: () => false });
    await withEnv({ SUBSHELL_SERVER_CONFIG_DIR: dir, DATABASE_PATH: dbPath }, async () => {
      await dispatchCli(["status", "--json"], deps);
    });
    expect(JSON.parse(out[0] as string).setup).toEqual({ database: "present", hasUsers: true });
    const human = collectingDeps({ probePort: () => false });
    await withEnv({ SUBSHELL_SERVER_CONFIG_DIR: dir, DATABASE_PATH: dbPath }, async () => {
      await dispatchCli(["status"], human.deps);
    });
    expect(human.out.join("\n")).toMatch(/setup .*= admin account exists/);
    expect(human.out.join("\n")).not.toContain("/setup");
  });

  // A WAL database with no shared-memory file beside it is what a restored
  // backup, a copied instance, or any clean SQLite shutdown leaves — bun's own
  // close does not remove them, but other clients do. SQLite then refuses a
  // READ-ONLY open outright: reading a WAL database needs a writable `-shm`,
  // and a read-only connection may not create one. Measured on bun 1.4.2, the
  // open succeeds and the first query throws "unable to open database file",
  // so the naive implementation calls a perfectly good database unreadable.
  test("a WAL database with no -shm beside it still answers", async () => {
    const dir = newConfigDir();
    const dbPath = join(dir, "restored.db");
    seedDb(dbPath, 2);
    rmSync(`${dbPath}-wal`, { force: true });
    rmSync(`${dbPath}-shm`, { force: true });
    const { deps, out, exits } = collectingDeps({ probePort: () => false });
    await withEnv({ SUBSHELL_SERVER_CONFIG_DIR: dir, DATABASE_PATH: dbPath }, async () => {
      await dispatchCli(["status", "--json"], deps);
    });
    expect(exits).toEqual([0]);
    expect(JSON.parse(out[0] as string).setup).toEqual({ database: "present", hasUsers: true });
  });

  // A file that is not a database at all is the shape a half-written copy or a
  // wrong DATABASE_PATH takes. `status` must still exit 0 and print the rest.
  test("an unreadable database is an unknown answer, never a thrown command", async () => {
    const dir = newConfigDir();
    const dbPath = join(dir, "garbage.db");
    writeFileSync(dbPath, "this is not a sqlite file");
    const { deps, out, err, exits } = collectingDeps({ probePort: () => false });
    await withEnv({ SUBSHELL_SERVER_CONFIG_DIR: dir, DATABASE_PATH: dbPath }, async () => {
      expect(await dispatchCli(["status", "--json"], deps)).toBe(true);
    });
    expect(exits).toEqual([0]);
    expect(err).toEqual([]);
    expect(JSON.parse(out[0] as string).setup).toEqual({ database: "present", hasUsers: null });
  });
});

/**
 * The `update` and `backup` verbs (spec 2026-09-15 §4.1/§4.4).
 *
 * Only the DISPATCH layer is here — the flag shape, the usage listing, and
 * that a refusal exits 1 without reaching the network. What the verb DOES is
 * `commands/__tests__/update.test.ts`, which drives it with injected seams.
 */
describe("parseUpdateFlags", () => {
  const collect = () => {
    const errs: string[] = [];
    return { errs, error: (line: string) => errs.push(line) };
  };

  test("reads every boolean and both value flags, in either spelling", () => {
    const { error } = collect();
    expect(parseUpdateFlags(["--check", "--force", "--yes", "--json", "--no-restart"], error)).toEqual({
      check: true,
      force: true,
      yes: true,
      json: true,
      noRestart: true,
    });
    expect(parseUpdateFlags(["--to", "0.7.0"], error)).toEqual({ to: "0.7.0" });
    expect(parseUpdateFlags(["--to=0.7.0"], error)).toEqual({ to: "0.7.0" });
    expect(parseUpdateFlags(["--from", "/tmp/x"], error)).toEqual({ from: "/tmp/x" });
  });

  test("refuses an unknown flag, a stray positional, and a missing value", () => {
    for (const argv of [["--jsonn"], ["0.7.0"], ["--to"], ["--to", "--yes"], ["--to="], ["--yes=1"]]) {
      const { errs, error } = collect();
      expect(parseUpdateFlags(argv, error), argv.join(" ")).toBeNull();
      expect(errs).toHaveLength(1);
    }
  });

  test("refuses --to with --from: two different things to install", () => {
    const { errs, error } = collect();
    expect(parseUpdateFlags(["--to", "0.7.0", "--from", "/tmp/x"], error)).toBeNull();
    expect(errs.join("")).toMatch(/pass one/);
  });

  test("refuses the install-only flags beside --rollback", () => {
    // "rollback --to 0.7.0" describes an act this verb does not have, and the
    // earliest refusal is the kind one.
    for (const extra of [["--check"], ["--to", "0.7.0"], ["--from", "/x"], ["--no-restart"]]) {
      const { errs, error } = collect();
      expect(parseUpdateFlags(["--rollback", ...extra], error)).toBeNull();
      expect(errs.join("")).toMatch(/only --yes, --force and --json/);
    }
    const { error } = collect();
    expect(parseUpdateFlags(["--rollback", "--yes", "--force", "--json"], error)).toEqual({
      rollback: true,
      yes: true,
      force: true,
      json: true,
    });
  });
});

describe("dispatchCli — update and backup", () => {
  test("usage lists both verbs and update's flags", async () => {
    const { deps, err } = collectingDeps();
    await dispatchCli(["nonsense"], deps);
    const usage = err.join("\n");
    expect(usage).toContain("subshell-server update");
    expect(usage).toContain("subshell-server backup");
    expect(usage).toContain("--rollback");
    expect(usage).toContain("--no-restart");
  });

  test("a bad update flag is a usage error, and nothing is installed", async () => {
    const { deps, err, exits } = collectingDeps();
    expect(await dispatchCli(["update", "--nope"], deps)).toBe(true);
    expect(exits).toEqual([1]);
    expect(err.join("\n")).toContain("unknown flag '--nope'");
  });

  test("a bad backup flag is a usage error", async () => {
    const { deps, err, exits } = collectingDeps();
    expect(await dispatchCli(["backup", "--jsonn"], deps)).toBe(true);
    expect(exits).toEqual([1]);
    expect(err.join("\n")).toContain("unexpected argument '--jsonn'");
  });

  /**
   * The property is **that it refuses before the network**, not which of the
   * two refusals wins — because which one wins depends on a fact about the
   * HOST that this test cannot control.
   *
   * The installed-binary ladder reads the service definition in the real
   * launchd/systemd user domain, and no injected temp home hides it. So on a
   * machine with a Subshell Server installed, the ladder SUCCEEDS and the
   * air-gapped refusal (`SUBSHELL_RELEASE_URL` is empty under test) is the one
   * that fires; on a clean machine, and in CI, the ladder answers `unknown`
   * and the binary refusal fires first.
   *
   * It used to assert the binary refusal alone, so it failed on every
   * developer machine that had the product installed — reporting a defect
   * whose whole content was "this host runs the thing you are building"
   * (measured 2026-09-18). Both branches are refusals, both are reached with
   * no request made, and that is what the test is for.
   */
  test("update refuses before reaching the network", async () => {
    const { deps, err, exits } = collectingDeps({ home: newConfigDir(), configDir: newConfigDir() });
    expect(await dispatchCli(["update", "--yes"], deps)).toBe(true);
    expect(exits).toEqual([1]);
    // Three refusals, all before any request. The third fires on a host whose
    // unit carries the DEV form (an interpreter plus a script path, so the
    // ladder's rung 1 answers `kind: "source"`): the update refuses to `git
    // pull` a checkout. Same measured-on-your-machine caveat as the other two.
    expect(err.join("\n")).toMatch(/no service definition|cannot replace|does not fetch releases|runs from a checkout/);
  });
});

/**
 * The init-handoff wave (spec 2026-09-26). The piped `curl | bash` install used
 * to hang at the SCRIPT's `exec < /dev/tty`, so terminal detection moved INTO
 * the CLI: `init` attaches the controlling terminal with an O_NONBLOCK open
 * that can never wait, a run that still cannot be interactive prints EVERY
 * default it takes (silence was the bug), `--yes` answers every question
 * affirmatively (operator ruling 2026-09-26), and the PATH note the installer
 * script used to echo is a question `init` asks now.
 *
 * Module-level harness shared by the three describes below. `env: {}` keeps
 * PATH undefined, which the PATH question treats as UNDECIDABLE (no PATH to
 * inspect, no offer) so cases unrelated to PATH never trip over it.
 */
function initHandoffHarness(overrides: Partial<CliDeps> = {}) {
  const dir = mkdtempSync(join(tmpdir(), `subshell-hnd-${process.pid}-`));
  const home = mkdtempSync(join(tmpdir(), `subshell-hnd-home-${process.pid}-`));
  const out: string[] = [];
  const err: string[] = [];
  const exits: number[] = [];
  let installs = 0;
  const deps: CliDeps = {
    log: (line) => void out.push(line),
    error: (line) => void err.push(line),
    exit: (code) => void exits.push(code),
    configDir: dir,
    home,
    env: {},
    which: () => "/usr/bin/tmux",
    isTTY: false,
    hostname: () => "test-host",
    // Never the real installer: a dispatch-level test must not write a real
    // unit/plist into the developer's own home (the cli-commands.test.ts lesson).
    installService: () => {
      installs++;
      return { code: 0, out: "Installed (stub).\n", err: "" };
    },
    ...overrides,
  };
  return {
    deps,
    dir,
    home,
    out,
    err,
    exits,
    get installs() {
      return installs;
    },
  };
}

describe("dispatchCli — init's non-interactive defaults announce themselves (spec 2026-09-26)", () => {
  test("non-interactive init (no --yes) installs no service and prints the default it took", async () => {
    const h = initHandoffHarness();
    expect(await dispatchCli(["init"], h.deps)).toBe(true);
    expect(h.exits).toEqual([0]);
    expect(h.installs).toBe(0);
    expect(h.out.join("\n")).toContain(
      "not interactive: background service NOT installed (run: subshell-server service install to add it, or re-run init in a terminal)",
    );
    // The handoff still lands: the config was written, the run is not a failure.
    expect(h.out.join("\n")).toContain("Open http://localhost:3080/setup");
  });

  test("non-interactive init without --yes refuses a tmux-less host and adds the terminal remedy", async () => {
    const h = initHandoffHarness({
      platform: "darwin",
      which: (n) => (n === "brew" ? "/opt/homebrew/bin/brew" : null),
    });
    let spawned = 0;
    h.deps.spawnInstall = () => {
      spawned++;
      return 0;
    };
    expect(await dispatchCli(["init"], h.deps)).toBe(true);
    expect(h.exits).toEqual([1]);
    // Neither system act happens without a person (or --yes) having said yes.
    expect(spawned).toBe(0);
    expect(h.installs).toBe(0);
    expect(h.err.join("\n")).toMatch(/tmux not found/i);
    expect(h.err.join("\n")).toContain("tmux not installed; re-run init in a terminal (or with --yes) to install it");
    // Still refuses BEFORE any write.
    expect(existsSync(join(h.dir, "config.env"))).toBe(false);
  });

  test("--yes answers tmux affirmatively: the exact brew argv runs, then the service installs", async () => {
    let installed = false;
    const spawnedArgv: string[] = [];
    const h = initHandoffHarness({
      platform: "darwin",
      which: (n) =>
        n === "brew" ? "/opt/homebrew/bin/brew" : n === "tmux" && installed ? "/opt/homebrew/bin/tmux" : null,
      spawnInstall: (argv) => {
        spawnedArgv.push(...argv);
        installed = true;
        return 0;
      },
    });
    expect(await dispatchCli(["init", "--yes"], h.deps)).toBe(true);
    expect(spawnedArgv).toEqual(["brew", "install", "tmux"]);
    expect(h.out.join("\n")).toMatch(/installing tmux via brew/);
    expect(h.out.join("\n")).toContain("registering background service…");
    expect(h.installs).toBe(1);
    expect(h.exits).toEqual([0]);
  });
});

describe("dispatchCli — init's PATH question (spec 2026-09-26)", () => {
  const EXPORT_LINE = 'export PATH="$HOME/.local/bin:$PATH"';

  /** An interactive-enough run whose ONLY confirm seams answer `confirmAnswer`. */
  function pathRun(over: Partial<CliDeps> & { confirmAnswer?: boolean } = {}) {
    const answer = over.confirmAnswer ?? true;
    const h = initHandoffHarness({ isTTY: true, env: { PATH: "/usr/bin:/bin" }, ...over });
    h.deps.prompt = () => ""; // the five config questions take their defaults
    const questions: [string, boolean][] = [];
    h.deps.confirm = (question, def) => {
      questions.push([question, def]);
      return answer;
    };
    return { ...h, questions };
  }

  const countOf = (text: string, needle: string): number => text.split(needle).length - 1;

  test("confirm-yes appends the export to .zprofile, and a re-run does not duplicate it", async () => {
    const h = pathRun();
    expect(await dispatchCli(["init", "--no-service"], h.deps)).toBe(true);
    expect(h.exits).toEqual([0]);
    const zprofile = join(h.home, ".zprofile");
    expect(h.questions[0]?.[0]).toMatch(/PATH/);
    expect(h.questions[0]?.[1]).toBe(true); // the question's default is yes
    let content = readFileSync(zprofile, "utf8");
    expect(content).toContain(EXPORT_LINE);
    expect(countOf(content, ".local/bin")).toBe(1);
    // Second run: the process PATH STILL lacks the dir (a write cannot fix this
    // process), so the question fires again and the file guard keeps it once.
    const again = pathRun({ home: h.home, configDir: h.dir });
    expect(await dispatchCli(["init", "--no-service"], again.deps)).toBe(true);
    content = readFileSync(zprofile, "utf8");
    expect(countOf(content, ".local/bin")).toBe(1);
  });

  test("answering no writes nothing", async () => {
    const h = pathRun({ confirmAnswer: false });
    expect(await dispatchCli(["init", "--no-service"], h.deps)).toBe(true);
    expect(existsSync(join(h.home, ".zprofile"))).toBe(false);
  });

  test("--yes writes without asking", async () => {
    const h = initHandoffHarness({ env: { PATH: "/usr/bin:/bin" } });
    // No `isTTY` here either, but the confirm seam is poisoned anyway: --yes
    // answers from the flag, never from a prompt.
    h.deps.confirm = () => {
      throw new Error("--yes must not consult confirm for the PATH question");
    };
    expect(await dispatchCli(["init", "--yes", "--no-service"], h.deps)).toBe(true);
    expect(readFileSync(join(h.home, ".zprofile"), "utf8")).toContain(EXPORT_LINE);
    expect(h.out.join("\n")).toMatch(/PATH: .*\.zprofile/);
  });

  test("a profile that already lists ~/.local/bin is left byte-identical", async () => {
    const h = pathRun();
    const zprofile = join(h.home, ".zprofile");
    writeFileSync(zprofile, `# mine\n${EXPORT_LINE}\n`, { mode: 0o644 });
    expect(await dispatchCli(["init", "--no-service"], h.deps)).toBe(true);
    expect(readFileSync(zprofile, "utf8")).toBe(`# mine\n${EXPORT_LINE}\n`);
  });

  test(".zshrc is appended to only when the user already has one, never created", async () => {
    const h = pathRun();
    writeFileSync(join(h.home, ".zshrc"), "# my shell\n");
    expect(await dispatchCli(["init", "--no-service"], h.deps)).toBe(true);
    expect(readFileSync(join(h.home, ".zshrc"), "utf8")).toContain(EXPORT_LINE);
    expect(readFileSync(join(h.home, ".zprofile"), "utf8")).toContain(EXPORT_LINE);

    const bare = pathRun(); // no .zshrc in this home
    expect(await dispatchCli(["init", "--no-service"], bare.deps)).toBe(true);
    expect(existsSync(join(bare.home, ".zshrc"))).toBe(false);
  });

  test("non-interactive without --yes prints the manual instructions and writes nothing", async () => {
    const h = initHandoffHarness({ env: { PATH: "/usr/bin:/bin" } });
    expect(await dispatchCli(["init"], h.deps)).toBe(true);
    const text = h.out.join("\n");
    expect(text).toMatch(/not interactive: .+ is not on your PATH\. Add it to ~\/\.zprofile with:/);
    expect(text).toContain(`    ${EXPORT_LINE}`);
    expect(existsSync(join(h.home, ".zprofile"))).toBe(false);
    // Both silent defaults speak in the same run.
    expect(text).toContain(
      "not interactive: background service NOT installed (run: subshell-server service install to add it, or re-run init in a terminal)",
    );
  });
});

/**
 * `acquirePromptInput` unit-level with a fake fs: the open MUST carry
 * O_NONBLOCK (the whole never-hangs property), and every failure degrades to
 * non-interactive. The fd it returns stays OPEN and UNTOUCHED: an earlier
 * shape of this module moved the tty onto fd 0 (close 0, re-open), and the
 * pty scenario MEASURED that bun's process.stdin keeps reading the ORIGINAL
 * pipe description after such a swap, so clack's reader starved to death on
 * a perfectly healthy terminal. The design's named fallback — the tty rides
 * its own fd and the prompts read THAT fd — is the shipped shape, and
 * `closes: []` is the pin that it stays that way.
 */
describe("acquirePromptInput", () => {
  interface FakeIo {
    io: TtyIo;
    opens: { path: string; flags: number }[];
    closes: number[];
  }
  function fakeIo(over: { stdinIsTTY?: boolean; fd?: number; failFirstOpen?: boolean } = {}): FakeIo {
    const opens: { path: string; flags: number }[] = [];
    const closes: number[] = [];
    let first = true;
    const io: TtyIo = {
      stdinIsTTY: over.stdinIsTTY ?? false,
      constants: { O_RDONLY: 0o1, O_NONBLOCK: 0o4 },
      open: (path, flags) => {
        opens.push({ path, flags });
        if (over.failFirstOpen && first) {
          first = false;
          const err = new Error("no such device or address") as NodeJS.ErrnoException;
          err.code = "ENXIO";
          throw err;
        }
        return over.fd ?? 3;
      },
      close: (fd) => void closes.push(fd),
    };
    return { io, opens, closes };
  }

  test("stdin is already a terminal: no /dev/tty open happens", () => {
    const { io, opens, closes } = fakeIo({ stdinIsTTY: true });
    const result = acquirePromptInput(io);
    expect(result).toMatchObject({ interactive: true, swapped: false });
    expect(result.fd).toBeUndefined();
    expect(opens).toEqual([]);
    expect(closes).toEqual([]);
  });

  test("piped stdin attaches /dev/tty through a NEVER-BLOCKING open, on its own fd", () => {
    const { io, opens, closes } = fakeIo({ fd: 7 });
    const result = acquirePromptInput(io);
    expect(result).toMatchObject({ interactive: true, swapped: true, fd: 7 });
    expect(opens).toEqual([{ path: "/dev/tty", flags: 0o1 | 0o4 }]);
    // NOTHING is closed: not the drained pipe on 0 (the run may still read
    // it), and certainly not the tty the prompts will read.
    expect(closes).toEqual([]);
  });

  test("the open itself answers ENXIO: non-interactive, and the reason names the tty", () => {
    const { io, closes } = fakeIo({ failFirstOpen: true });
    const result = acquirePromptInput(io);
    expect(result).toMatchObject({ interactive: false, swapped: false });
    expect(result.fd).toBeUndefined();
    expect(result.reason).toMatch(/tty/i);
    expect(closes).toEqual([]);
  });
});
