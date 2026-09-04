import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseEnvFile } from "../../config-env.js";
import { runInit } from "../init.js";
import { makeDeps } from "./test-deps.js";

/**
 * `runInit` unit suite: secret bootstrap (generate-once, carry-forward,
 * env-persist), then the configure flow with flag pass-through. Same injected
 * seams as configure.test.ts — no process.env, no real HOME.
 */

const envFile = (dir: string): string => join(dir, "config.env");
const readCfg = (dir: string): Record<string, string> => parseEnvFile(readFileSync(envFile(dir), "utf8"));

describe("runInit — first run", () => {
  test("creates a 0700 config home, generates the secret, then lands the configure defaults", () => {
    const base = mkdtempSync(join(tmpdir(), `subshell-init-test-${process.pid}-`));
    const fresh = join(base, "deep", "home"); // does not exist yet — init must mkdir -p it
    const { deps, out } = makeDeps({ configDir: fresh });
    expect(runInit({ yes: true }, deps)).toBe(0);
    expect(statSync(fresh).mode & 0o777).toBe(0o700);
    const cfg = readCfg(fresh);
    // 32 random bytes as base64url = 43 chars, URL-safe alphabet, no padding.
    expect(cfg.BETTER_AUTH_SECRET).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(cfg.SERVER_PORT).toBe("3080");
    expect(cfg.DATABASE_PATH).toBe(join(fresh, "subshell.db"));
    expect(statSync(envFile(fresh)).mode & 0o777).toBe(0o600);
    expect(out.join("\n")).toMatch(/generated/i);
  });

  test("flags pass through to the configure flow (base-url default follows --port)", () => {
    const { deps, dir } = makeDeps();
    expect(runInit({ yes: true, port: "9001" }, deps)).toBe(0);
    const cfg = readCfg(dir);
    expect(cfg.SERVER_PORT).toBe("9001");
    expect(cfg.APP_BASE_URL).toBe("http://localhost:9001");
  });
});

describe("runInit — idempotence", () => {
  test("a second init does NOT regenerate or change the secret (file byte-stable)", () => {
    const { deps, dir } = makeDeps();
    expect(runInit({ yes: true }, deps)).toBe(0);
    const before = readFileSync(envFile(dir), "utf8");
    expect(runInit({ yes: true }, deps)).toBe(0);
    const after = readFileSync(envFile(dir), "utf8");
    expect(after).toBe(before); // same secret, same order, no timestamp churn
  });

  test("a secret already in config.env is left untouched even when the file predates init", () => {
    const { deps, dir, out } = makeDeps();
    writeFileSync(envFile(dir), "BETTER_AUTH_SECRET=legacy-secret\nSERVER_PORT=2222\n", { mode: 0o600 });
    expect(runInit({ yes: true }, deps)).toBe(0);
    const cfg = readCfg(dir);
    expect(cfg.BETTER_AUTH_SECRET).toBe("legacy-secret");
    expect(cfg.SERVER_PORT).toBe("3080"); // configure flow still owns/rewrites its keys
    expect(out.join("\n")).toMatch(/left untouched/i);
  });

  test("a secret only in the environment is persisted to config.env, not regenerated", () => {
    const { deps, dir } = makeDeps({ env: { BETTER_AUTH_SECRET: "from-the-environment" } });
    expect(runInit({ yes: true }, deps)).toBe(0);
    expect(readCfg(dir).BETTER_AUTH_SECRET).toBe("from-the-environment");
  });

  test("an empty-string secret in the file counts as absent and gets replaced", () => {
    const { deps, dir } = makeDeps();
    writeFileSync(envFile(dir), "BETTER_AUTH_SECRET=\n", { mode: 0o600 });
    expect(runInit({ yes: true }, deps)).toBe(0);
    expect(readCfg(dir).BETTER_AUTH_SECRET).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
});

describe("runInit — tmux preflight", () => {
  test("refuses before ANY write: no config home, no secret, no config.env", () => {
    const fresh = join(mkdtempSync(join(tmpdir(), `subshell-init-nix-${process.pid}-`)), "home");
    const { deps, err } = makeDeps({ configDir: fresh, which: () => null });
    expect(runInit({ yes: true }, deps)).toBe(1);
    expect(err.join("\n")).toMatch(/tmux not found/i);
    expect(statSync(fresh, { throwIfNoEntry: false })).toBeUndefined();
  });

  test("the skip env is honored", () => {
    const { deps, dir } = makeDeps({ which: () => null, env: { SUBSHELL_SERVER_SKIP_TMUX_CHECK: "1" } });
    expect(runInit({ yes: true }, deps)).toBe(0);
    expect(readCfg(dir).BETTER_AUTH_SECRET).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  test("interactive offer + install success → init CONTINUES (secret + config written, no rerun)", () => {
    let installed = false;
    const { deps, dir, out, prompts } = makeDeps({
      isTTY: true,
      platform: "linux",
      which: (n) => (n === "apt-get" ? "/usr/bin/apt-get" : n === "tmux" && installed ? "/usr/bin/tmux" : null),
      spawnInstall: () => {
        installed = true;
        return 0;
      },
      answers: ["y", "", "", "", ""],
    });
    expect(runInit({}, deps)).toBe(0);
    expect(prompts[0]?.[0]).toMatch(/Install tmux now with apt-get\?/i);
    expect(out.join("\n")).toMatch(/tmux installed/i);
    // Continued all the way through: BOTH the preflight-then-write path ran.
    expect(readCfg(dir).BETTER_AUTH_SECRET).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(readCfg(dir).SERVER_PORT).toBe("3080");
  });

  test("--yes never offers, even with an installer on PATH (shared gate with configure)", () => {
    let spawned = 0;
    const { deps, prompts } = makeDeps({
      isTTY: true,
      platform: "linux",
      which: (n) => (n === "apt-get" ? "/usr/bin/apt-get" : null),
      spawnInstall: () => {
        spawned++;
        return 0;
      },
    });
    expect(runInit({ yes: true }, deps)).toBe(1);
    expect(prompts).toEqual([]);
    expect(spawned).toBe(0);
  });
});
