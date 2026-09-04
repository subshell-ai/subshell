import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type CliDeps, dispatchCli } from "../cli.js";

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

  test("a leading flag is NOT a subcommand → false (svc.sh/systemd boot form)", async () => {
    const { deps } = collectingDeps();
    expect(await dispatchCli(["--help"], deps)).toBe(false);
    expect(await dispatchCli(["-v", "extra"], deps)).toBe(false);
  });
});

describe("dispatchCli — version", () => {
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
    // stdio transport milliseconds after `ready` (apps/client's T18 lesson;
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
    expect(text).toContain("127.0.0.1"); // HOST default
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
    // HOST may legitimately be set in the runner's environment (svc.sh host
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
