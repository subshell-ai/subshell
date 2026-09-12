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
    expect(cfg.HOST).toBe("0.0.0.0");
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
    expect(cfg.HOST).toBe("0.0.0.0");
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

  /**
   * The interaction between the preserve-the-file default and the base URL.
   * `--yes --port 4000` on a config storing `http://box.local:3080` keeps that
   * base URL — correctly, it is not ours to rewrite — but the port it names is
   * now dead, so the derived allowlist covers `:4000` loopback and
   * `box.local:3080`, and browsing `box.local:4000` gets the exact 403
   * "Invalid origin" this key exists to prevent. Interactive runs show the
   * stored URL as an editable default and the desktop form shows both fields;
   * a scripted run is the one path where nothing says it.
   */
  test("a base URL naming a different port than the server listens on → warned", () => {
    const { deps, dir, out } = makeDeps();
    writeFileSync(envFile(dir), "APP_BASE_URL=http://box.local:3080\n", { mode: 0o600 });
    expect(runConfigure({ yes: true, port: "4000" }, deps)).toBe(0);
    const text = out.join("\n");
    expect(text).toMatch(/warning/i);
    expect(text).toContain("http://box.local:3080");
    expect(text).toContain("4000");
    // Warned, then accepted — same contract as the loopback warning.
    expect(readCfg(dir).APP_BASE_URL).toBe("http://box.local:3080");
    expect(readCfg(dir).SERVER_PORT).toBe("4000");
  });

  test("a base URL on the server's own port → no warning", () => {
    const { deps, out } = makeDeps();
    expect(runConfigure({ yes: true, port: "4000", baseUrl: "http://box.local:4000" }, deps)).toBe(0);
    expect(out.join("\n")).not.toMatch(/warning/i);
  });

  /**
   * A proxied deployment is the legitimate reason the two differ: the browser
   * dials :443 and the server listens on 3080. Warning there would fire on
   * every correct production config, which is how a warning becomes noise.
   */
  test("a default-port https base URL is a proxy, not a mismatch → no warning", () => {
    const { deps, out } = makeDeps();
    expect(runConfigure({ yes: true, port: "3080", baseUrl: "https://subshell.example" }, deps)).toBe(0);
    expect(out.join("\n")).not.toMatch(/warning/i);
  });

  test("an explicit http default port is a proxy too → no warning", () => {
    const { deps, out } = makeDeps();
    expect(runConfigure({ yes: true, port: "3080", baseUrl: "http://subshell.example:80" }, deps)).toBe(0);
    expect(out.join("\n")).not.toMatch(/warning/i);
  });

  test("LAN bind + reachable base URL → no warning", () => {
    const { deps, out } = makeDeps();
    expect(runConfigure({ yes: true, host: "0.0.0.0", baseUrl: "http://10.0.0.5:3080" }, deps)).toBe(0);
    expect(out.join("\n")).not.toMatch(/warning/i);
  });

  // An explicit loopback opt-out is the single-machine setup now; a DEFAULT
  // run binds 0.0.0.0 and therefore warns about its loopback base URL (the
  // test above pins that).
  test("loopback bind + loopback base URL → no warning (single-machine setup)", () => {
    const { deps, out } = makeDeps();
    expect(runConfigure({ yes: true, host: "127.0.0.1" }, deps)).toBe(0);
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

describe("runConfigure — tmux offer-to-install (spec 2026-09-03)", () => {
  /**
   * A host with apt-get but no tmux; `installed` flips what `which` answers
   * after the (stubbed) installer runs, so the runner's re-probe is exercised.
   */
  function aptHost() {
    let installed = false;
    return {
      installed: () => installed,
      markInstalled: () => {
        installed = true;
      },
      which: (n: string) => (n === "apt-get" ? "/usr/bin/apt-get" : n === "tmux" && installed ? "/usr/bin/tmux" : null),
    };
  }

  test("interactive + yes + install success → CONTINUES: zero refusals, config written", () => {
    const host = aptHost();
    let spawnArgv: readonly string[] | undefined;
    const { deps, dir, out, err, prompts } = makeDeps({
      isTTY: true,
      which: host.which,
      platform: "linux",
      spawnInstall: (argv) => {
        spawnArgv = argv;
        host.markInstalled();
        return 0;
      },
      answers: ["y", "", "", "", "", ""],
    });
    expect(runConfigure({}, deps)).toBe(0);
    expect(spawnArgv).toEqual(["sudo", "apt-get", "install", "-y", "tmux"]);
    expect(prompts[0]?.[0]).toMatch(/Install tmux now with apt-get\?/i);
    expect(prompts).toHaveLength(6); // offer, then the five config questions
    expect(err).toEqual([]); // the stderr REFUSAL never fires (the offer's own stdout preamble is not a refusal)
    expect(out.join("\n")).toMatch(/tmux installed/i);
    expect(readCfg(dir).SERVER_PORT).toBe("3080");
  });

  test("declined offer → the status-quo refusal, still BEFORE any write", () => {
    const host = aptHost();
    const { deps, dir, err, prompts } = makeDeps({
      isTTY: true,
      which: host.which,
      platform: "linux",
      spawnInstall: () => 0,
      answers: ["n"],
    });
    expect(runConfigure({}, deps)).toBe(1);
    expect(prompts).toHaveLength(1);
    expect(err.join("\n")).toMatch(/tmux not found/i);
    expect(err.join("\n")).toContain("SUBSHELL_SERVER_SKIP_TMUX_CHECK=1");
    expect(() => readFileSync(envFile(dir))).toThrow();
  });

  test("yes but the installer FAILS → hint refusal with nothing written", () => {
    const host = aptHost();
    const { deps, dir, err } = makeDeps({
      isTTY: true,
      which: host.which,
      platform: "linux",
      spawnInstall: () => 1,
      answers: ["y"],
    });
    expect(runConfigure({}, deps)).toBe(1);
    expect(err.join("\n")).toMatch(/tmux not found/i);
    expect(() => readFileSync(envFile(dir))).toThrow();
  });

  test("install exits 0 but tmux is STILL unfindable → refuse (never continue broken)", () => {
    const host = aptHost(); // installed flag deliberately never flipped
    const { deps, dir, err } = makeDeps({
      isTTY: true,
      which: host.which,
      platform: "linux",
      spawnInstall: () => 0,
      answers: ["y"],
    });
    expect(runConfigure({}, deps)).toBe(1);
    expect(err.join("\n")).toMatch(/tmux not found/i);
    expect(() => readFileSync(envFile(dir))).toThrow();
  });

  test("--yes NEVER offers: prompt and installer seams untouched (CI determinism)", () => {
    const host = aptHost();
    let spawned = 0;
    const { deps, prompts } = makeDeps({
      isTTY: true,
      which: host.which,
      platform: "linux",
      spawnInstall: () => {
        spawned++;
        return 0;
      },
    });
    expect(runConfigure({ yes: true }, deps)).toBe(1);
    expect(prompts).toEqual([]);
    expect(spawned).toBe(0);
  });

  test("no TTY → no offer even without --yes", () => {
    const host = aptHost();
    const { deps, prompts } = makeDeps({ isTTY: false, which: host.which, platform: "linux" });
    expect(runConfigure({}, deps)).toBe(1);
    expect(prompts).toEqual([]);
  });

  test("interactive but NO supported installer on PATH → silent fall to the hint", () => {
    const { deps, err, prompts } = makeDeps({
      isTTY: true,
      which: () => null,
      platform: "linux",
      answers: [], // an offer would demand an answer — prompts staying empty proves none
    });
    expect(runConfigure({}, deps)).toBe(1);
    expect(prompts).toEqual([]);
    expect(err.join("\n")).toMatch(/tmux not found/i);
  });

  test("EOF at the offer prompt (Ctrl-D) counts as declined", () => {
    const host = aptHost();
    const { deps, dir } = makeDeps({
      isTTY: true,
      which: host.which,
      platform: "linux",
      spawnInstall: () => 0,
      answers: [null],
    });
    expect(runConfigure({}, deps)).toBe(1);
    expect(() => readFileSync(envFile(dir))).toThrow();
  });
});

describe("runConfigure — interactive flow", () => {
  test("five questions with defaults in brackets; ENTER (empty) accepts; answers trim", () => {
    const { deps, dir, prompts } = makeDeps({ isTTY: true, answers: ["  9999  ", "", "", "", ""] });
    expect(runConfigure({}, deps)).toBe(0);
    expect(prompts).toHaveLength(5);
    expect(prompts[0]?.[1]).toBe("3080");
    // The host question names both spellings of the choice; the DEFAULT is now
    // the LAN bind (remote nodes and devices cannot reach a loopback socket).
    expect(prompts[1]?.[0]).toContain("0.0.0.0 serves the LAN");
    expect(prompts[1]?.[1]).toBe("0.0.0.0");
    // The base-url default follows the ANSWERED port, not the built-in one.
    expect(prompts[2]?.[1]).toBe("http://localhost:9999");
    // No stored list, so the extra-origins question defaults to empty.
    expect(prompts[3]?.[1]).toBe("");
    expect(prompts[4]?.[1]).toBe(join(dir, "subshell.db"));
    const cfg = readCfg(dir);
    expect(cfg.SERVER_PORT).toBe("9999"); // trimmed answer
    expect(cfg.HOST).toBe("0.0.0.0"); // ENTER accepted the default
    expect(cfg.APP_BASE_URL).toBe("http://localhost:9999");
    expect(cfg.DATABASE_PATH).toBe(join(dir, "subshell.db"));
  });

  /**
   * Each answer is validated AT ITS PROMPT, which is why this dies after one
   * question rather than collecting four more the person would have to retype.
   * `applyConfig` validates the whole set again — it has to, since `PATCH
   * /api/admin/server/config` has no prompts to validate at — but both passes
   * call the same `validateValue`, so there is one set of rules and two places
   * it runs.
   */
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

describe("runConfigure — interactive re-run defaults come from the file", () => {
  test("ENTER through a stored config keeps it: the port default is the CURRENT value, not the built-in", () => {
    const { deps, dir, prompts } = makeDeps({ isTTY: true, answers: ["", "", "", "", ""] });
    writeFileSync(envFile(dir), "SERVER_PORT=9999\n", { mode: 0o600 });
    expect(runConfigure({}, deps)).toBe(0);
    expect(prompts[0]?.[1]).toBe("9999");
    // No stored base URL → the built-in default, following the ANSWERED (here:
    // stored) port — the dflt layer only replaces the base, not the derivation.
    expect(prompts[2]?.[1]).toBe("http://localhost:9999");
    expect(readCfg(dir).SERVER_PORT).toBe("9999");
  });

  test("every stored key becomes its prompt default; foreign keys carry through", () => {
    const { deps, dir, prompts } = makeDeps({ isTTY: true, answers: ["", "", "", "", ""] });
    writeFileSync(
      envFile(dir),
      "SERVER_PORT=9999\n" +
        "HOST=0.0.0.0\n" +
        "APP_BASE_URL=https://public.example\n" +
        "TRUSTED_ORIGINS=http://box.local:3080\n" +
        "DATABASE_PATH=/srv/db/subshell.db\n" +
        "BETTER_AUTH_SECRET=abc\n",
      { mode: 0o600 },
    );
    expect(runConfigure({}, deps)).toBe(0);
    expect(prompts.map((p) => p[1])).toEqual([
      "9999",
      "0.0.0.0",
      "https://public.example",
      "http://box.local:3080",
      "/srv/db/subshell.db",
    ]);
    expect(readCfg(dir)).toMatchObject({
      SERVER_PORT: "9999",
      HOST: "0.0.0.0",
      APP_BASE_URL: "https://public.example",
      TRUSTED_ORIGINS: "http://box.local:3080",
      DATABASE_PATH: "/srv/db/subshell.db",
      BETTER_AUTH_SECRET: "abc",
    });
  });

  test("flags still outrank stored values in an interactive run", () => {
    const { deps, dir } = makeDeps({ isTTY: true, answers: ["", "", "", ""] });
    writeFileSync(envFile(dir), "SERVER_PORT=9999\n", { mode: 0o600 });
    expect(runConfigure({ port: "4100" }, deps)).toBe(0);
    expect(readCfg(dir).SERVER_PORT).toBe("4100");
    expect(readCfg(dir).APP_BASE_URL).toBe("http://localhost:4100");
  });

  // `--yes` follows the file too. `init --yes` is idempotent by contract, and
  // a non-interactive run that reset APP_BASE_URL/DATABASE_PATH to the
  // built-ins broke that: the desktop console's "save" is a non-interactive
  // run, so changing the port there silently repointed the database and threw
  // away a customised base URL. Flags still outrank the file.
  test("--yes follows stored values, so a scripted re-run is not a reset", () => {
    const { deps, dir } = makeDeps();
    writeFileSync(envFile(dir), "SERVER_PORT=9999\nHOST=127.0.0.1\n", { mode: 0o600 });
    expect(runConfigure({ yes: true }, deps)).toBe(0);
    expect(readCfg(dir)).toMatchObject({ SERVER_PORT: "9999", HOST: "127.0.0.1" });
  });

  test("unreadable existing file is refused BEFORE any question is spent", () => {
    const { deps, dir, prompts, err } = makeDeps({ isTTY: true });
    mkdirSync(envFile(dir)); // EISDIR on read
    expect(runConfigure({}, deps)).toBe(1);
    expect(prompts).toEqual([]);
    expect(err.join("\n")).toContain("config.env");
    expect(() => readFileSync(envFile(dir))).toThrow(); // still the directory — no clobber
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
    expect(readCfg(dir).SERVER_PORT).toBe("1234"); // and the stored value survived the rewrite
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

describe("runConfigure — TRUSTED_ORIGINS (the extra addresses browsers may dial)", () => {
  test("a multi-entry list is written verbatim", () => {
    const { deps, dir } = makeDeps();
    expect(runConfigure({ yes: true, trustedOrigins: "http://box.local:3080,http://10.0.0.5:3080" }, deps)).toBe(0);
    expect(readCfg(dir).TRUSTED_ORIGINS).toBe("http://box.local:3080,http://10.0.0.5:3080");
  });

  test("entries are trimmed, so a list typed with spaces round-trips", () => {
    const { deps, dir } = makeDeps();
    expect(runConfigure({ yes: true, trustedOrigins: "http://a.local:3080 , http://b.local:3080" }, deps)).toBe(0);
    expect(readCfg(dir).TRUSTED_ORIGINS).toBe("http://a.local:3080,http://b.local:3080");
  });

  test("no flag preserves the stored list — a port change never drops the origins", () => {
    const { deps, dir } = makeDeps();
    writeFileSync(envFile(dir), "TRUSTED_ORIGINS=http://box.local:3080\n", { mode: 0o600 });
    expect(runConfigure({ yes: true, port: "4000" }, deps)).toBe(0);
    expect(readCfg(dir).TRUSTED_ORIGINS).toBe("http://box.local:3080");
    expect(readCfg(dir).SERVER_PORT).toBe("4000");
  });

  test("an empty flag REMOVES the key, rather than writing an empty line", () => {
    const { deps, dir } = makeDeps();
    writeFileSync(envFile(dir), "TRUSTED_ORIGINS=http://box.local:3080\n", { mode: 0o600 });
    expect(runConfigure({ yes: true, trustedOrigins: "" }, deps)).toBe(0);
    expect(readCfg(dir).TRUSTED_ORIGINS).toBeUndefined();
    expect(readFileSync(envFile(dir), "utf8")).not.toContain("TRUSTED_ORIGINS=");
  });

  test("a fresh install writes no TRUSTED_ORIGINS line at all", () => {
    const { deps, dir } = makeDeps();
    expect(runConfigure({ yes: true }, deps)).toBe(0);
    expect(readFileSync(envFile(dir), "utf8")).not.toContain("TRUSTED_ORIGINS=");
  });

  for (const bad of [
    "box.local:3080", // no scheme — the commonest way to write an origin wrong
    "ftp://box.local:3080", // not a browser origin
    "http://box.local:3080/app", // an origin has no path
    "http://box.local:3080,", // a trailing comma leaves an empty entry
    "http://a.local:3080,nope", // one good entry does not excuse the other
  ]) {
    test(`invalid trusted origin '${bad}' → exit 1, zero writes`, () => {
      const { deps, dir, err } = makeDeps();
      expect(runConfigure({ yes: true, trustedOrigins: bad }, deps)).toBe(1);
      expect(err.join("\n")).toMatch(/trusted origin/i);
      expect(() => readFileSync(envFile(dir))).toThrow();
    });
  }

  /**
   * A trailing slash is what a browser's address bar produces, and
   * `URL.origin` discards it — so refusing it is refusing the commonest
   * correct spelling. It matters more than taste: until this flow owned the
   * key, `TRUSTED_ORIGINS` was carried forward verbatim and hand-written
   * values are the expected input, and since defaults now follow the FILE a
   * rejected stored value blocks every `configure`/`init` run — including the
   * non-interactive `init --yes` the desktop console's save button IS.
   */
  test("one trailing slash is accepted and normalized away", () => {
    const { deps, dir } = makeDeps();
    expect(runConfigure({ yes: true, trustedOrigins: "http://box.local:3080/" }, deps)).toBe(0);
    expect(readCfg(dir).TRUSTED_ORIGINS).toBe("http://box.local:3080");
  });

  test("a stored trailing-slash value does not block a run that never mentions it", () => {
    const { deps, dir, err } = makeDeps();
    writeFileSync(envFile(dir), "TRUSTED_ORIGINS=http://box.local:3080/\n", { mode: 0o600 });
    expect(runConfigure({ yes: true, port: "4000" }, deps)).toBe(0);
    expect(err).toEqual([]);
    expect(readCfg(dir).TRUSTED_ORIGINS).toBe("http://box.local:3080");
    expect(readCfg(dir).SERVER_PORT).toBe("4000");
  });

  test("a real path is still refused — only the bare trailing slash is forgiven", () => {
    const { deps, err } = makeDeps();
    expect(runConfigure({ yes: true, trustedOrigins: "http://box.local:3080/app/" }, deps)).toBe(1);
    expect(err.join("\n")).toMatch(/trusted origin/i);
  });

  test("the refusal names the offending entry, not just the list", () => {
    const { deps, err } = makeDeps();
    expect(runConfigure({ yes: true, trustedOrigins: "http://a.local:3080,nope" }, deps)).toBe(1);
    expect(err.join("\n")).toContain("nope");
  });

  /**
   * The prompt has to describe what ENTER actually does. `ask()` maps a blank
   * answer to the DEFAULT, and since defaults now follow the file, the default
   * on a re-run is the stored list — so a question reading "blank for none"
   * told the operator that pressing ENTER would clear it, when pressing ENTER
   * rewrites it verbatim. Clearing is `--trusted-origins ""`, and the question
   * says so rather than implying an interactive route that does not exist.
   */
  test("with a stored list, the question says ENTER keeps it and names the way to clear", () => {
    const { deps, dir, prompts } = makeDeps({ isTTY: true, answers: ["", "", "", "", ""] });
    writeFileSync(envFile(dir), "TRUSTED_ORIGINS=http://old-laptop.local:3080\n", { mode: 0o600 });
    expect(runConfigure({}, deps)).toBe(0);
    const question = prompts[3]?.[0] ?? "";
    expect(question).not.toMatch(/blank for none/i);
    expect(question).toMatch(/keeps/i);
    expect(question).toContain("--trusted-origins");
  });

  test("with no stored list, blank really does mean none, and the question still says so", () => {
    const { deps, prompts } = makeDeps({ isTTY: true, answers: ["", "", "", "", ""] });
    expect(runConfigure({}, deps)).toBe(0);
    expect(prompts[3]?.[0] ?? "").toMatch(/blank for none/i);
  });

  test("interactive: asked after the base URL, defaulting to the stored list", () => {
    const { deps, dir, prompts } = makeDeps({ isTTY: true, answers: ["", "", "", "", ""] });
    writeFileSync(envFile(dir), "TRUSTED_ORIGINS=http://box.local:3080\n", { mode: 0o600 });
    expect(runConfigure({}, deps)).toBe(0);
    expect(prompts).toHaveLength(5);
    expect(prompts[3]?.[0]).toMatch(/origins/i);
    expect(prompts[3]?.[1]).toBe("http://box.local:3080");
    expect(readCfg(dir).TRUSTED_ORIGINS).toBe("http://box.local:3080");
  });
});

describe("runConfigure — a value already on disk never blocks a run", () => {
  /**
   * The wedge this closes, and it was reachable from the documented escape
   * hatch. `docs/security.md` says an env var or a hand-edit bypasses the
   * validator — so a wildcard CAN be in config.env, and better-auth honours
   * it. But the console seeds the stored value and sends every field on save,
   * so changing the PORT re-sent `--trusted-origins 'https://*'`, the
   * validator refused it, and the console could never save again. Nothing on
   * the page said why: `status` is deliberately silent about wildcards.
   *
   * The rule: a resolved value byte-identical to what is already stored is
   * passed through with a warning. Preserving what the boot already reads
   * grants nothing new; only a CHANGED value has to satisfy the validator.
   */
  test("a stored wildcard is preserved, so changing another key still works", () => {
    const { deps, dir, out, err } = makeDeps();
    writeFileSync(envFile(dir), "TRUSTED_ORIGINS=https://*.example.com\n", { mode: 0o600 });
    expect(runConfigure({ yes: true, port: "4000", trustedOrigins: "https://*.example.com" }, deps)).toBe(0);
    expect(err).toEqual([]);
    expect(readCfg(dir).SERVER_PORT).toBe("4000");
    expect(readCfg(dir).TRUSTED_ORIGINS).toBe("https://*.example.com");
    // Warned, not silent: this tool would not WRITE that value.
    const text = out.join("\n");
    expect(text).toMatch(/warning/i);
    expect(text).toContain("TRUSTED_ORIGINS");
    expect(text).toContain(envFile(dir));
  });

  test("a stored unusable APP_BASE_URL likewise does not block a port change", () => {
    const { deps, dir, err } = makeDeps();
    writeFileSync(envFile(dir), "APP_BASE_URL=box.local:3080\n", { mode: 0o600 });
    expect(runConfigure({ yes: true, port: "4000" }, deps)).toBe(0);
    expect(err).toEqual([]);
    expect(readCfg(dir).APP_BASE_URL).toBe("box.local:3080");
    expect(readCfg(dir).SERVER_PORT).toBe("4000");
  });

  /** A CHANGED value still has to be valid — the pass-through is not an escape. */
  test("a newly typed wildcard is still refused", () => {
    const { deps, dir, err } = makeDeps();
    writeFileSync(envFile(dir), "TRUSTED_ORIGINS=http://ok.local:3080\n", { mode: 0o600 });
    expect(runConfigure({ yes: true, trustedOrigins: "https://*" }, deps)).toBe(1);
    expect(err.join("\n")).toMatch(/wildcard/i);
    expect(readCfg(dir).TRUSTED_ORIGINS).toBe("http://ok.local:3080"); // untouched
  });

  test("a changed-but-still-bad value is refused, naming the flag that set it", () => {
    const { deps, dir } = makeDeps();
    writeFileSync(envFile(dir), "APP_BASE_URL=box.local:3080\n", { mode: 0o600 });
    expect(runConfigure({ yes: true, baseUrl: "also-bad" }, deps)).toBe(1);
    expect(readCfg(dir).APP_BASE_URL).toBe("box.local:3080");
  });
});

describe("runConfigure — a preserved bad value is attributed to its source", () => {
  /**
   * The cost of defaults following the file: a value nobody typed in THIS run
   * can fail validation. It is PRESERVED rather than refused (see the
   * describe above — refusing wedged the console), but silence would be wrong
   * too: the operator has to learn that the tool would not write it, where it
   * came from, and how to replace it.
   */
  test("the warning names config.env and the flag that overrides it", () => {
    const { deps, dir, out, err } = makeDeps();
    writeFileSync(envFile(dir), "APP_BASE_URL=box.local:3080\n", { mode: 0o600 });
    expect(runConfigure({ yes: true }, deps)).toBe(0);
    expect(err).toEqual([]);
    const text = out.join("\n");
    expect(text).toContain(envFile(dir)); // where it came from
    expect(text).toContain("--base-url"); // how to replace it
  });

  test("a CHANGED bad value is a hard refusal, not a warning", () => {
    const { deps, dir, err, out } = makeDeps();
    writeFileSync(envFile(dir), "APP_BASE_URL=https://fine.example\n", { mode: 0o600 });
    expect(runConfigure({ yes: true, baseUrl: "box.local:3080" }, deps)).toBe(1);
    expect(err.join("\n")).toMatch(/base[- ]url/i);
    expect(out.join("\n")).not.toMatch(/warning: APP_BASE_URL kept/);
  });

  test("the override the message names actually works", () => {
    const { deps, dir, out } = makeDeps();
    writeFileSync(envFile(dir), "APP_BASE_URL=box.local:3080\n", { mode: 0o600 });
    expect(runConfigure({ yes: true, baseUrl: "http://box.local:3080" }, deps)).toBe(0);
    expect(readCfg(dir).APP_BASE_URL).toBe("http://box.local:3080");
    expect(out.join("\n")).not.toMatch(/warning: APP_BASE_URL kept/); // replaced, so nothing to warn about
  });
});

describe("runConfigure — --yes preserves a stored config (idempotent by contract)", () => {
  test("--yes with one flag keeps every OTHER stored value", () => {
    const { deps, dir } = makeDeps();
    writeFileSync(
      envFile(dir),
      "SERVER_PORT=9999\n" +
        "HOST=127.0.0.1\n" +
        "APP_BASE_URL=https://public.example\n" +
        "DATABASE_PATH=/srv/db/subshell.db\n",
      { mode: 0o600 },
    );
    expect(runConfigure({ yes: true, port: "4000" }, deps)).toBe(0);
    expect(readCfg(dir)).toMatchObject({
      SERVER_PORT: "4000", // the flag
      HOST: "127.0.0.1", // stored, not the 0.0.0.0 built-in
      APP_BASE_URL: "https://public.example", // stored, not derived from the new port
      DATABASE_PATH: "/srv/db/subshell.db", // stored, not the configDir default
    });
  });

  test("--yes on a fresh config still lands the built-in defaults", () => {
    const { deps, dir } = makeDeps();
    expect(runConfigure({ yes: true }, deps)).toBe(0);
    expect(readCfg(dir)).toMatchObject({
      SERVER_PORT: "3080",
      HOST: "0.0.0.0",
      APP_BASE_URL: "http://localhost:3080",
      DATABASE_PATH: join(dir, "subshell.db"),
    });
  });
});
