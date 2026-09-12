import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { type CliDeps, dispatchCli } from "../cli.js";
import { DATABASE_PATH, SUBSHELL_PLUGIN_REGISTRY_URL, SUBSHELL_SERVER_DATA_DIR } from "../constants.js";

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
    expect(Object.keys(view.paths).sort()).toEqual(["dataDir", "database", "logsDir", "nodeArtifacts", "serverLog"]);
    expect(isAbsolute(view.paths.dataDir)).toBe(true);
    expect(view.paths.dataDir).toBe(SUBSHELL_SERVER_DATA_DIR);
    expect(view.paths.database).toBe(DATABASE_PATH);
    expect(view.paths.logsDir).toBe(`${SUBSHELL_SERVER_DATA_DIR}/subshells`);
    // Inside dataDir on purpose: a reset deletes the data directory, and the
    // server log goes with it rather than needing a path of its own.
    expect(view.paths.serverLog).toBe(`${SUBSHELL_SERVER_DATA_DIR}/logs/server.log`);
    // Already a StatusView fact: the paths block must not be a second source.
    expect(view.paths.nodeArtifacts).toBe(view.nodeArtifacts.dir);
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
    // ISOLATED: with no `runCmd` injected, `DEFAULT_DEPS` builds the real one
    // and `configDir` resolves to the DEVELOPER'S `~/.config/subshell-server`
    // — so on a Linux box with a config.env and a live user session this test
    // would write a unit file and run `systemctl --user start` for real. The
    // flag parse happens before any of that; everything else here is stubbed
    // so the test proves the parse and touches nothing.
    const calls: string[][] = [];
    const { deps, err } = collectingDeps({
      platform: "linux",
      home: "/home/nobody-here",
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

  /** collectingDeps plus a recording runCmd that answers `systemctl show` with `props`. */
  function linuxDeps(home: string, props: Record<string, string>) {
    const calls: string[][] = [];
    const base = collectingDeps({
      platform: "linux",
      home,
      runCmd: (cmd) => {
        calls.push(cmd);
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
