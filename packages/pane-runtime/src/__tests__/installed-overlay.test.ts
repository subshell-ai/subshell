import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PLUGIN_API_VERSION } from "@subshell-ai/plugin-api";
import { pluginsDir, uninstallPlugin } from "../plugins-dir.js";
import {
  allHarnesses,
  allNetworkPlugins,
  builtInHarnesses,
  clearInstalledPlugins,
  getBuiltInHarness,
  getHarness,
  getNetworkPlugin,
  refreshInstalledPlugins,
  resetRegistryForTests,
} from "../registry.js";
import type { PresetDefinition } from "../types.js";

/**
 * The installed overlay: what makes a registry-installed plugin RESOLVE, not
 * merely be listed.
 *
 * Task 9 moved plugin hosting onto the control plane, but every launch-path
 * lookup keyed off the compiled-in `BUILT_INS` while `plugin-report.ts`
 * loaded installed plugins and discarded them, so a third-party plugin could
 * never be detected, validated on a preset, or launched. The overlay is the
 * registration path those lookups now consult: a module-level
 * built-ins + installed merge, populated only by `refreshInstalledPlugins`
 * (which the control plane calls; the agent never does, so its view stays
 * built-in-only without any code in it saying so).
 */

const BUILT_IN_IDS = [
  "claude-code",
  "cline",
  "codex",
  "gemini",
  "grok-build",
  "hermes",
  "oh-my-pi",
  "open-interpreter",
  "openclaw",
  "opencode",
  "openhands",
  "pi",
  "qwen-code",
  "ssh",
  "terminal",
];

/** Minimal complete preset for `buildCommand` calls in these tests. */
const PRESET: PresetDefinition = { name: "p", env: {}, flags: [], settings: null, configIsolation: false };

/** A temp agent-shaped data dir (nothing under `plugins/` yet). */
function tempDataDir(): string {
  return mkdtempSync(join(tmpdir(), "installed-overlay-"));
}

/**
 * Write one plugin package the way an install leaves it: `package.json` with
 * a `subshell` block and an entry module. `body` is the module source; the
 * default is a minimal valid plugin whose `buildCommand` marks its output so
 * a test can tell the overlay's copy from any other.
 */
async function writePlugin(
  dataDir: string,
  id: string,
  opts: { body?: string; detect?: boolean; pkgName?: string; version?: string; extra?: Record<string, unknown> } = {},
): Promise<string> {
  const dir = join(pluginsDir(dataDir), id);
  mkdirSync(dir, { recursive: true });
  await writeFile(
    join(dir, "package.json"),
    JSON.stringify({
      name: opts.pkgName ?? id,
      version: opts.version ?? "1.0.0",
      type: "module",
      subshell: {
        apiVersion: PLUGIN_API_VERSION,
        id,
        type: "agent-harness",
        name: `${id} plugin`,
        description: "a scripted install",
        entry: "index.js",
        ...(opts.detect
          ? { detect: { binaryName: `${id}-cli`, envOverride: `${id.toUpperCase()}_PATH`, knownPaths: [] } }
          : {}),
      },
      ...opts.extra,
    }),
    "utf8",
  );
  await writeFile(
    join(dir, "index.js"),
    opts.body ??
      "export default () => ({\n" +
        "  capabilities: () => [],\n" +
        `  buildCommand: (input) => [input.binary, ${JSON.stringify(`--from-${id}`)}],\n` +
        "  validatePreset: () => ({ valid: true, issues: [] }),\n" +
        "});\n",
    "utf8",
  );
  return dir;
}

/** The default body, named: a built-in copy read from disk must still be recognisable. */
const DISK_PI_BODY =
  "export default () => ({\n" +
  "  capabilities: () => [],\n" +
  '  buildCommand: (input) => [input.binary, "--from-pi"],\n' +
  "  validatePreset: () => ({ valid: true, issues: [] }),\n" +
  "});\n";

/**
 * Write one NETWORK plugin package the way an install leaves it.
 *
 * The manifest carries only what the network parser requires; the entry
 * implements the four required members, which is the whole contract the
 * loader checks. A version is the one thing a caller varies, because that is
 * the rule under test.
 */
async function writeNetworkPlugin(dataDir: string, id: string, version: string): Promise<string> {
  const dir = join(pluginsDir(dataDir), id);
  mkdirSync(dir, { recursive: true });
  await writeFile(
    join(dir, "package.json"),
    JSON.stringify({
      name: id,
      version,
      type: "module",
      subshell: {
        apiVersion: PLUGIN_API_VERSION,
        id,
        type: "network",
        name: `${id} plugin`,
        description: "a scripted network install",
        entry: "index.js",
        network: { platforms: ["linux", "darwin"], exposure: "private" },
      },
    }),
    "utf8",
  );
  await writeFile(
    join(dir, "index.js"),
    "export default () => ({\n" +
      "  capabilities: () => [],\n" +
      '  status: async () => ({ state: "joined", addresses: [], hints: [] }),\n' +
      '  join: async () => ({ state: "joined" }),\n' +
      "  leave: async () => {},\n" +
      "});\n",
    "utf8",
  );
  return dir;
}

/** Captures `console.warn` for the duration of `run`. */
async function captureWarnings(run: () => Promise<void>): Promise<string[]> {
  const seen: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => {
    seen.push(args.map(String).join(" "));
  };
  try {
    await run();
  } finally {
    console.warn = original;
  }
  return seen;
}

describe("the installed overlay", () => {
  afterEach(() => {
    clearInstalledPlugins();
    resetRegistryForTests();
  });

  it("resolves an installed plugin once refreshed, alongside the built-ins", async () => {
    const dir = tempDataDir();
    await writePlugin(dir, "acme", { detect: true });

    await refreshInstalledPlugins(dir);

    const acme = getHarness("acme");
    expect(acme).toBeDefined();
    expect(acme?.name).toBe("acme plugin");
    // Identity comes from the manifest, exactly like a built-in's: the detect
    // block is what `detectSpecs()` ships to nodes, so it must ride through.
    expect(acme?.binaryName).toBe("acme-cli");
    expect(acme?.detectSpec).toEqual({ binaryName: "acme-cli", envOverride: "ACME_PATH", knownPaths: [] });
    // Behaviour comes from the loaded module — the half the report used to
    // discard, and the half every launch needs.
    expect(acme?.buildCommand({ binary: "/usr/bin/acme-cli", cwd: "/tmp", preset: PRESET, subshellName: "" })).toEqual([
      "/usr/bin/acme-cli",
      "--from-acme",
    ]);

    expect(
      allHarnesses()
        .map((h) => h.id)
        .sort(),
    ).toEqual([...BUILT_IN_IDS, "acme"].sort());
  });

  it("is lazy: nothing on disk is loaded or consulted without a refresh", async () => {
    // The registry's import-purity rule, extended to the overlay: a host that
    // never calls `refreshInstalledPlugins` must not touch the disk by way of
    // `getHarness`. The agent's view stays built-in-only exactly this way.
    const dir = tempDataDir();
    await writePlugin(dir, "acme", {
      // Would be an obvious, loud failure if any import path loaded it.
      body: 'throw new Error("loaded without a refresh call");\n',
    });

    expect(getHarness("acme")).toBeUndefined();
    expect(
      allHarnesses()
        .map((h) => h.id)
        .sort(),
    ).toEqual(BUILT_IN_IDS);
  });

  it("a plugin that throws at import is reported broken and costs nothing else", async () => {
    const dir = tempDataDir();
    await writePlugin(dir, "boom", { body: 'throw new Error("boom at import");\n' });
    await writePlugin(dir, "acme");

    const { broken } = await refreshInstalledPlugins(dir);

    expect(broken.map((b) => b.id)).toEqual(["boom"]);
    expect(broken[0]?.error).toContain("boom at import");
    expect(getHarness("boom")).toBeUndefined();
    // The containment rule: one bad plugin costs its own resolution, never
    // the healthy install beside it and never the built-in set.
    expect(getHarness("acme")).toBeDefined();
    expect(allHarnesses().length).toBe(BUILT_IN_IDS.length + 1);
  });

  it("a plugin whose manifest will not parse is broken too, not absent", async () => {
    // `listInstalled` reports it without ever reaching the loader, and a
    // broken plugin must not be resolved into the overlay.
    const dir = tempDataDir();
    const junk = join(pluginsDir(dir), "junkid");
    mkdirSync(junk, { recursive: true });
    await writeFile(join(junk, "package.json"), "{not json", "utf8");

    const { broken } = await refreshInstalledPlugins(dir);

    expect(broken.map((b) => b.id)).toEqual(["junkid"]);
    expect(broken[0]?.error).toContain("package.json");
    expect(getHarness("junkid")).toBeUndefined();
    expect(allHarnesses().length).toBe(BUILT_IN_IDS.length);
  });

  it("an installed copy of a built-in id never shadows the compiled one, and the shadow is named once", async () => {
    const dir = tempDataDir();
    // A registry package claiming a built-in's id (§2.5 rule 3's flow, or a
    // squat): the bytes exist, so `listInstalled` sees them — but the copy
    // this release tested is the one that answers.
    await writePlugin(dir, "pi", { pkgName: "squatter-pi", extra: {} });
    await writeFile(
      join(pluginsDir(dir), "pi", "install.json"),
      JSON.stringify({
        name: "squatter-pi",
        version: "1.0.0",
        integrity: "sha512-x",
        installedAt: new Date().toISOString(),
      }),
      "utf8",
    );

    const warnings = await captureWarnings(async () => {
      await refreshInstalledPlugins(dir);
    });

    // The built-in's manifest name ("pi"), not the squatter's ("pi plugin").
    expect(getHarness("pi")?.name).toBe("pi");
    expect(warnings.filter((w) => w.includes("pi"))).toHaveLength(1);
    expect(warnings[0]).toContain("at least as new");
    // "once" means once: a second refresh of the same shadow stays quiet.
    const more = await captureWarnings(async () => {
      await refreshInstalledPlugins(dir);
    });
    expect(more.filter((w) => w.includes("at least as new"))).toEqual([]);
  });

  it("the instance's own seeded built-in copies refresh silently", async () => {
    // The ordinary state: the server seeds `pi` into its store, with no
    // install record (that sidecar is what a REGISTRY install writes). No
    // shadow, so no warning — a boot that warned about six seeded
    // directories would train everyone to ignore the warning that matters.
    const dir = tempDataDir();
    await writePlugin(dir, "pi", { pkgName: "pi-is-me" }); // embedded shape: no install.json

    const warnings = await captureWarnings(async () => {
      await refreshInstalledPlugins(dir);
    });

    expect(warnings).toEqual([]);
    expect(getHarness("pi")?.name).toBe("pi");
    expect(allHarnesses().length).toBe(BUILT_IN_IDS.length);
  });

  it("loads an installed copy newer than the bundle for a built-in id", async () => {
    const dir = tempDataDir();
    await writePlugin(dir, "pi", { version: "99.0.0", body: DISK_PI_BODY });
    await refreshInstalledPlugins(dir);
    expect(getHarness("pi")?.name).toBe("pi plugin");
    expect(getHarness("pi")?.buildCommand({ binary: "x" } as never)).toEqual(["x", "--from-pi"]);
    expect(allHarnesses().filter((h) => h.id === "pi")).toHaveLength(1);
  });

  it("keeps the compiled copy when the installed one is not newer", async () => {
    const dir = tempDataDir();
    await writePlugin(dir, "pi", { version: "0.0.1", body: DISK_PI_BODY });
    await refreshInstalledPlugins(dir);
    expect(getHarness("pi")?.name).toBe("pi");
    expect(allHarnesses().filter((h) => h.id === "pi")).toHaveLength(1);
  });

  it("loads a newer installed network plugin for a built-in id", async () => {
    const dir = tempDataDir();
    await writeNetworkPlugin(dir, "tailscale", "99.0.0");
    await refreshInstalledPlugins(dir);
    expect(getNetworkPlugin("tailscale")?.manifest.name).toBe("tailscale plugin");
    expect(allNetworkPlugins().filter((n) => n.manifest.id === "tailscale")).toHaveLength(1);
  });

  it("an uninstall followed by a refresh makes the plugin unresolvable again", async () => {
    const dir = tempDataDir();
    await writePlugin(dir, "acme");
    await refreshInstalledPlugins(dir);
    expect(getHarness("acme")).toBeDefined();

    expect(await uninstallPlugin(dir, "acme")).toBe(true);
    await refreshInstalledPlugins(dir);

    expect(getHarness("acme")).toBeUndefined();
    expect(
      allHarnesses()
        .map((h) => h.id)
        .sort(),
    ).toEqual(BUILT_IN_IDS);
  });

  it("the overlay never enters the built-in catalog", async () => {
    // The two honest built-in-catalog uses (the instance page's one-click
    // region, the setup wizard's offline list) read `builtInHarnesses()`. If
    // an installed plugin ever leaked into THAT list, a registry install
    // would offer "install the copy this build carries" for a plugin this
    // build does not carry.
    const dir = tempDataDir();
    await writePlugin(dir, "acme");
    await refreshInstalledPlugins(dir);

    expect(
      builtInHarnesses()
        .map((h) => h.id)
        .sort(),
    ).toEqual(BUILT_IN_IDS);
    expect(getBuiltInHarness("acme")).toBeUndefined();
    expect(getHarness("acme")).toBeDefined(); // the merged read still resolves it
  });

  it("the merged list is stable across reads and clearable", async () => {
    const dir = tempDataDir();
    await writePlugin(dir, "acme");
    await refreshInstalledPlugins(dir);
    // Identity, not just equality: callers memoize per request and the old
    // no-overlay fast path returned the same array every time.
    expect(allHarnesses()).toBe(allHarnesses());

    clearInstalledPlugins();
    expect(getHarness("acme")).toBeUndefined();
    expect(allHarnesses()).toBe(allHarnesses());
  });
});
