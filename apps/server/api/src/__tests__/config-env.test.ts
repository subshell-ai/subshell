import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configEnvPath, loadConfigEnv, parseEnvFile, resolveConfig, serverConfigDir } from "../config-env.js";

/**
 * Save/restore guard for env-mutating tests (client `config.test.ts` idiom):
 * every key the test touches is restored in `finally`, so one suite can
 * never leak `SUBSHELL_SERVER_CONFIG_DIR` into the next.
 */
function withEnv<T>(vars: Record<string, string | undefined>, fn: () => T): T {
  const saved = new Map<string, string | undefined>();
  for (const key of Object.keys(vars)) saved.set(key, process.env[key]);
  try {
    for (const [key, value] of Object.entries(vars)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    return fn();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

/** Fresh empty config dir to point SUBSHELL_SERVER_CONFIG_DIR at. */
function newConfigDir(): string {
  return mkdtempSync(join(tmpdir(), `subshell-server-config-${process.pid}-`));
}

describe("parseEnvFile", () => {
  test("KEY=VALUE lines, first '=' splits, later duplicates win", () => {
    expect(parseEnvFile("A=1\nB=2\nA=3")).toEqual({ A: "3", B: "2" });
    expect(parseEnvFile("URL=http://x/y?z=1")).toEqual({ URL: "http://x/y?z=1" });
  });

  test("blank, whitespace-only and #comment lines are skipped", () => {
    expect(parseEnvFile("\n  \n# a comment\n   # indented comment\nA=1\n")).toEqual({ A: "1" });
  });

  test("surrounding single/double quotes are stripped (exactly one pair)", () => {
    const parsed = parseEnvFile(`D="double quoted"\nS='single quoted'\nE=""`);
    expect(parsed).toEqual({ D: "double quoted", S: "single quoted", E: "" });
  });

  test("only ONE balanced outer pair is stripped; unbalanced quotes stay verbatim", () => {
    // `"a"b"` IS wrapped in a matching `"` pair → the outer pair strips, the
    // interior quote survives. `"unbalanced'` / `'x` are not a pair → verbatim.
    expect(parseEnvFile(`BAD="unbalanced'\nMID="a"b"\nRAW='x`)).toEqual({
      BAD: `"unbalanced'`,
      MID: `a"b`,
      RAW: `'x`,
    });
  });

  test("malformed lines (no '=' / empty key) are ignored, keys and values are trimmed", () => {
    expect(parseEnvFile("JUST_A_WORD\n=novalue\n  SPACED_KEY  =  spaced value  \nOK=1")).toEqual({
      SPACED_KEY: "spaced value",
      OK: "1",
    });
  });

  test("CRLF line endings do not leak \\r into values", () => {
    expect(parseEnvFile("A=1\r\nB=2\r\n")).toEqual({ A: "1", B: "2" });
  });
});

describe("serverConfigDir / configEnvPath", () => {
  test("defaults to ~/.config/subshell-server and follows the override var", () => {
    withEnv({ SUBSHELL_SERVER_CONFIG_DIR: undefined }, () => {
      expect(serverConfigDir()).toBe(join(process.env.HOME ?? "", ".config", "subshell-server"));
    });
    withEnv({ SUBSHELL_SERVER_CONFIG_DIR: "/tmp/custom-dir" }, () => {
      expect(serverConfigDir()).toBe("/tmp/custom-dir");
      expect(configEnvPath()).toBe(join("/tmp/custom-dir", "config.env"));
    });
  });
});

describe("resolveConfig (pure)", () => {
  test("missing file: exists=false, empty values, get falls through to process.env only", () => {
    withEnv({ SUBSHELL_SERVER_CONFIG_DIR: newConfigDir(), RESOLVED_ONLY_KEY: undefined }, () => {
      const cfg = resolveConfig();
      expect(cfg.exists).toBe(false);
      expect(cfg.values).toEqual({});
      expect(cfg.get("RESOLVED_ONLY_KEY")).toBeUndefined();
    });
  });

  test("process.env shadows the file, file answers when process.env is quiet", () => {
    const dir = newConfigDir();
    writeFileSync(join(dir, "config.env"), "FROM_FILE=from-file\nSHADOWED=from-file\n");
    withEnv({ SUBSHELL_SERVER_CONFIG_DIR: dir, FROM_FILE: undefined, SHADOWED: "from-process" }, () => {
      const cfg = resolveConfig();
      expect(cfg.exists).toBe(true);
      expect(cfg.path).toBe(join(dir, "config.env"));
      expect(cfg.get("FROM_FILE")).toBe("from-file");
      expect(cfg.get("SHADOWED")).toBe("from-process");
      // Pure: resolveConfig itself never writes process.env.
      expect(process.env.FROM_FILE).toBeUndefined();
    });
  });

  test("unreadable file throws naming the path (not silently skipped)", () => {
    const dir = newConfigDir();
    mkdirSync(join(dir, "config.env")); // a DIRECTORY where the file belongs → EISDIR
    withEnv({ SUBSHELL_SERVER_CONFIG_DIR: dir }, () => {
      expect(() => resolveConfig()).toThrow(new RegExp(configEnvPath().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    });
  });
});

describe("loadConfigEnv (SETDEFAULT semantics)", () => {
  test("applies unset keys but NEVER overwrites an existing process.env value", () => {
    const dir = newConfigDir();
    writeFileSync(join(dir, "config.env"), "SERVER_PORT=4321\nAPP_NEW_KEY=from-config-env\n");
    // The saved var: a real environment (or systemd EnvironmentFile) wins.
    withEnv({ SUBSHELL_SERVER_CONFIG_DIR: dir, SERVER_PORT: "9999", APP_NEW_KEY: undefined }, () => {
      expect(loadConfigEnv()).toBe(true);
      expect(process.env.SERVER_PORT).toBe("9999");
      expect(process.env.APP_NEW_KEY).toBe("from-config-env");
    });
  });

  test("missing file is a silent false", () => {
    withEnv({ SUBSHELL_SERVER_CONFIG_DIR: newConfigDir() }, () => {
      expect(loadConfigEnv()).toBe(false);
    });
  });

  test("unreadable file throws with the path in the message", () => {
    const dir = newConfigDir();
    mkdirSync(join(dir, "config.env")); // EISDIR — anything but ENOENT must be loud
    withEnv({ SUBSHELL_SERVER_CONFIG_DIR: dir }, () => {
      expect(() => loadConfigEnv()).toThrow(/config file/);
      expect(() => loadConfigEnv()).toThrow(/config\.env/);
    });
  });
});
