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
    // A plugin that declares no binary is not one whose binary is missing, and
    // the difference is user-visible: "not on PATH" plus a blank install
    // command tells someone their PATH is wrong about a plugin that never
    // wanted a binary. `no-binary` is what a surface should render as "nothing
    // to install" rather than as a failure.
    return async () => ({ path: null, reason: "no-binary" });
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
    // The detect block rides through as DATA, verbatim and only when present
    // (inversion spec §5): the control plane ships this same rule on the
    // `launch` frame instead of shipping plugin code to resolve it, so a
    // consumer reading `detectSpec` sees exactly what `detectFor` closes over.
    ...(manifest.detect ? { detectSpec: manifest.detect } : {}),
    description: manifest.description,
    icon: manifest.icon,
    installHint: manifest.install ?? { command: "", docsUrl: "" },
    // A legacy field the plugin model replaces: "enabled by default" becomes
    // "installed" once the node owns its plugin set. Not worth a manifest
    // field with one possible value. (`ttyRequired` was the same, and is gone:
    // nothing read it.)
    enabledByDefault: true,

    detect,
    findBinary: async () => (await detect()).path,
    isInstalled: async () => (await detect()).path !== null,
    getVersion: async () => {
      const found = await detect();
      return found.path ? await versionOf(plugin, found.path) : null;
    },
    versionAt: (binaryPath: string) => versionOf(plugin, binaryPath),

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
  // The raw-text half of `versionOf`, exposed whole: the `detect` command's
  // node side answers unparsed text, and the control plane maps it HERE.
  const parse = plugin.parseVersion?.bind(plugin);
  if (parse) adapted.parseVersion = (raw: string): string | null => parse(raw);

  return adapted;
}
