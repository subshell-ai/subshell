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
    expect(a.description).toBe("a stub");
    expect(a.icon).toBe("S");
    expect(a.binaryName).toBe("stubtool");
    expect(a.installHint).toEqual({ command: "install stubtool", docsUrl: "https://example.invalid" });
  });

  it("falls back to the id when the manifest declares no binary", () => {
    const { detect: _drop, ...noDetect } = MANIFEST;
    expect(adaptPlugin(noDetect, minimal()).binaryName).toBe("stub");
  });

  it("a plugin with no detect block is never installed, and says why", async () => {
    const { detect: _drop, ...noDetect } = MANIFEST;
    const a = adaptPlugin(noDetect, minimal());
    expect(await a.isInstalled()).toBe(false);
    expect((await a.detect()).reason).toBe("not-on-path");
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
    const resume = { allocateHarnessSessionId: () => "id", canResume: () => true };
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
