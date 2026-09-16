import { join } from "node:path";
import type { PluginReportWire } from "@internal/subshell-protocol";
import { isHarnessType, type SubshellPlugin } from "@subshell-ai/plugin-api";
import { createInProcessRuntime } from "./plugin-runtime.js";
import { listInstalled, pluginsDir } from "./plugins-dir.js";

/**
 * Describing this node's plugins to the control plane.
 *
 * The server holds no plugin code for a machine it does not run on, so
 * everything it needs about a plugin travels as DATA: enough to list it,
 * render its preset editor, label its exit codes and explain its MCP setup.
 *
 * A plugin that will not load still gets a row, carrying `broken`. Dropping it
 * would make a misconfigured plugin indistinguishable from one nobody
 * installed, and the node page has to be able to tell a user which of those
 * they are looking at.
 */

/**
 * The exit codes worth asking a plugin about.
 *
 * `exitStatus` is a lookup rather than an enumeration, so there is no way to
 * ask a plugin which codes it names. This range covers the codes the built-ins
 * actually use plus the shell's signal encodings, and an unmapped code simply
 * does not appear.
 */
const EXIT_CODES = [...Array(21).keys(), 124, 125, 126, 127, 128, 130, 137, 143];

/**
 * Builds one report per installed plugin, id-sorted.
 *
 * Never rejects: a plugin that throws on load or on any accessor becomes a
 * `broken` row. One bad plugin must not cost the node its whole inventory.
 * @param dataDir - the agent's data dir
 */
export async function buildPluginReports(dataDir: string): Promise<PluginReportWire[]> {
  const runtime = createInProcessRuntime();
  const reports: PluginReportWire[] = [];

  for (const installed of await listInstalled(dataDir)) {
    if (installed.broken) {
      reports.push({
        id: installed.id,
        name: installed.manifest.name || installed.id,
        type: installed.manifest.type,
        version: installed.version,
        description: installed.manifest.description,
        capabilities: [],
        broken: installed.broken,
      });
      continue;
    }

    const loaded = await runtime.load(join(pluginsDir(dataDir), installed.id));
    if ("error" in loaded) {
      reports.push({
        id: installed.id,
        name: installed.manifest.name,
        type: installed.manifest.type,
        version: installed.version,
        ...(installed.manifest.icon ? { icon: installed.manifest.icon } : {}),
        description: installed.manifest.description,
        capabilities: [],
        broken: loaded.error,
        // A broken plugin with a newer copy on disk is the case an upgrade
        // usually exists to fix. Reporting the failure without this leaves the
        // page showing an error that a restart would clear, and no way to know
        // that.
        ...(loaded.stale ? { restartRequired: true } : {}),
      });
      continue;
    }

    const { manifest, plugin } = loaded;
    try {
      // A network plugin has none of the launch-shaped members below, and
      // asking it for them would report empty arrays as if it had answered.
      // The manifest type is what decides, here as everywhere: the loader has
      // already proved the object matches it.
      const harness = isHarnessType(manifest.type) ? (plugin as SubshellPlugin) : null;
      const exitStatuses: Record<string, string> = {};
      for (const code of EXIT_CODES) {
        const label = harness?.exitStatus?.(code);
        if (label) exitStatuses[String(code)] = label;
      }
      reports.push({
        id: manifest.id,
        name: manifest.name,
        type: manifest.type,
        version: installed.version,
        ...(manifest.icon ? { icon: manifest.icon } : {}),
        description: manifest.description,
        capabilities: plugin.capabilities(),
        ...(harness
          ? {
              presetSettings: harness.presetSettings?.() ?? [],
              suggestedEnv: harness.suggestedEnv?.() ?? [],
              suggestedFlags: harness.suggestedFlags?.() ?? [],
              // The launch spec is the SERVER's to resolve, so the setup text
              // here is rendered against a placeholder the server substitutes.
              // Plugins that describe manual steps embed the command, which is
              // why this is reported at all rather than recomputed on the
              // control plane.
              mcpSetup: harness.mcpSetup?.({ command: "subshell", args: ["mcp"] }),
            }
          : {}),
        ...(Object.keys(exitStatuses).length > 0 ? { exitStatuses } : {}),
        // The split matters. `id`, `name`, `type`, `version`, `icon` and
        // `description` came from the manifest, so they describe the copy on
        // DISK. Everything else on this object was answered by the loaded
        // plugin, so on a stale load those are the OLD build's capabilities,
        // settings schemas and MCP steps being reported under the new
        // version's number.
        ...(loaded.stale ? { restartRequired: true } : {}),
      });
    } catch (err) {
      reports.push({
        id: manifest.id,
        name: manifest.name,
        type: manifest.type,
        version: installed.version,
        description: manifest.description,
        capabilities: [],
        broken: `the plugin threw while describing itself: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  return reports;
}
