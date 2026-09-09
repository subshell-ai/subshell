import type { SubshellManifest, SubshellPlugin } from "@subshell-ai/plugin-api";
import { type DetectionResult, detectBinary } from "./binary-lookup.js";
import type { HarnessPlugin, McpLaunchSpec, McpSetupInfo } from "./types.js";
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
 * Wraps a manifest + loaded plugin as a legacy {@link HarnessPlugin}.
 * @param manifest - the plugin's `subshell` block
 * @param plugin - the object its factory returned
 */
export function adaptPlugin(manifest: SubshellManifest, plugin: SubshellPlugin): HarnessPlugin {
  const detect = plugin.detect ? () => plugin.detect?.() as Promise<DetectionResult> : detectFor(manifest);

  return {
    id: manifest.id,
    name: manifest.name,
    binaryName: manifest.detect?.binaryName ?? manifest.id,
    description: manifest.description,
    icon: manifest.icon,
    installHint: manifest.install ?? { command: "", docsUrl: "" },
    // Both are legacy fields the plugin model replaces: a plugin needs a TTY
    // (every harness does) and "enabled by default" becomes "installed" once
    // the node owns its plugin set. Neither is worth a manifest field that
    // would only ever hold one value.
    ttyRequired: true,
    enabledByDefault: true,

    detect,
    findBinary: async () => (await detect()).path,
    isInstalled: async () => (await detect()).path !== null,
    getVersion: async () => {
      const found = await detect();
      return found.path ? await probeVersion(found.path) : null;
    },

    buildCommand: (input) => plugin.buildCommand(input),
    validateProfile: (profile) => plugin.validateProfile(profile),
    settingsFields: () => plugin.profileSettings?.() ?? [],
    suggestedEnv: () => plugin.suggestedEnv?.() ?? [],
    suggestedFlags: () => plugin.suggestedFlags?.() ?? [],
    // A plugin with no MCP capability has no steps to show, which renders as
    // an empty section rather than as a claim that registration is automatic.
    mcpSetup: (launch: McpLaunchSpec): McpSetupInfo => plugin.mcpSetup?.(launch) ?? { mode: "manual", steps: [] },
    ...(plugin.mcpRegistration
      ? { mcpRegistration: (launch: McpLaunchSpec, path: string) => plugin.mcpRegistration?.(launch, path) }
      : {}),
    ...(plugin.resume ? { resume: plugin.resume } : {}),
    ...(plugin.supportsAttentionHooks ? { supportsAttentionHooks: true } : {}),
    ...(plugin.exitStatus ? { exitStatus: (code: number) => plugin.exitStatus?.(code) ?? null } : {}),
  } as HarnessPlugin;
}
