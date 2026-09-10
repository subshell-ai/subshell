import { describe, expect, it } from "bun:test";
import { mkdirSync } from "node:fs";
import { utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPluginHost } from "../plugin-host.js";
import { createInProcessRuntime, resetImportedForTests } from "../plugin-runtime.js";

const FIXTURES = join(import.meta.dir, "fixtures", "plugins");
const runtime = () => createInProcessRuntime();

describe("PluginRuntime", () => {
  it("loads a good plugin and hands it a working host", async () => {
    const result = await runtime().load(join(FIXTURES, "good"));
    expect("error" in result).toBe(false);
    if ("error" in result) return;
    expect(result.manifest.id).toBe("good");
    // The argv proves the plugin called back into the host it was handed.
    expect(result.plugin.buildCommand({ binary: "/bin/x" } as never)).toEqual(["/bin/x", "'a b'"]);
  });

  it("reports a plugin that throws at import as broken, without throwing", async () => {
    const result = await runtime().load(join(FIXTURES, "throws"));
    expect("error" in result).toBe(true);
    if (!("error" in result)) return;
    expect(result.error).toContain("plugin exploded at import");
    // The manifest parsed before the module ran, so a broken plugin can still
    // be NAMED on screen rather than showing as an anonymous failure.
    expect(result.manifest?.id).toBe("throws");
  });

  it("reports a module with no default export as broken", async () => {
    const result = await runtime().load(join(FIXTURES, "no-default"));
    expect("error" in result).toBe(true);
    if (!("error" in result)) return;
    expect(result.error).toContain("default");
  });

  it("a plugin cannot import our packages", async () => {
    // Pinned deliberately: the whole host-object design exists BECAUSE this
    // fails. If it ever starts working, the contract has quietly changed.
    expect("error" in (await runtime().load(join(FIXTURES, "bare-import")))).toBe(true);
  });

  it("one broken plugin does not affect its neighbour", async () => {
    const r = runtime();
    await r.load(join(FIXTURES, "throws"));
    expect("error" in (await r.load(join(FIXTURES, "good")))).toBe(false);
  });

  it("reports a directory with no manifest as broken rather than crashing", async () => {
    const result = await runtime().load(join(FIXTURES, "does-not-exist"));
    expect("error" in result).toBe(true);
    if (!("error" in result)) return;
    expect(result.manifest).toBeNull();
  });

  it("refuses a plugin whose declared capabilities it does not implement", async () => {
    // Documented in plugin-api's README and in AGENTS.md, so it has to be
    // true: an earlier revision documented it in three places while the check
    // was never wired up.
    const result = await runtime().load(join(FIXTURES, "bad-capabilities"));
    expect("error" in result).toBe(true);
    if (!("error" in result)) return;
    expect(result.error).toContain("resume");
  });

  it("refuses a plugin missing a REQUIRED member, not just the two it used to check", async () => {
    // `validateProfile` is required and the adapter calls it unconditionally,
    // so this used to load as healthy and throw later from inside a closure
    // outside any fault boundary.
    const result = await runtime().load(join(FIXTURES, "missing-validate"));
    expect("error" in result).toBe(true);
    if (!("error" in result)) return;
    expect(result.error).toContain("validateProfile");
  });

  it("refuses an entry that resolves outside the package directory", async () => {
    // The manifest check catches the literal `..`; this re-checks the value
    // actually imported. It does NOT defeat a symlink: `resolve` is textual,
    // so a `dist` symlinked outside the package still resolves inside it.
    // Nothing here is a sandbox (see the loader's module doc); this stops a
    // mistake, not an attacker who already controls the plugin directory.
    const result = await runtime().load(join(FIXTURES, "good"), { entryOverrideForTests: "../throws/index.js" });
    expect("error" in result).toBe(true);
    if (!("error" in result)) return;
    expect(result.error).toContain("outside");
  });
});

describe("createPluginHost", () => {
  it("exposes the api version and the host services a plugin cannot import", () => {
    const host = createPluginHost({ pluginId: "test" });
    expect(host.apiVersion).toBeGreaterThanOrEqual(1);
    expect(host.shellQuote("a b")).toBe("'a b'");
    expect(typeof host.findBinary).toBe("function");
    expect(typeof host.detectBinary).toBe("function");
    expect(typeof host.probeVersion).toBe("function");
  });
});

describe("re-loading a plugin whose files changed", () => {
  it("reports the load as stale rather than pretending it reloaded", async () => {
    // The ESM cache is not evictable (see IMPORTED in plugin-runtime.ts), so
    // an upgrade in place keeps running the old code. What must never happen
    // is that silently: the manifest read here is the NEW one, so a caller
    // showing a version has to know the behaviour behind it is the old one.
    resetImportedForTests();
    const dir = join(tmpdir(), `plugin-reload-${crypto.randomUUID()}`);
    mkdirSync(dir, { recursive: true });
    const pkg = (version: string) =>
      JSON.stringify({
        name: "reload",
        version,
        private: true,
        subshell: {
          apiVersion: 1,
          id: "reload",
          type: "agent-harness",
          name: "Reload",
          description: "",
          entry: "index.js",
        },
      });
    const plugin = (marker: string) =>
      `export default () => ({ buildCommand: () => ["${marker}"], validateProfile: () => ({ valid: true, issues: [] }), capabilities: () => [] });`;

    await Bun.write(join(dir, "package.json"), pkg("1.0.0"));
    const entry = join(dir, "index.js");
    await Bun.write(entry, plugin("FIRST"));

    const first = await createInProcessRuntime().load(dir);
    expect("error" in first).toBe(false);
    if ("error" in first) return;
    expect(first.stale).toBeUndefined();
    expect(first.plugin.buildCommand({} as never)).toEqual(["FIRST"]);

    await Bun.write(join(dir, "package.json"), pkg("2.0.0"));
    await Bun.write(entry, plugin("SECOND-and-longer"));
    const second = await createInProcessRuntime().load(dir);
    expect("error" in second).toBe(false);
    if ("error" in second) return;
    // The pair that must be reported together: new manifest, old code.
    expect(second.stale).toBe(true);
    expect(second.plugin.buildCommand({} as never)).toEqual(["FIRST"]);
  });

  it("does not call an unchanged plugin stale when it is loaded twice", async () => {
    resetImportedForTests();
    const dir = join(tmpdir(), `plugin-reload-${crypto.randomUUID()}`);
    mkdirSync(dir, { recursive: true });
    await Bun.write(
      join(dir, "package.json"),
      JSON.stringify({
        name: "steady",
        version: "1.0.0",
        private: true,
        subshell: {
          apiVersion: 1,
          id: "steady",
          type: "agent-harness",
          name: "Steady",
          description: "",
          entry: "index.js",
        },
      }),
    );
    await Bun.write(
      join(dir, "index.js"),
      `export default () => ({ buildCommand: () => [], validateProfile: () => ({ valid: true, issues: [] }), capabilities: () => [] });`,
    );

    const first = await createInProcessRuntime().load(dir);
    const second = await createInProcessRuntime().load(dir);
    expect("error" in first).toBe(false);
    expect("error" in second).toBe(false);
    if ("error" in second) return;
    expect(second.stale).toBeUndefined();
  });
});

describe("upgrading a plugin that was BROKEN", () => {
  /** Writes a plugin dir and returns its entry path. */
  async function writePlugin(dir: string, id: string, body: string): Promise<void> {
    mkdirSync(dir, { recursive: true });
    await Bun.write(
      join(dir, "package.json"),
      JSON.stringify({
        name: id,
        version: "1.0.0",
        private: true,
        subshell: { apiVersion: 1, id, type: "agent-harness", name: id, description: "", entry: "index.js" },
      }),
    );
    await Bun.write(join(dir, "index.js"), body);
  }

  const HEALTHY = `export default () => ({ buildCommand: () => [], validateProfile: () => ({ valid: true, issues: [] }), capabilities: () => [] });`;

  it("reports the cached failure as stale once a fixed copy is on disk", async () => {
    // THE case an upgrade exists for. A module whose body throws is cached BY
    // ITS ERROR, so every later import rethrows without reading the file: the
    // page would show the old failure forever with no hint that a restart
    // clears it. The fingerprint is therefore recorded before the import, not
    // after, or a throwing plugin records nothing at all.
    resetImportedForTests();
    const dir = join(tmpdir(), `plugin-broken-${crypto.randomUUID()}`);
    await writePlugin(dir, "brokenup", `throw new Error("BOOM v1");`);

    const first = await createInProcessRuntime().load(dir);
    expect("error" in first && first.error).toContain("BOOM v1");
    expect("error" in first && first.stale).toBeUndefined();

    await writePlugin(dir, "brokenup", HEALTHY);
    const second = await createInProcessRuntime().load(dir);
    // Still broken, because the error is what the cache holds. But now it says
    // so, which is the difference between a dead end and a restart.
    expect("error" in second).toBe(true);
    expect("error" in second && second.stale).toBe(true);
  });

  it("marks a refusal made below the import stale too", async () => {
    // A capability mismatch is a verdict on the CACHED module, not on the
    // copy on disk. It was computed correctly and then dropped one line
    // before it would have been useful.
    resetImportedForTests();
    const dir = join(tmpdir(), `plugin-mismatch-${crypto.randomUUID()}`);
    const declaresResume = `export default () => ({ buildCommand: () => [], validateProfile: () => ({ valid: true, issues: [] }), capabilities: () => ["resume"] });`;
    await writePlugin(dir, "mismatch", declaresResume);

    const first = await createInProcessRuntime().load(dir);
    expect("error" in first && first.error).toContain("capabilities do not match");
    expect("error" in first && first.stale).toBeUndefined();

    await writePlugin(dir, "mismatch", `${declaresResume}\n// fixed upstream`);
    const second = await createInProcessRuntime().load(dir);
    expect("error" in second && second.stale).toBe(true);
  });
});

describe("re-installing the same version", () => {
  it("is not an upgrade, even though every file was rewritten", async () => {
    // `installEmbedded` writes unconditionally, so the mtime moves on a
    // reinstall of identical bytes. Keying on mtime called that an upgrade
    // and asked the operator to restart for nothing.
    resetImportedForTests();
    const dir = join(tmpdir(), `plugin-same-${crypto.randomUUID()}`);
    mkdirSync(dir, { recursive: true });
    const pkg = JSON.stringify({
      name: "same",
      version: "1.0.0",
      private: true,
      subshell: { apiVersion: 1, id: "same", type: "agent-harness", name: "Same", description: "", entry: "index.js" },
    });
    const body = `export default () => ({ buildCommand: () => [], validateProfile: () => ({ valid: true, issues: [] }), capabilities: () => [] });`;
    await Bun.write(join(dir, "package.json"), pkg);
    await Bun.write(join(dir, "index.js"), body);
    await createInProcessRuntime().load(dir);

    // Byte-identical rewrite, with a later timestamp, exactly as an install does.
    await Bun.write(join(dir, "index.js"), body);
    await utimes(join(dir, "index.js"), new Date(Date.now() + 5000), new Date(Date.now() + 5000));

    const again = await createInProcessRuntime().load(dir);
    expect("error" in again).toBe(false);
    if ("error" in again) return;
    expect(again.stale).toBeUndefined();
  });
});
