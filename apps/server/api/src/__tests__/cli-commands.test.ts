import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type CliDeps, dispatchCli } from "../cli.js";
import { FLAG_FOR_KEY } from "../commands/configure.js";
import { parseEnvFile } from "../config-env.js";

/**
 * Dispatch-level tests for `init`/`configure`: the hand-rolled flag parser,
 * usage/error exits, and the deps plumbing (configDir/env/which/isTTY flow
 * from CliDeps into the command deps). The command FLOWS themselves are
 * covered unit-style in commands/__tests__ — this file owns the CLI surface.
 */

function newDir(): string {
  return mkdtempSync(join(tmpdir(), `subshell-clicmd-test-${process.pid}-`));
}

function harness(overrides: Partial<CliDeps> = {}) {
  const dir = newDir();
  const out: string[] = [];
  const err: string[] = [];
  const exits: number[] = [];
  let installs = 0;
  const deps: CliDeps = {
    log: (line) => void out.push(line),
    error: (line) => void err.push(line),
    exit: (code) => void exits.push(code),
    probePort: () => false,
    // CLI defaults a real run would supply: config home pinned to a temp dir,
    // tmux present, env pinned empty (no runner leakage), never a TTY.
    configDir: dir,
    env: {},
    which: () => "/usr/bin/tmux",
    isTTY: false,
    prompt: () => {
      throw new Error("prompt must not be consulted: no test here is interactive");
    },
    // `init` installs a background service now, so the seam is stubbed by
    // DEFAULT here: without it a dispatch-level test writes a real launchd
    // plist (or systemd unit) into the developer's own home and bootstraps it.
    // That happened while this feature was being built.
    installService: () => {
      installs++;
      return { code: 0, out: "Installed (stub).\n", err: "" };
    },
    // Second lock, for anything that reaches service.ts another way.
    home: join(dir, "fake-home"),
    hostname: () => "test-host",
    ...overrides,
  };
  return {
    deps,
    dir,
    out,
    err,
    exits,
    get installs() {
      return installs;
    },
  };
}

const cfgOf = (dir: string): Record<string, string> => parseEnvFile(readFileSync(join(dir, "config.env"), "utf8"));

describe("dispatchCli — configure", () => {
  test("`configure --yes` writes the defaults and exits 0 (handled)", async () => {
    const { deps, dir, exits } = harness();
    expect(await dispatchCli(["configure", "--yes"], deps)).toBe(true);
    expect(exits).toEqual([0]);
    expect(cfgOf(dir).SERVER_PORT).toBe("3080");
  });

  test("space and =flag forms both parse", async () => {
    const a = harness();
    expect(await dispatchCli(["configure", "--port", "9001", "--yes"], a.deps)).toBe(true);
    expect(cfgOf(a.dir)).toMatchObject({ SERVER_PORT: "9001", APP_BASE_URL: "http://localhost:9001" });
    const b = harness();
    expect(await dispatchCli(["configure", "--port=9002", "--host=0.0.0.0", "--yes"], b.deps)).toBe(true);
    expect(cfgOf(b.dir)).toMatchObject({ SERVER_PORT: "9002", HOST: "0.0.0.0" });
  });

  test("unknown flag → error + usage + exit(1), nothing written", async () => {
    const { deps, dir, err, exits } = harness();
    expect(await dispatchCli(["configure", "--frobnicate", "x"], deps)).toBe(true);
    expect(exits).toEqual([1]);
    expect(err.join("\n")).toContain("unknown flag '--frobnicate'");
    expect(err.join("\n")).toContain("usage:");
    expect(() => readFileSync(join(dir, "config.env"))).toThrow();
  });

  test("value flag missing its value (or shadowed by another flag) → exit(1)", async () => {
    for (const argv of [
      ["configure", "--port"],
      ["configure", "--port", "--yes"],
      ["configure", "--host="],
    ]) {
      const { deps, exits } = harness();
      expect(await dispatchCli(argv, deps)).toBe(true);
      expect(exits).toEqual([1]);
    }
  });

  test("a stray positional is rejected", async () => {
    for (const argv of [
      ["configure", "extra"],
      ["configure", "--yes", "extra"],
      ["init", "extra"],
    ]) {
      const { deps, exits, err } = harness();
      expect(await dispatchCli(argv, deps)).toBe(true);
      expect(exits).toEqual([1]);
      expect(err.join("\n")).toMatch(/unexpected argument/);
    }
  });

  test("--yes takes no value", async () => {
    const { deps, exits } = harness();
    expect(await dispatchCli(["configure", "--yes=1"], deps)).toBe(true);
    expect(exits).toEqual([1]);
  });

  test("tmux missing → refusal + exit(1) with nothing written; SKIP env lets it through", async () => {
    const blocked = harness({ which: () => null });
    expect(await dispatchCli(["configure", "--yes"], blocked.deps)).toBe(true);
    expect(blocked.exits).toEqual([1]);
    expect(blocked.err.join("\n")).toMatch(/tmux/i);
    expect(() => readFileSync(join(blocked.dir, "config.env"))).toThrow();

    const skipped = harness({ which: () => null, env: { SUBSHELL_SERVER_SKIP_TMUX_CHECK: "1" } });
    expect(await dispatchCli(["configure", "--yes"], skipped.deps)).toBe(true);
    expect(skipped.exits).toEqual([0]);
    expect(cfgOf(skipped.dir).SERVER_PORT).toBe("3080");
  });

  test("--trusted-origins takes a comma-separated list", async () => {
    const { deps, dir, exits } = harness();
    expect(
      await dispatchCli(
        ["configure", "--trusted-origins", "http://box.local:3080,http://10.0.0.5:3080", "--yes"],
        deps,
      ),
    ).toBe(true);
    expect(exits).toEqual([0]);
    expect(cfgOf(dir).TRUSTED_ORIGINS).toBe("http://box.local:3080,http://10.0.0.5:3080");
  });

  /**
   * The ONE flag whose empty value is a real answer: "no extra origins". Every
   * other value flag keeps the refusal — an empty port is a typo, an empty
   * origin list is a choice — and since a stored value is now the default,
   * this is the only way a caller can CLEAR the list.
   */
  test("--trusted-origins accepts an EMPTY value, and it clears the stored list", async () => {
    for (const argv of [
      ["configure", "--trusted-origins", "", "--yes"],
      ["configure", "--trusted-origins=", "--yes"],
    ]) {
      const { deps, dir, exits } = harness();
      writeFileSync(join(dir, "config.env"), "TRUSTED_ORIGINS=http://box.local:3080\n", { mode: 0o600 });
      expect(await dispatchCli(argv, deps)).toBe(true);
      expect(exits).toEqual([0]);
      expect(cfgOf(dir).TRUSTED_ORIGINS).toBeUndefined();
    }
  });

  test("--trusted-origins still refuses a MISSING value, or one shadowed by a flag", async () => {
    for (const argv of [
      ["configure", "--trusted-origins"],
      ["configure", "--trusted-origins", "--yes"],
    ]) {
      const { deps, exits } = harness();
      expect(await dispatchCli(argv, deps)).toBe(true);
      expect(exits).toEqual([1]);
    }
  });

  test("an unusable trusted origin exits 1 with zero writes", async () => {
    const { deps, dir, exits, err } = harness();
    expect(await dispatchCli(["configure", "--trusted-origins", "box.local:3080", "--yes"], deps)).toBe(true);
    expect(exits).toEqual([1]);
    expect(err.join("\n")).toMatch(/trusted origin/i);
    expect(() => readFileSync(join(dir, "config.env"))).toThrow();
  });

  /**
   * `configure.ts` names a flag per key so a refusal can say how to get past a
   * bad STORED value. A renamed flag would leave that message pointing at one
   * the parser rejects — advice that fails when followed. Asserted through the
   * parser rather than by exporting its flag set: what matters is that each
   * named flag is actually accepted.
   */
  test("every flag configure.ts advertises in a refusal is one the parser accepts", async () => {
    // Acceptance is the whole claim — that following the advice does not die on
    // `unknown flag`. What each flag then DOES with its value is covered
    // per-flag above; there is no single value that is invalid for all five
    // (an empty origin list is legal, and almost any string is a valid host).
    for (const [key, flag] of Object.entries(FLAG_FOR_KEY)) {
      const { deps, err } = harness();
      expect(await dispatchCli(["configure", `${flag}=x`, "--yes"], deps)).toBe(true);
      expect(err.join("\n"), `${key} → ${flag}`).not.toContain("unknown flag");
    }
  });

  test("validation failure exits 1 with zero writes", async () => {
    const { deps, dir, exits, err } = harness();
    expect(await dispatchCli(["configure", "--port", "70000", "--yes"], deps)).toBe(true);
    expect(exits).toEqual([1]);
    expect(err.join("\n")).toMatch(/port/i);
    expect(() => readFileSync(join(dir, "config.env"))).toThrow();
  });
});

describe("dispatchCli — init", () => {
  test("`init --yes` generates the secret and writes config.env, exit 0", async () => {
    const { deps, dir, exits } = harness();
    expect(await dispatchCli(["init", "--yes"], deps)).toBe(true);
    expect(exits).toEqual([0]);
    expect(cfgOf(dir).BETTER_AUTH_SECRET).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(cfgOf(dir).SERVER_PORT).toBe("3080");
  });

  test("init is idempotent through the CLI: the secret survives a second run", async () => {
    const { deps, dir } = harness();
    await dispatchCli(["init", "--yes"], deps);
    const before = readFileSync(join(dir, "config.env"), "utf8");
    await dispatchCli(["init", "--yes"], deps);
    expect(readFileSync(join(dir, "config.env"), "utf8")).toBe(before);
  });

  test("tmux missing blocks init BEFORE the config home exists", async () => {
    const missing = join(newDir(), "absent"); // init must NOT create this
    const { deps, exits, err } = harness({ configDir: missing, which: () => null });
    expect(await dispatchCli(["init", "--yes"], deps)).toBe(true);
    expect(exits).toEqual([1]);
    expect(err.join("\n")).toMatch(/tmux not found/i);
    expect(() => readFileSync(join(missing, "config.env"))).toThrow();
  });

  test("usage lists init and configure", async () => {
    const { deps, err } = harness();
    await dispatchCli(["frobnicate"], deps);
    const text = err.join("\n");
    expect(text).toContain("init");
    expect(text).toContain("configure");
    expect(text).toContain("--base-url");
    expect(text).toContain("--trusted-origins");
  });
});

describe("dispatchCli — service install|uninstall", () => {
  /**
   * Dispatch-level service harness: the manager commands are stubbed via the
   * `runCmd` seam, but the unit/plist WRITE is the real sync fs pointed at a
   * temp `home` — so the artifact lands where we can read it and `~/.config`
   * is never touched (client test-suite intent, temp-dir discipline).
   */
  function serviceHarness(
    over: Partial<CliDeps> & { respond?: (cmd: string[]) => { code: number; out: string; err: string } } = {},
  ) {
    const { respond, ...cliOver } = over;
    const h = harness({ pathEnv: "/usr/bin:/bin", ...cliOver });
    const calls: string[][] = [];
    h.deps.runCmd = (cmd) => {
      calls.push(cmd);
      return respond?.(cmd) ?? { code: 0, out: "", err: "" };
    };
    // A login session's env (harness defaults env = {}) unless overridden.
    if (cliOver.env === undefined) h.deps.env = { XDG_RUNTIME_DIR: "/run/user/1000" };
    return { ...h, calls };
  }

  const unitPathOf = (home: string) => join(home, ".config", "systemd", "user", "subshell-server.service");

  test("`service install` writes the real unit into the injected home and runs the full sequence", async () => {
    const { deps, dir, calls, exits, out } = serviceHarness({
      platform: "linux",
      home: mkdtempSync(join(tmpdir(), `subshell-svc-home-${process.pid}-`)),
      servicePath: "/usr/local/bin/subshell-server",
      argv1: "/repo/apps/server/api/src/index.ts",
      // Deliberately a user who does NOT linger, so the hint below is asserted
      // against a stated answer rather than against an empty stub reply.
      respond: (cmd) =>
        cmd[0] === "loginctl" ? { code: 0, out: "Linger=no\n", err: "" } : { code: 0, out: "", err: "" },
    });
    writeFileSync(join(dir, "config.env"), "SERVER_PORT=3080\n", { mode: 0o600 });

    expect(await dispatchCli(["service", "install"], deps)).toBe(true);
    expect(exits).toEqual([0]);
    const unit = readFileSync(unitPathOf(deps.home as string), "utf8");
    expect(unit).toContain(`EnvironmentFile=${join(dir, "config.env")}`);
    expect(unit).toContain("Environment=PATH=/usr/bin:/bin");
    expect(unit).toContain("WorkingDirectory=");
    expect(unit).toContain("ExecStart=/usr/local/bin/subshell-server");
    expect(calls).toEqual([
      ["systemctl", "--user", "is-system-running"],
      ["systemctl", "--user", "daemon-reload"],
      ["systemctl", "--user", "enable", "--now", "subshell-server.service"],
      ["loginctl", "show-user", `${process.getuid?.() ?? 0}`, "--property=Linger"],
    ]);
    expect(out.join("\n")).toContain("loginctl enable-linger");
  });

  test("`service install` without config.env: exit 1 pointing at init, no unit, no commands", async () => {
    const { deps, dir, calls, exits, err } = serviceHarness({
      platform: "linux",
      home: mkdtempSync(join(tmpdir(), `subshell-svc-home-${process.pid}-`)),
    });
    expect(await dispatchCli(["service", "install"], deps)).toBe(true);
    expect(exits).toEqual([1]);
    expect(err.join("\n")).toContain("run subshell-server init first");
    // The harness dir is the CONFIG dir — it stayed empty (the unit would
    // hang off `home`, which is a different temp dir here).
    expect(() => readFileSync(join(dir, "config.env"))).toThrow();
    expect(calls).toEqual([]);
  });

  test("tmux missing blocks install before anything happens; the SKIP var clears it", async () => {
    const home = mkdtempSync(join(tmpdir(), `subshell-svc-home-${process.pid}-`));
    const blocked = serviceHarness({ platform: "linux", home, which: () => null });
    writeFileSync(join(blocked.dir, "config.env"), "SERVER_PORT=3080\n", { mode: 0o600 });
    expect(await dispatchCli(["service", "install"], blocked.deps)).toBe(true);
    expect(blocked.exits).toEqual([1]);
    expect(blocked.err.join("\n")).toMatch(/tmux/i);
    expect(blocked.calls).toEqual([]);
    expect(() => readFileSync(unitPathOf(home))).toThrow();

    const skipped = serviceHarness({
      platform: "linux",
      home,
      which: () => null,
      env: { XDG_RUNTIME_DIR: "/run/user/1000", SUBSHELL_SERVER_SKIP_TMUX_CHECK: "1" },
    });
    writeFileSync(join(skipped.dir, "config.env"), "SERVER_PORT=3080\n", { mode: 0o600 });
    expect(await dispatchCli(["service", "install"], skipped.deps)).toBe(true);
    expect(skipped.exits).toEqual([0]);
  });

  test("`service uninstall` with nothing installed: exit 0, 'nothing installed', no commands", async () => {
    const { deps, calls, exits, out } = serviceHarness({
      platform: "linux",
      home: mkdtempSync(join(tmpdir(), `subshell-svc-home-${process.pid}-`)),
    });
    expect(await dispatchCli(["service", "uninstall"], deps)).toBe(true);
    expect(exits).toEqual([0]);
    expect(out.join("\n")).toContain("nothing installed");
    expect(calls).toEqual([]);
  });

  test("verb handling: bare `service`, an unknown verb, and stray args are usage errors with no side effects", async () => {
    for (const argv of [["service"], ["service", "frobnicate"], ["service", "install", "extra"]]) {
      const { deps, calls, exits, err } = serviceHarness({
        platform: "linux",
        home: mkdtempSync(join(tmpdir(), `subshell-svc-home-${process.pid}-`)),
      });
      expect(await dispatchCli(argv, deps)).toBe(true);
      expect(exits).toEqual([1]);
      expect(err.join("\n")).toContain("usage:");
      expect(calls).toEqual([]);
    }
  });

  test("usage lists the service command", async () => {
    const { deps, err } = harness();
    await dispatchCli(["frobnicate"], deps);
    expect(err.join("\n")).toContain("service install");
  });
});

describe("dispatchCli — status service line", () => {
  test("reports the unit definition's existence on disk (linux shape)", async () => {
    const home = mkdtempSync(join(tmpdir(), `subshell-svc-home-${process.pid}-`));
    const { deps, out } = harness({ platform: "linux", home });
    await dispatchCli(["status"], deps);
    expect(out.join("\n")).toContain(
      `not installed (${join(home, ".config", "systemd", "user", "subshell-server.service")})`,
    );

    mkdirSync(join(home, ".config", "systemd", "user"), { recursive: true });
    writeFileSync(join(home, ".config", "systemd", "user", "subshell-server.service"), "[Unit]\n");
    const second = harness({ platform: "linux", home });
    await dispatchCli(["status"], second.deps);
    expect(second.out.join("\n")).toContain("definition installed");
  });

  test("unsupported platform reports n/a, not a path", async () => {
    const { deps, out } = harness({ platform: "win32" as NodeJS.Platform, home: "/nowhere" });
    await dispatchCli(["status"], deps);
    expect(out.join("\n")).toContain("n/a (no per-user service manager");
  });
});

describe("dispatchCli — existing behaviour untouched", () => {
  test("boot passthrough still false; version/status untouched by the new cases", async () => {
    const { deps, exits } = harness();
    expect(await dispatchCli([], deps)).toBe(false);
    expect(await dispatchCli(["--port", "1234"], deps)).toBe(false); // leading flag = boot path (systemd form)
    expect(exits).toEqual([]);
    const v = harness();
    expect(await dispatchCli(["version"], v.deps)).toBe(true);
    expect(v.out[0]).toMatch(/^subshell-server \d+\.\d+\.\d+/);
  });

  test("pre-existing keys in config.env are preserved by CLI-level configure", async () => {
    const { deps, dir } = harness();
    writeFileSync(join(dir, "config.env"), "BETTER_AUTH_SECRET=abc\nTRUSTED_ORIGINS=http://x:1\n", { mode: 0o600 });
    expect(await dispatchCli(["configure", "--yes"], deps)).toBe(true);
    expect(cfgOf(dir)).toMatchObject({
      BETTER_AUTH_SECRET: "abc",
      TRUSTED_ORIGINS: "http://x:1",
      SERVER_PORT: "3080",
    });
  });
});

/**
 * The service flags and the handoff at the CLI surface (spec 2026-09-15 §4.1).
 * The command flows are covered unit-style in `commands/__tests__`; this file
 * owns what the parser accepts and where the sentence is printed.
 */
describe("dispatchCli — init's service question at the CLI surface", () => {
  test("`init --yes` installs the service: the default is yes, and nobody is asked", async () => {
    const h = harness();
    expect(await dispatchCli(["init", "--yes"], h.deps)).toBe(true);
    expect(h.exits).toEqual([0]);
    expect(h.installs).toBe(1);
  });

  test("--no-service is the scripted opt-out", async () => {
    const h = harness();
    expect(await dispatchCli(["init", "--yes", "--no-service"], h.deps)).toBe(true);
    expect(h.exits).toEqual([0]);
    expect(h.installs).toBe(0);
  });

  test("--service is the explicit opposite", async () => {
    const h = harness();
    expect(await dispatchCli(["init", "--yes", "--service"], h.deps)).toBe(true);
    expect(h.installs).toBe(1);
  });

  // `configure` installs nothing, so accepting the flag there would be a flag
  // that silently does nothing — the way a caller learns a flag is noise.
  test("configure refuses the service flags", async () => {
    const h = harness();
    expect(await dispatchCli(["configure", "--yes", "--no-service"], h.deps)).toBe(true);
    expect(h.exits).toEqual([1]);
    expect(h.err.join("\n")).toContain("unknown flag '--no-service'");
  });

  test("a value on a boolean flag is a usage error, not a silently dropped word", async () => {
    const h = harness();
    expect(await dispatchCli(["init", "--no-service=please"], h.deps)).toBe(true);
    expect(h.exits).toEqual([1]);
    expect(h.err.join("\n")).toContain("'--no-service' takes no value");
  });

  test("usage names both service flags", async () => {
    const h = harness();
    await dispatchCli(["frobnicate"], h.deps);
    expect(h.err.join("\n")).toContain("--no-service");
  });

  test("init hands off to /setup with the configured base URL", async () => {
    const h = harness();
    await dispatchCli(["init", "--yes", "--no-service", "--base-url", "http://box.local:3080"], h.deps);
    expect(h.out.join("\n")).toContain("Open http://box.local:3080/setup in a browser to create the admin account.");
  });
});

describe("dispatchCli — service install hands off too", () => {
  // The two commands a person ends on must say the same thing, from one
  // helper: an operator who ran `init --no-service` and then `service install`
  // is standing exactly where the `init` path leaves someone.
  test("a successful install prints the same /setup line", async () => {
    const h = harness();
    await dispatchCli(["init", "--yes", "--no-service", "--base-url", "http://box.local:3080"], h.deps);
    const install = harness({
      configDir: h.dir,
      platform: "linux",
      env: { XDG_RUNTIME_DIR: "/run/user/1000" },
      runCmd: () => ({ code: 0, out: "", err: "" }),
    });
    expect(await dispatchCli(["service", "install"], install.deps)).toBe(true);
    expect(install.exits).toEqual([0]);
    expect(install.out.join("\n")).toContain("http://box.local:3080/setup");
  });

  test("a FAILED install says nothing about /setup — nothing is listening there", async () => {
    const h = harness();
    await dispatchCli(["init", "--yes", "--no-service"], h.deps);
    const install = harness({
      configDir: h.dir,
      platform: "linux",
      env: { XDG_RUNTIME_DIR: "/run/user/1000" },
      runCmd: () => ({ code: 1, out: "", err: "Failed to connect to bus\n" }),
    });
    await dispatchCli(["service", "install"], install.deps);
    expect(install.exits).toEqual([1]);
    expect(install.out.join("\n")).not.toContain("/setup");
  });
});
