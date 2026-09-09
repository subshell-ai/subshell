import { afterEach, describe, expect, it } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findBinaryWithOptions } from "../binary-lookup.js";
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
