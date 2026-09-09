import { join } from "node:path";
import { createInProcessRuntime } from "@internal/pane-runtime";
import type { PluginReportWire } from "@internal/subshell-protocol";
import { listInstalled, pluginsDir } from "./plugins-dir.js";

/**
 * Describing this node's plugins to the control plane.
 *
 * The server holds no plugin code for a machine it does not run on, so
 * everything it needs about a plugin travels as DATA: enough to list it,
 * render its profile editor, label its exit codes and explain its MCP setup.
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
      });
      continue;
    }

    const { manifest, plugin } = loaded;
    try {
      const exitStatuses: Record<string, string> = {};
      for (const code of EXIT_CODES) {
        const label = plugin.exitStatus?.(code);
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
        profileSettings: plugin.profileSettings?.() ?? [],
        suggestedEnv: plugin.suggestedEnv?.() ?? [],
        suggestedFlags: plugin.suggestedFlags?.() ?? [],
        // The launch spec is the SERVER's to resolve, so the setup text here
        // is rendered against a placeholder the server substitutes. Plugins
        // that describe manual steps embed the command, which is why this is
        // reported at all rather than recomputed on the control plane.
        mcpSetup: plugin.mcpSetup?.({ command: "subshell", args: ["mcp"] }),
        ...(Object.keys(exitStatuses).length > 0 ? { exitStatuses } : {}),
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
