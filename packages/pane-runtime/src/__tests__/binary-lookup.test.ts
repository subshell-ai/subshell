import { afterEach, describe, expect, it } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectBinary, detectBinaryWithOptions, findBinaryWithOptions, withShellBackfill } from "../binary-lookup.js";
import { loginPathEntries, resetLoginPathForTests } from "../login-path.js";

/**
 * The lookup's rungs, and the one that was missing.
 *
 * A harness installed through a node version manager is found by neither PATH
 * nor a known location: a service's PATH is baked at install time from
 * whichever shell installed it, and nvm's bin directory carries a node
 * VERSION, so no static list can name it. Measured on 2026-09-09, the
 * installed unit's PATH held `~/.cargo/bin` and `~/.deno/bin` but no nvm
 * entry, while `claude` lived under `~/.nvm/versions/node/<v>/bin` — so the
 * console reported claude-code as not installed while running inside it.
 */
describe("findBinaryWithOptions", () => {
  afterEach(resetLoginPathForTests);

  /** A directory holding one executable of the given name. */
  function dirWith(name: string): string {
    const dir = mkdtempSync(join(tmpdir(), "harness-lookup-"));
    const file = join(dir, name);
    writeFileSync(file, "#!/bin/sh\nexit 0\n");
    chmodSync(file, 0o755);
    return dir;
  }

  it("finds a binary on the given PATH", async () => {
    const dir = dirWith("thing");
    expect(await findBinaryWithOptions("thing", "THING_PATH", [], { env: {}, pathEntries: [dir] })).toBe(
      join(dir, "thing"),
    );
  });

  it("prefers an explicit override, and refuses a bad one rather than searching on", async () => {
    const dir = dirWith("thing");
    const good = join(dir, "thing");
    expect(await findBinaryWithOptions("thing", "THING_PATH", [], { env: { THING_PATH: good }, pathEntries: [] })).toBe(
      good,
    );
    // An override that does not resolve is an answer, not a hint: the operator
    // said where it is, and searching past them would hide their mistake.
    expect(
      await findBinaryWithOptions("thing", "THING_PATH", [], {
        env: { THING_PATH: "/nope/thing" },
        pathEntries: [dir],
      }),
    ).toBeNull();
  });

  it("falls back to a known location under HOME", async () => {
    const home = mkdtempSync(join(tmpdir(), "harness-home-"));
    const bin = join(home, "bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "thing"), "#!/bin/sh\n");
    chmodSync(join(bin, "thing"), 0o755);
    expect(
      await findBinaryWithOptions("thing", "THING_PATH", ["bin/thing"], { env: { HOME: home }, pathEntries: [] }),
    ).toBe(join(bin, "thing"));
  });

  it("does NOT consult the login shell when the caller injected pathEntries", async () => {
    // Every other test in this repo injects `pathEntries` to describe the world
    // it wants searched. If the login rung ran anyway, this machine's real PATH
    // would leak in and results would depend on the developer's setup. `bun`
    // is on the login PATH wherever these tests run, so finding it here would
    // be the tell.
    expect(
      await findBinaryWithOptions("bun", "BUN_PATH_XYZ", [], {
        env: { HOME: join(tmpdir(), "definitely-absent") },
        pathEntries: [],
      }),
    ).toBeNull();
  });

  it("consults the login shell's PATH as the last rung", async () => {
    const login = await loginPathEntries();
    const dir = login.find((d) => d.length > 0);
    if (!dir) return; // A container with no usable login profile; nothing to assert.

    // Ask for something that exists ONLY on the login PATH by giving the
    // lookup an empty PATH and a HOME with no known location.
    const found = await findBinaryWithOptions("sh", "SH_PATH_XYZ", [], {
      env: { HOME: join(tmpdir(), "definitely-absent"), PATH: "" },
    });
    expect(found).not.toBeNull();
    expect(login.some((d) => found === join(d, "sh"))).toBe(true);
  });
});

/**
 * The same rungs, reporting WHY rather than answering `null` twice over.
 *
 * "Not found" collapsed two situations that want different answers on screen:
 * nothing is installed, and an explicit override points at nothing. The second
 * used to render an install command, which cannot help an operator whose
 * `THING_PATH` is simply wrong.
 */
describe("detectBinaryWithOptions", () => {
  afterEach(resetLoginPathForTests);

  /** A directory holding one executable of the given name. */
  function dirWith(name: string): string {
    const dir = mkdtempSync(join(tmpdir(), "harness-detect-"));
    const file = join(dir, name);
    writeFileSync(file, "#!/bin/sh\nexit 0\n");
    chmodSync(file, 0o755);
    return dir;
  }

  it("reports override-invalid when the override points at nothing", async () => {
    const result = await detectBinaryWithOptions("thing", "THING_PATH", [], {
      env: { THING_PATH: "/nope/thing" },
      pathEntries: [dirWith("thing")],
    });
    expect(result.path).toBeNull();
    expect(result.reason).toBe("override-invalid");
  });

  it("reports not-on-path when nothing is found and no override is set", async () => {
    const result = await detectBinaryWithOptions("thing", "THING_PATH", [], {
      env: { HOME: join(tmpdir(), "definitely-absent") },
      pathEntries: [],
    });
    expect(result.path).toBeNull();
    expect(result.reason).toBe("not-on-path");
  });

  it("returns the path and no reason when found on PATH", async () => {
    const dir = dirWith("thing");
    const result = await detectBinaryWithOptions("thing", "THING_PATH", [], { env: {}, pathEntries: [dir] });
    expect(result.path).toBe(join(dir, "thing"));
    expect(result.reason).toBeUndefined();
  });

  it("treats a bare-name override as no override at all", async () => {
    // `SHELL=bash` (no slash) is a real shape in containers and hand-written
    // service units. Stopping the ladder there answers `override-invalid` for
    // a machine that can launch the binary all day: the rung means "the
    // operator said WHERE", and a bare name says no where.
    const dir = dirWith("thing");
    const result = await detectBinaryWithOptions("thing", "THING_PATH", [], {
      env: { THING_PATH: "thing" },
      pathEntries: [dir],
    });
    expect(result.path).toBe(join(dir, "thing"));
    expect(result.reason).toBeUndefined();
  });

  it("refuses a relative override by name rather than resolving it against the cwd", async () => {
    // A relative hit would become a relative argv token that tmux execs against
    // the PANE's working directory — a different file, or a failure at launch.
    // Silently falling through hides the operator's bad pin, so a PATH-like
    // (slash-containing) value names the reason instead.
    const result = await detectBinaryWithOptions("thing", "THING_PATH", [], {
      env: { THING_PATH: "./thing", HOME: join(tmpdir(), "definitely-absent") },
      pathEntries: [dirWith("thing")],
    });
    expect(result.path).toBeNull();
    expect(result.reason).toBe("override-invalid");
  });

  it("expands a ~ override against HOME before the executability check", async () => {
    // A systemd Environment= line never expands tildes, so `~/.local/bin/claude`
    // reaches the ladder verbatim. Ignoring it would silently resolve a
    // different PATH build forever; expanding it makes the pin honest.
    const home = mkdtempSync(join(tmpdir(), "harness-tilde-"));
    const bin = join(home, ".local", "bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "thing"), "#!/bin/sh\n");
    chmodSync(join(bin, "thing"), 0o755);
    const result = await detectBinaryWithOptions("thing", "THING_PATH", [], {
      env: { THING_PATH: "~/.local/bin/thing", HOME: home },
      pathEntries: [],
    });
    expect(result.path).toBe(join(bin, "thing"));
  });

  it("returns the path and no reason for a good override", async () => {
    const good = join(dirWith("thing"), "thing");
    const result = await detectBinaryWithOptions("thing", "THING_PATH", [], {
      env: { THING_PATH: good },
      pathEntries: [],
    });
    expect(result.path).toBe(good);
    expect(result.reason).toBeUndefined();
  });

  it("returns the path and no reason for a known location under HOME", async () => {
    const home = mkdtempSync(join(tmpdir(), "harness-detect-home-"));
    const bin = join(home, "bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "thing"), "#!/bin/sh\n");
    chmodSync(join(bin, "thing"), 0o755);
    const result = await detectBinaryWithOptions("thing", "THING_PATH", ["bin/thing"], {
      env: { HOME: home },
      pathEntries: [],
    });
    expect(result.path).toBe(join(bin, "thing"));
    expect(result.reason).toBeUndefined();
  });
});

/**
 * The rung that was added and then never ran.
 *
 * `detectBinary` used to build `pathEntries` from `process.env.PATH` before
 * delegating. That key means "the caller is describing the world it wants
 * searched" and suppresses the login-shell rung, and an array is truthy, so
 * every production caller skipped rung 4 while the rung's own test, which
 * omits the key, kept passing. The service-PATH bug rung 4 exists to fix was
 * therefore still live after the fix landed. These pin the entry point rather
 * than the helper, because the helper was never the broken half.
 */
describe("detectBinary reaches the login-shell rung", () => {
  afterEach(() => {
    resetLoginPathForTests();
    if (savedPath === undefined) delete process.env.PATH;
    else process.env.PATH = savedPath;
  });

  let savedPath: string | undefined;

  it("finds a binary that only the login PATH can reach", async () => {
    savedPath = process.env.PATH;
    // With no PATH at all, rungs 2 and 3 cannot answer, so only the login
    // shell can. `sh` is on every POSIX login PATH, which makes this
    // deterministic rather than dependent on what this machine has installed.
    process.env.PATH = "";
    const result = await detectBinary("sh", "SH_PATH_XYZ", []);
    const login = await loginPathEntries();
    if (login.length === 0) return; // A container with no usable login profile.
    expect(result.path).not.toBeNull();
    expect(login.some((d) => result.path === join(d, "sh"))).toBe(true);
  });

  it("still lets an injected pathEntries suppress the login rung", async () => {
    savedPath = process.env.PATH;
    process.env.PATH = "";
    const result = await detectBinaryWithOptions("sh", "SH_PATH_XYZ", [], {
      env: { HOME: join(tmpdir(), "definitely-absent") },
      pathEntries: [],
    });
    expect(result.path).toBeNull();
    expect(result.reason).toBe("not-on-path");
  });
});

describe("loginPathEntries", () => {
  afterEach(resetLoginPathForTests);

  it("returns absolute entries, or nothing at all", async () => {
    const entries = await loginPathEntries();
    // Never throws and never returns junk: an unusable shell is an empty list,
    // because the caller has already tried PATH and the known locations.
    expect(Array.isArray(entries)).toBe(true);
    for (const entry of entries) expect(entry.length).toBeGreaterThan(0);
  });

  it("probes at most once per process", async () => {
    const first = await loginPathEntries();
    const second = await loginPathEntries();
    expect(second).toBe(first); // the same array identity, not a re-probe
  });
});

describe("a plugin whose override is SHELL", () => {
  it("resolves the login shell at rung 1", async () => {
    // What makes the terminal plugin work with nothing installed: the
    // override rung answers before any PATH scan happens.
    const found = await detectBinaryWithOptions("bash", "SHELL", [], {
      env: { SHELL: "/bin/sh" },
      pathEntries: [],
    });

    expect(found).toEqual({ path: "/bin/sh" });
  });

  it("falls through to bash on PATH when SHELL is unset", async () => {
    const found = await detectBinaryWithOptions("bash", "SHELL", [], {
      env: {},
      pathEntries: ["/bin", "/usr/bin"],
    });

    expect(found.path).toMatch(/bash$/);
  });

  it("falls through to bash on PATH when SHELL is a bare name", async () => {
    // `SHELL=bash` with no slash: a bare override is no pointer, so the PATH
    // rung answers — the terminal stays launchable on exactly the machines
    // whose env is too minimal to hold a full path.
    const found = await detectBinaryWithOptions("bash", "SHELL", [], {
      env: { SHELL: "bash" },
      pathEntries: ["/bin", "/usr/bin"],
    });

    expect(found.path).toMatch(/bash$/);
  });

  it("reports override-invalid rather than searching past a broken SHELL", async () => {
    // An override that does not resolve is an answer, not a hint. The UI
    // names the variable (see Task 4), so this reason has to survive.
    const found = await detectBinaryWithOptions("bash", "SHELL", [], {
      env: { SHELL: "/nonexistent/shell" },
      pathEntries: ["/bin", "/usr/bin"],
    });

    expect(found).toEqual({ path: null, reason: "override-invalid" });
  });
});

describe("the account login shell backfill (service-managed hosts)", () => {
  it("backfills a SHELL the daemon env never had, without mutating the env", () => {
    // systemd and launchd start units without SHELL (this repo's own units
    // carry only PATH), so this is the terminal plugin's ONLY path to the
    // user's real login shell on every production host.
    const env = { PATH: "/usr/bin" };
    const merged = withShellBackfill(env, "/usr/bin/zsh");
    expect(merged.SHELL).toBe("/usr/bin/zsh");
    expect("SHELL" in env).toBe(false); // process.env must not gain a key
  });

  it("an explicit SHELL wins and the env comes back untouched", () => {
    const env = { SHELL: "/bin/bash" };
    expect(withShellBackfill(env, "/usr/bin/zsh")).toBe(env);
  });

  it("no env value and no account shell leaves the ladder to PATH", () => {
    const env = { PATH: "/usr/bin" };
    expect(withShellBackfill(env, undefined)).toBe(env);
  });

  it("the backfilled value is what rung 1 then answers", async () => {
    const env = withShellBackfill({}, "/bin/sh");
    const found = await detectBinaryWithOptions("bash", "SHELL", [], { env, pathEntries: [] });
    expect(found).toEqual({ path: "/bin/sh" });
  });
});
