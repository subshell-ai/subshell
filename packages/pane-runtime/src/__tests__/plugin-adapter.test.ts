import { describe, expect, it } from "bun:test";
import { chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SubshellManifest, SubshellPlugin } from "@subshell-ai/plugin-api";
import { adaptPlugin, versionOf } from "../plugin-adapter.js";

/**
 * The adapter is the seam between what a plugin declares and what the server
 * and agent still read, and until this file existed nothing tested it.
 *
 * That gap is not hypothetical: the hermes version-banner regression reached
 * a commit because deleting `getVersion` from the plugin broke a mapping no
 * test covered. Every mapping below is one that would otherwise fail silently
 * and surface as wrong text on the Nodes page.
 */

const MANIFEST: SubshellManifest = {
  apiVersion: 1,
  id: "stub",
  type: "agent-harness",
  name: "Stub Harness",
  description: "a stub",
  icon: "S",
  entry: "dist/index.js",
  detect: { binaryName: "stubtool", envOverride: "STUBTOOL_PATH", knownPaths: [] },
  install: { command: "install stubtool", docsUrl: "https://example.invalid" },
};

/** The smallest plugin the contract allows. */
function minimal(over: Partial<SubshellPlugin> = {}): SubshellPlugin {
  return {
    buildCommand: (input) => [input.binary],
    validateProfile: () => ({ valid: true, issues: [] }),
    capabilities: () => [],
    ...over,
  };
}

describe("adaptPlugin: identity comes from the manifest", () => {
  it("maps every identity field off the manifest, not the plugin", () => {
    const a = adaptPlugin(MANIFEST, minimal());
    expect(a.id).toBe("stub");
    expect(a.name).toBe("Stub Harness");
    expect(a.type).toBe("agent-harness");
    expect(a.description).toBe("a stub");
    expect(a.icon).toBe("S");
    expect(a.binaryName).toBe("stubtool");
    // The override NAME rides in detectSpec and nowhere else: this is what
    // the UI names when an override is broken (terminal's `SHELL` is the
    // shape a `<BINARY>_PATH` derivation would have gotten wrong), and it
    // must be the SAME object shipped to nodes as the lookup rule.
    expect(a.detectSpec).toEqual({ binaryName: "stubtool", envOverride: "STUBTOOL_PATH", knownPaths: [] });
    expect(a.installHint).toEqual({ command: "install stubtool", docsUrl: "https://example.invalid" });
  });

  it("falls back to the id when the manifest declares no binary", () => {
    const { detect: _drop, ...noDetect } = MANIFEST;
    expect(adaptPlugin(noDetect, minimal()).binaryName).toBe("stub");
    // No detect block, no spec — and therefore no override NAME to show:
    // the wire maps this to "" rather than inventing one.
    expect(adaptPlugin(noDetect, minimal()).detectSpec).toBeUndefined();
  });

  it("a plugin with no detect block reports no-binary, not a missing one", async () => {
    // "not on PATH" plus a blank install command would tell someone their
    // PATH is wrong about a plugin that never wanted a binary.
    const { detect: _drop, ...noDetect } = MANIFEST;
    const a = adaptPlugin(noDetect, minimal());
    expect(await a.isInstalled()).toBe(false);
    expect((await a.detect()).reason).toBe("no-binary");
  });

  it("carries an empty install hint rather than undefined when the manifest omits one", () => {
    const { install: _drop, ...noInstall } = MANIFEST;
    expect(adaptPlugin(noInstall, minimal()).installHint).toEqual({ command: "", docsUrl: "" });
  });
});

describe("adaptPlugin: optional members are present only when implemented", () => {
  it("omits every optional member for a minimal plugin", () => {
    const a = adaptPlugin(MANIFEST, minimal());
    expect(a.mcpRegistration).toBeUndefined();
    expect(a.resume).toBeUndefined();
    expect(a.supportsAttentionHooks).toBeUndefined();
    expect(a.exitStatus).toBeUndefined();
  });

  it("attaches them when the plugin has them", () => {
    const resume = { allocateHarnessSessionId: () => "id", resumePath: () => "/p" };
    const a = adaptPlugin(
      MANIFEST,
      minimal({
        mcpRegistration: () => ({ fileContent: "x" }),
        resume,
        supportsAttentionHooks: true,
        exitStatus: (code) => (code === 1 ? "boom" : null),
      }),
    );
    expect(a.mcpRegistration?.({ command: "c", args: [] }, "/p")).toEqual({ fileContent: "x" });
    expect(a.resume).toBe(resume);
    expect(a.supportsAttentionHooks).toBe(true);
    expect(a.exitStatus?.(1)).toBe("boom");
    expect(a.exitStatus?.(2)).toBeNull();
  });

  it("answers empty reference data rather than undefined", () => {
    const a = adaptPlugin(MANIFEST, minimal());
    expect(a.settingsFields()).toEqual([]);
    expect(a.suggestedEnv()).toEqual([]);
    expect(a.suggestedFlags()).toEqual([]);
  });

  it("a plugin with no MCP setup shows no steps, never a false 'automatic'", () => {
    // `{mode:"auto"}` would tell the profile editor registration is handled.
    expect(adaptPlugin(MANIFEST, minimal()).mcpSetup({ command: "c", args: [] })).toEqual({
      mode: "manual",
      steps: [],
    });
  });
});

describe("adaptPlugin: the detect block rides through as data", () => {
  // Inversion spec §5: the control plane sends the manifest's detect rule on
  // the `launch` frame (and Task 5's `detect` command) instead of shipping
  // plugin code to resolve it. That only works if the rule reaches consumers as
  // data on the HarnessPlugin — the same block `detectFor` closes over.
  it("carries the manifest's detect block verbatim as detectSpec", () => {
    const a = adaptPlugin(MANIFEST, minimal());
    expect(a.detectSpec).toEqual(MANIFEST.detect);
    expect(a.detectSpec).toBe(MANIFEST.detect); // straight through: the same object, not a copy
  });

  it("has no detectSpec key at all when the manifest declares no binary", () => {
    const { detect: _drop, ...noDetect } = MANIFEST;
    // Absent, not undefined: `detectSpec in plugin` must answer the question
    // the launch frame composes from (a no-binary plugin sends no resolve rule).
    expect("detectSpec" in adaptPlugin(noDetect, minimal())).toBe(false);
  });
});

describe("adaptPlugin: the hostEnv declaration rides through as data (spec §5 as amended)", () => {
  it("carries the manifest's hostEnv names so the plane can ask nodes for their values", () => {
    // The resume landmine's data path: `detectEnvNames` unions this list on
    // the plane because the NODE holds no manifest to name it. A copy, not
    // the manifest's array — the wire's `envNames` must never alias
    // module-loaded manifest data that another consumer could mutate.
    const manifest = { ...MANIFEST, hostEnv: ["CLAUDE_CONFIG_DIR"] };
    const a = adaptPlugin(manifest, minimal());
    expect(a.hostEnv).toEqual(["CLAUDE_CONFIG_DIR"]);
    expect(a.hostEnv).not.toBe(manifest.hostEnv);
  });

  it("has no hostEnv key when the manifest declares none", () => {
    // Absent-not-undefined, like detectSpec: the union skips what is absent.
    expect("hostEnv" in adaptPlugin(MANIFEST, minimal())).toBe(false);
  });
});

describe("adaptPlugin carries parseVersion for the detect command's server-side mapping", () => {
  it("attaches the plugin's parser when it has one, applied to RAW text without probing", () => {
    // The hermes half of the inversion (spec 2026-09-10 §4): the node answers
    // raw text, and this member is the ONLY way the control plane turns that
    // text into a version — it must not touch the filesystem.
    const a = adaptPlugin(MANIFEST, minimal({ parseVersion: (raw) => raw.match(/\d+\.\d+/)?.[0] ?? null }));
    expect(a.parseVersion?.("Hermes Agent v0.16.0 (2026.6.5)")).toBe("0.16");
  });

  it("has no parseVersion key when the plugin declares none", () => {
    // Absent-not-undefined, like detectSpec: the driver distinguishes "no
    // parser, store the raw text" from "a parser that said null".
    const a = adaptPlugin(MANIFEST, minimal());
    expect("parseVersion" in a).toBe(false);
    expect(a.parseVersion).toBeUndefined();
  });
});

describe("versionOf: the host probes, the plugin interprets", () => {
  /** A fake harness that prints exactly `output` for any argument. */
  async function fakeBinary(output: string): Promise<string> {
    const path = join(tmpdir(), `adapter-fake-${crypto.randomUUID()}.sh`);
    await Bun.write(path, `#!/bin/sh\nprintf '%s' '${output}'\n`);
    chmodSync(path, 0o755);
    return path;
  }

  it("uses the trimmed probe output when the plugin declares no parser", async () => {
    expect(await versionOf(minimal(), await fakeBinary("1.2.3\n"))).toBe("1.2.3");
  });

  it("hands the raw output to parseVersion when the plugin has one", async () => {
    // The hermes case: a banner, not a bare version. Without this hand-off the
    // Nodes page shows the whole first line where a version belongs.
    const banner = "Hermes Agent v0.16.0 (2026.6.5) - upstream 5e01a5db";
    const seen: string[] = [];
    const plugin = minimal({
      parseVersion: (raw) => {
        seen.push(raw);
        return raw.match(/\d+\.\d+\.\d+/)?.[0] ?? null;
      },
    });
    expect(await versionOf(plugin, await fakeBinary(banner))).toBe("0.16.0");
    expect(seen).toEqual([banner]);
  });

  it("never calls parseVersion when the probe produced nothing", async () => {
    let called = false;
    const plugin = minimal({
      parseVersion: () => {
        called = true;
        return "invented";
      },
    });
    expect(await versionOf(plugin, "/nonexistent/tool")).toBeNull();
    expect(called).toBe(false);
  });
});
