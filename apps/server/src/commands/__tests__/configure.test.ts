import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseEnvFile } from "../../config-env.js";
import { runConfigure } from "../configure.js";
import { makeDeps } from "./test-deps.js";

/**
 * `runConfigure` unit suite — every stdio/IO seam injected (prompt, which,
 * env, log, error, configDir), so the suite never touches process.env,
 * ~/.config, or a TTY. The command is contract-sync: it returns an exit code
 * and does all fs work with sync primitives (cli.ts invariant 1).
 */

const envFile = (dir: string): string => join(dir, "config.env");
const readCfg = (dir: string): Record<string, string> => parseEnvFile(readFileSync(envFile(dir), "utf8"));

describe("runConfigure — non-interactive (--yes / non-TTY)", () => {
  test("accepts every default; writes the four keys at 0600; prompts nobody", () => {
    const { deps, dir, out, err, prompts } = makeDeps();
    expect(runConfigure({ yes: true }, deps)).toBe(0);
    expect(prompts).toEqual([]);
    expect(err).toEqual([]);
    const cfg = readCfg(dir);
    expect(cfg.SERVER_PORT).toBe("3080");
    expect(cfg.HOST).toBe("127.0.0.1");
    expect(cfg.APP_BASE_URL).toBe("http://localhost:3080");
    expect(cfg.DATABASE_PATH).toBe(join(dir, "subshell.db"));
    // config home owns a secret file: 0600 on the file, 0700 on the dir.
    expect(statSync(envFile(dir)).mode & 0o777).toBe(0o600);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(out.join("\n")).toContain(envFile(dir));
  });

  test("flags override prompts (prompt seam would throw if consulted)", () => {
    const { deps, dir } = makeDeps();
    expect(
      runConfigure(
        { port: "9001", host: "0.0.0.0", baseUrl: "https://sub.example.test", dbPath: "/srv/db/subshell.db" },
        deps,
      ),
    ).toBe(0);
    const cfg = readCfg(dir);
    expect(cfg).toEqual({
      SERVER_PORT: "9001",
      HOST: "0.0.0.0",
      APP_BASE_URL: "https://sub.example.test",
      DATABASE_PATH: "/srv/db/subshell.db",
    });
  });

  test("non-TTY without --yes implies --yes: nobody is prompted, defaults land", () => {
    const { deps, dir, prompts } = makeDeps({ isTTY: false });
    expect(runConfigure({}, deps)).toBe(0);
    expect(prompts).toEqual([]);
    expect(readCfg(dir).SERVER_PORT).toBe("3080");
  });
});

describe("runConfigure — rewrite preservation", () => {
  test("BETTER_AUTH_SECRET and foreign keys carry forward untouched; owned keys update", () => {
    const { deps, dir } = makeDeps();
    writeFileSync(
      envFile(dir),
      "# a hand-written comment that a rewrite is allowed to drop\n" +
        "BETTER_AUTH_SECRET=s3cr3t-value-not-to-be-touched\n" +
        "SERVER_PORT=1111\n" +
        "TRUSTED_ORIGINS=http://elsewhere:5174\n",
      { mode: 0o600 },
    );
    expect(runConfigure({ port: "4000" }, deps)).toBe(0);
    const cfg = readCfg(dir);
    expect(cfg.BETTER_AUTH_SECRET).toBe("s3cr3t-value-not-to-be-touched");
    expect(cfg.TRUSTED_ORIGINS).toBe("http://elsewhere:5174"); // foreign key preserved
    expect(cfg.SERVER_PORT).toBe("4000"); // owned key overwritten by the flow
    expect(cfg.HOST).toBe("127.0.0.1");
    // Existing keys keep their file position; a rewrite never re-invents values.
    expect(readFileSync(envFile(dir), "utf8")).toContain("s3cr3t-value-not-to-be-touched");
  });

  test("unreadable existing config.env (EISDIR) refuses — the command never clobbers what it cannot read", () => {
    const { deps, dir, err } = makeDeps();
    mkdirSync(envFile(dir)); // a DIRECTORY where the file belongs → readFileSync EISDIR
    expect(runConfigure({ yes: true }, deps)).toBe(1);
    expect(err.join("\n")).toContain("config.env");
  });
});

describe("runConfigure — validation before any write", () => {
  for (const bad of ["0", "-1", "70000", "abc", "1.5", "", "3 080"]) {
    test(`invalid port '${bad}' → exit 1, zero writes`, () => {
      const { deps, dir, err } = makeDeps();
      expect(runConfigure({ yes: true, port: bad }, deps)).toBe(1);
      expect(err.join("\n")).toMatch(/port/i);
      expect(statSync(dir).mode & 0o777).toBe(0o700); // the temp harness dir existed before the call
      expect(() => readFileSync(envFile(dir))).toThrow(); // and still holds nothing
    });
  }

  for (const bad of ["ftp://sub.example", "not a url", "localhost:3080"]) {
    test(`invalid base URL '${bad}' → exit 1, zero writes`, () => {
      const { deps, dir, err } = makeDeps();
      expect(runConfigure({ yes: true, baseUrl: bad }, deps)).toBe(1);
      expect(err.join("\n")).toMatch(/base[- ]url/i);
      expect(() => readFileSync(envFile(dir))).toThrow();
    });
  }

  test("empty db path → exit 1, zero writes", () => {
    const { deps, dir, err } = makeDeps();
    expect(runConfigure({ yes: true, dbPath: "   " }, deps)).toBe(1);
    expect(err.join("\n")).toMatch(/database path/i);
    expect(() => readFileSync(envFile(dir))).toThrow();
  });

  test("a value with a newline cannot smuggle extra config.env lines", () => {
    const { deps, dir } = makeDeps();
    expect(runConfigure({ yes: true, dbPath: "/srv/x.db\nEVIL=1" }, deps)).toBe(1);
    expect(() => readFileSync(envFile(dir))).toThrow();
  });
});

describe("runConfigure — loopback / LAN warning", () => {
  test("LAN bind (0.0.0.0) + loopback base URL → warned, accepted anyway", () => {
    const { deps, dir, out } = makeDeps();
    expect(runConfigure({ yes: true, host: "0.0.0.0" }, deps)).toBe(0);
    const text = out.join("\n");
    expect(text).toMatch(/warning/i);
    expect(text).toMatch(/loopback/i);
    expect(text).toMatch(/remote nodes/i); // the enroll-time trap, mirrored
    expect(readCfg(dir).HOST).toBe("0.0.0.0"); // and still written
    expect(readCfg(dir).APP_BASE_URL).toBe("http://localhost:3080");
  });

  test("LAN bind + reachable base URL → no warning", () => {
    const { deps, out } = makeDeps();
    expect(runConfigure({ yes: true, host: "0.0.0.0", baseUrl: "http://10.0.0.5:3080" }, deps)).toBe(0);
    expect(out.join("\n")).not.toMatch(/warning/i);
  });

  test("loopback bind + loopback base URL → no warning (single-machine setup)", () => {
    const { deps, out } = makeDeps();
    expect(runConfigure({ yes: true }, deps)).toBe(0);
    expect(out.join("\n")).not.toMatch(/warning/i);
  });
});

describe("runConfigure — tmux preflight", () => {
  test("tmux missing refuses BEFORE any write, with platform hint + escape hatch", () => {
    const { deps, dir, err } = makeDeps({ which: () => null });
    expect(runConfigure({ yes: true }, deps)).toBe(1);
    const text = err.join("\n");
    expect(text).toMatch(/tmux not found/i);
    expect(text).toContain(process.platform === "darwin" ? "brew install tmux" : "apt install tmux");
    expect(text).toContain("SUBSHELL_SERVER_SKIP_TMUX_CHECK=1");
    expect(() => readFileSync(envFile(dir))).toThrow();
  });

  test("SUBSHELL_SERVER_SKIP_TMUX_CHECK=1 is the escape hatch", () => {
    const { deps, dir } = makeDeps({
      which: () => null,
      env: { SUBSHELL_SERVER_SKIP_TMUX_CHECK: "1" },
    });
    expect(runConfigure({ yes: true }, deps)).toBe(0);
    expect(readCfg(dir).SERVER_PORT).toBe("3080");
  });

  test("the skip flag alone (any other value) does NOT skip", () => {
    const { deps, dir } = makeDeps({ which: () => null, env: { SUBSHELL_SERVER_SKIP_TMUX_CHECK: "yes" } });
    expect(runConfigure({ yes: true }, deps)).toBe(1);
    expect(() => readFileSync(envFile(dir))).toThrow();
  });
});

describe("runConfigure — interactive flow", () => {
  test("four questions with defaults in brackets; ENTER (empty) accepts; answers trim", () => {
    const { deps, dir, prompts } = makeDeps({ isTTY: true, answers: ["  9999  ", "", "", ""] });
    expect(runConfigure({}, deps)).toBe(0);
    expect(prompts).toHaveLength(4);
    expect(prompts[0]?.[1]).toBe("3080");
    // The host question must carry the literal choice text the brief mandates.
    expect(prompts[1]?.[0]).toContain("bind LAN? type 0.0.0.0");
    expect(prompts[1]?.[1]).toBe("127.0.0.1");
    // The base-url default follows the ANSWERED port, not the built-in one.
    expect(prompts[2]?.[1]).toBe("http://localhost:9999");
    expect(prompts[3]?.[1]).toBe(join(dir, "subshell.db"));
    const cfg = readCfg(dir);
    expect(cfg.SERVER_PORT).toBe("9999"); // trimmed answer
    expect(cfg.HOST).toBe("127.0.0.1"); // ENTER accepted the default
    expect(cfg.APP_BASE_URL).toBe("http://localhost:9999");
    expect(cfg.DATABASE_PATH).toBe(join(dir, "subshell.db"));
  });

  test("an invalid typed answer exits 1 with zero writes (no re-prompt loop)", () => {
    const { deps, dir, prompts } = makeDeps({ isTTY: true, answers: ["99999"] });
    expect(runConfigure({}, deps)).toBe(1);
    expect(prompts).toHaveLength(1); // died at validation, never asked on
    expect(() => readFileSync(envFile(dir))).toThrow();
  });

  test("EOF (Ctrl-D) mid-flow aborts with zero writes", () => {
    const { deps, dir, err, prompts } = makeDeps({ isTTY: true, answers: ["3500", null] });
    expect(runConfigure({}, deps)).toBe(1);
    expect(prompts).toHaveLength(2);
    expect(err.join("\n")).toMatch(/stdin closed/i);
    expect(() => readFileSync(envFile(dir))).toThrow();
  });
});

describe("runConfigure — file hygiene", () => {
  test("pre-existing file with 0644 is replaced at 0600 (tmp+rename, new inode)", () => {
    const { deps, dir } = makeDeps();
    writeFileSync(envFile(dir), "SERVER_PORT=1234\n", { mode: 0o644 });
    chmodSync(envFile(dir), 0o644);
    const before = statSync(envFile(dir));
    expect(runConfigure({ yes: true }, deps)).toBe(0);
    const after = statSync(envFile(dir));
    expect(after.mode & 0o777).toBe(0o600);
    expect(after.ino).not.toBe(before.ino); // written via temp file + rename, never in place
    expect(readCfg(dir).SERVER_PORT).toBe("3080");
  });

  test("config home is created 0700 when missing (mkdir -p)", () => {
    const { deps, dir } = makeDeps();
    const nested = join(dir, "deep", "home");
    expect(runConfigure({ yes: true }, { ...deps, configDir: nested })).toBe(0);
    expect(statSync(nested).mode & 0o777).toBe(0o700);
    expect(readCfg(nested).DATABASE_PATH).toBe(join(nested, "subshell.db"));
  });

  test("header documents the comment-preservation contract", () => {
    const { deps, dir } = makeDeps();
    expect(runConfigure({ yes: true }, deps)).toBe(0);
    const raw = readFileSync(envFile(dir), "utf8");
    expect(raw.split("\n")[0]).toMatch(/^#/);
    expect(raw).toMatch(/comment/i); // the drop-comment caveat is stated in the file itself
  });
});
