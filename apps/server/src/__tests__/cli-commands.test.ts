import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type CliDeps, dispatchCli } from "../cli.js";
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
    ...overrides,
  };
  return { deps, dir, out, err, exits };
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
  });
});

describe("dispatchCli — existing behaviour untouched", () => {
  test("boot passthrough still false; version/status untouched by the new cases", async () => {
    const { deps, exits } = harness();
    expect(await dispatchCli([], deps)).toBe(false);
    expect(await dispatchCli(["--port", "1234"], deps)).toBe(false); // leading flag = boot path (svc.sh form)
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
