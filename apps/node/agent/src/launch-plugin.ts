import { join } from "node:path";
import { adaptPlugin, createInProcessRuntime, type HarnessPlugin } from "@internal/pane-runtime";
import type { SubshellManifest } from "@subshell-ai/plugin-api";
import { listInstalled, pluginsDir } from "./plugins-dir.js";

/**
 * Resolving the plugin a launch names, against what THIS node has installed.
 *
 * The control plane filters launches by what a node reported, but a signature
 * proves who sent a command and never whether the target can serve it. This is
 * the node's own check, and it is the same argument `allowed-dirs.ts` makes
 * about directories: a rule that lives only on the control plane is worth
 * nothing against a compromised one.
 *
 * It replaces `getHarness(id)`, which answered from the registry compiled into
 * the binary. That registry does not know what is installed here, so the node
 * would launch a harness nobody put on it.
 */

/** A plugin ready to launch with. */
export interface ResolvedLaunchPlugin {
  manifest: SubshellManifest;
  /** The legacy shape the launch path still builds commands through. */
  plugin: HarnessPlugin;
}

/** Why a launch cannot proceed. */
export interface LaunchPluginError {
  error: string;
}

/**
 * Resolves `id` against this node's installed plugins.
 * @param dataDir - the agent's data dir
 * @param id - the plugin the launch names
 * @returns the plugin, or why it cannot be used. Never rejects.
 */
export async function resolveLaunchPlugin(
  dataDir: string,
  id: string,
): Promise<ResolvedLaunchPlugin | LaunchPluginError> {
  const installed = (await listInstalled(dataDir)).find((p) => p.id === id);
  if (!installed) {
    return { error: `plugin '${id}' is not installed on this node` };
  }
  if (installed.broken) {
    return { error: `plugin '${id}' is installed but broken: ${installed.broken}` };
  }

  const loaded = await createInProcessRuntime().load(join(pluginsDir(dataDir), id));
  if ("error" in loaded) {
    return { error: `plugin '${id}' failed to load: ${loaded.error}` };
  }
  return { manifest: loaded.manifest, plugin: adaptPlugin(loaded.manifest, loaded.plugin) };
}
