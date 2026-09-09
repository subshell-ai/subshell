import type { SubshellManifest, SubshellPlugin } from "@subshell-ai/plugin-api";
import { type DetectionResult, detectBinary } from "./binary-lookup.js";
import type { HarnessPlugin, McpLaunchSpec, McpRegistration, McpSetupInfo } from "./types.js";
import { probeVersion } from "./version-probe.js";

/**
 * Presenting a plugin as the `HarnessPlugin` the server and the agent still
 * consume.
 *
 * This exists because the extraction happens one plugin at a time. Every
 * caller in `apps/server/api` and `apps/node/agent` expects the old
 * interface, and rewriting all of them in the same commit as the first
 * extraction would make both changes unreviewable. So the two shapes coexist,
 * and this is the one place that knows both.
 *
 * The split it enforces is the real one:
 *
 * - **identity and detection come from the MANIFEST** (package.json), so a
 *   host can list a plugin and probe for its binary without executing a line
 *   of plugin code;
 * - **behaviour comes from the PLUGIN** (the loaded module).
 *
 * It is transitional. When the consumers read plugin descriptors directly,
 * this goes away, and the manifest/plugin split above is what they will read.
 */

/** Detection metadata is optional in the manifest; a plugin without it is never "installed". */
function detectFor(manifest: SubshellManifest): () => Promise<DetectionResult> {
  const spec = manifest.detect;
  if (!spec) {
    // Not an error: a plugin can legitimately need no binary. It simply never
    // resolves one, and the launch gate treats it as unavailable.
    return async () => ({ path: null, reason: "not-on-path" });
  }
  return () => detectBinary(spec.binaryName, spec.envOverride, spec.knownPaths);
}

/**
 * Reads a version for an ALREADY-RESOLVED binary.
 *
 * Split out from `getVersion` because `scanOne` resolves the path itself and
 * then asks for a version: an adapter that re-detected here would walk the
 * whole ladder a second time per harness per scan, which is exactly the
 * double walk `scanOne` was changed to avoid.
 *
 * The host probes (it owns the deadline); the plugin interprets, because only
 * it knows whether its harness prints a banner or a bare version.
 */
export async function versionOf(plugin: SubshellPlugin, binary: string): Promise<string | null> {
  const raw = await probeVersion(binary);
  if (raw === null) return null;
  return plugin.parseVersion ? plugin.parseVersion(raw) : raw;
}

/**
 * Wraps a manifest + loaded plugin as a legacy {@link HarnessPlugin}.
 * @param manifest - the plugin's `subshell` block
 * @param plugin - the object its factory returned
 */
export function adaptPlugin(manifest: SubshellManifest, plugin: SubshellPlugin): HarnessPlugin {
  // Bound once: reading `plugin.detect` inside the closure would re-narrow on
  // every call, and TypeScript cannot prove it is still there.
  const ownDetect = plugin.detect?.bind(plugin);
  const detect: () => Promise<DetectionResult> = ownDetect ?? detectFor(manifest);

  const adapted: HarnessPlugin = {
    id: manifest.id,
    name: manifest.name,
    binaryName: manifest.detect?.binaryName ?? manifest.id,
    description: manifest.description,
    icon: manifest.icon,
    installHint: manifest.install ?? { command: "", docsUrl: "" },
    // Both are legacy fields the plugin model replaces: every harness needs a
    // TTY, and "enabled by default" becomes "installed" once the node owns its
    // plugin set. Neither is worth a manifest field with one possible value.
    ttyRequired: true,
    enabledByDefault: true,

    detect,
    findBinary: async () => (await detect()).path,
    isInstalled: async () => (await detect()).path !== null,
    getVersion: async () => {
      const found = await detect();
      return found.path ? await versionOf(plugin, found.path) : null;
    },

    buildCommand: (input) => plugin.buildCommand(input),
    validateProfile: (profile) => plugin.validateProfile(profile),
    settingsFields: () => plugin.profileSettings?.() ?? [],
    suggestedEnv: () => plugin.suggestedEnv?.() ?? [],
    suggestedFlags: () => plugin.suggestedFlags?.() ?? [],
    // A plugin with no MCP capability has no steps to show, which renders as
    // an empty section rather than as a claim that registration is automatic.
    mcpSetup: (launch: McpLaunchSpec): McpSetupInfo => plugin.mcpSetup?.(launch) ?? { mode: "manual", steps: [] },
  };

  // Optional members are attached only when the plugin has them, so
  // `mcpRegistration in plugin` stays the question callers already ask. Each
  // is narrowed at its own property rather than the whole literal being cast:
  // a blanket `as HarnessPlugin` would also swallow a future rename here.
  const reg = plugin.mcpRegistration?.bind(plugin);
  if (reg) {
    adapted.mcpRegistration = (launch: McpLaunchSpec, path: string): McpRegistration => reg(launch, path);
  }
  if (plugin.resume) adapted.resume = plugin.resume;
  if (plugin.supportsAttentionHooks) adapted.supportsAttentionHooks = true;
  const exit = plugin.exitStatus?.bind(plugin);
  if (exit) adapted.exitStatus = (code: number) => exit(code);

  return adapted;
}
