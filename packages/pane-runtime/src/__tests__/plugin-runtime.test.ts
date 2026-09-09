import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import { createPluginHost } from "../plugin-host.js";
import { createInProcessRuntime } from "../plugin-runtime.js";

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
