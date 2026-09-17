import {
  buildPluginReports,
  installPlugin,
  isHarnessType,
  pluginsDir,
  prepareInstalledPlugins,
  refreshInstalledPlugins,
  setPluginLog,
  uninstallPlugin,
} from "@internal/pane-runtime";
import type { PluginReportWire } from "@internal/subshell-protocol";
import { SUBSHELL_PLUGIN_REGISTRY_URL, SUBSHELL_SERVER_DATA_DIR } from "@/constants.js";
import { db } from "@/db/index.js";
import { PluginStateRepository } from "@/db/repositories/plugin-state.repository.js";
import { liftNetworkPluginTombstone } from "@/services/network/origins.js";
import { getLogger } from "@/utils/logger.js";

/**
 * The instance's plugins — `<SUBSHELL_SERVER_DATA_DIR>/plugins/` is the ONE
 * plugin store (spec 2026-09-10 §6).
 *
 * Every harness plugin the instance has lives here, installed and loaded by
 * THIS process, and it is what every node runs: the node holds no plugin code
 * any more, so "is X offered" has exactly one answer for the whole instance.
 * The former per-node stores (an agent's own directory, and `local`'s mirror
 * in its node row) are gone — the transport difference between this host and
 * an agent is down to WHERE the binary is looked up, not who owns the plugin.
 *
 * The machinery is `@internal/pane-runtime`'s — the same installer, registry
 * client, integrity check and report builder an agent used to run, so the
 * phase-3 code survived the move as written and only its location changed.
 */

/** Absolute path of the instance's plugins directory. */
export function localPluginsDir(): string {
  return pluginsDir(SUBSHELL_SERVER_DATA_DIR);
}

/**
 * The instance's installed plugins, in the report shape (id-sorted, one row
 * per plugin on disk, `broken` carried for any that will not load).
 *
 * Reads the DISK, which is the record itself now — there is no mirror in a
 * node row to be a second opinion. The load per call is module-cached by the
 * runtime, so after the first read this is directory stats plus accessor
 * calls, not imports.
 */
export async function localPluginReports(): Promise<PluginReportWire[]> {
  return await buildPluginReports(SUBSHELL_SERVER_DATA_DIR);
}

/**
 * What the launch gate and the node views iterate: the installed HARNESS set
 * minus anything an operator has explicitly disabled (spec §6.1).
 *
 * An absent `plugin_state` row means enabled, so installing writes nothing
 * and a plugin this table never heard of is offered. Broken plugins pass this
 * filter — they are installed, and the page has to be able to say WHY they
 * are not usable; the usability predicates refuse them.
 *
 * **Network plugins are excluded here, once, rather than at each of the five
 * call sites.** Every caller is a harness surface — the launch gate, the
 * preset catalog, a node's harness list, the detection specs shipped to
 * agents — and a `network` plugin reaching any of them would put "Tailscale"
 * in a launch picker and ship a tailnet detection rule to every enrolled
 * machine. Structural, like `allHarnesses()`: the safety cannot rest on five
 * callers each remembering to filter. Network plugins are read by the
 * networking routes, from the registry, by their own accessor.
 */
export async function enabledHarnessPlugins(): Promise<PluginReportWire[]> {
  const state = await new PluginStateRepository(db).stateByPluginId();
  const reports = await localPluginReports();
  return reports.filter((r) => state.get(r.id) !== false && isHarnessType(r.type));
}

/**
 * The same disabled-filter over EVERY type, for the networking routes.
 *
 * Separate from {@link enabledHarnessPlugins} rather than a parameter on it,
 * so a caller that wants harnesses cannot get networks by passing the wrong
 * argument.
 */
export async function enabledNetworkPlugins(): Promise<PluginReportWire[]> {
  const state = await new PluginStateRepository(db).stateByPluginId();
  const reports = await localPluginReports();
  return reports.filter((r) => state.get(r.id) !== false && r.type === "network");
}

/**
 * Re-points the pane-runtime registry overlay at this store.
 *
 * This process is the plugin host now, so resolving an installed plugin
 * (`getHarness`, `detectSpecs`, preset validation, argv building) has to
 * consult the bytes in `<SUBSHELL_SERVER_DATA_DIR>/plugins/`, not just the
 * compiled-in built-ins. `refreshInstalledPlugins` is the one registration
 * path, and every write to this store runs it, so a just-installed plugin is
 * launchable the moment the install returns, and an uninstall is unresolvable
 * the moment it completes.
 *
 * Contained rather than fatal: the load itself cannot throw (per-plugin
 * failures land in the broken set), so anything escaping here is an
 * unexpected fault in a refresh that already has the disk as its source of
 * truth. A failed refresh must not turn a completed install into an error
 * response, nor stop a boot; the next one repairs it.
 */
async function syncPluginRegistry(): Promise<void> {
  try {
    const { loaded, broken } = await refreshInstalledPlugins(SUBSHELL_SERVER_DATA_DIR);
    for (const b of broken) {
      getLogger().warn(`plugin "${b.id}" is installed but will not load in this process: ${b.error}`);
    }
    if (loaded.length > 0) getLogger().info(`plugins: resolved ${loaded.join(", ")} from ${localPluginsDir()}`);
  } catch (err) {
    getLogger()
      .withError(err)
      .warn("could not refresh the installed-plugin registry; launches resolve built-ins only until the next refresh");
  }
}

/**
 * Installs a plugin into the instance store.
 *
 * No rows are written for it anywhere else: presets are user-made
 * customisation now (spec 2026-09-13), and a fresh install is launchable the
 * moment its overlay lands — a presetless launch is the whole point.
 *
 * Phase 3's registry door is kept as written: with a `spec` the bytes come
 * from an npm registry, verified against the digest THAT registry announced,
 * and every §2.5 rule (embedded-first, no silent fallback, load-check before
 * swap) lives inside `installPlugin`. Without a spec it is the embedded copy.
 * Throws the package's own errors; the caller decides what status a refusal
 * means.
 * @param registryUrl - a test seam only; production resolves the configured
 * `SUBSHELL_PLUGIN_REGISTRY_URL` (the instance's own; the agent has no
 * registry concept since the inversion)
 */
export async function installLocalPlugin(
  pluginId: string,
  spec?: string,
  registryUrl: string = SUBSHELL_PLUGIN_REGISTRY_URL,
): Promise<void> {
  await installPlugin(SUBSHELL_SERVER_DATA_DIR, { id: pluginId, spec, registryUrl });
  // A successful install lifts any uninstall tombstone (`origins.ts`): a
  // reinstalled network plugin re-earns trust through a fresh observation,
  // which is the tombstone's whole contract. Harmless for harness ids — they
  // are never tombstoned. Lift BEFORE the overlay refresh so an observation
  // that resolves the just-installed plugin is already unblocked.
  liftNetworkPluginTombstone(pluginId);
  // A caller that gets a 200 back must be able to launch immediately, and
  // that is the dialog's whole promise — the overlay is what makes it true.
  await syncPluginRegistry();
}

/**
 * Removes a plugin from the instance store (bytes only — presets are a
 * route-level decision, see `plugins.route.ts`).
 * @returns true when something was removed, false when it was already absent
 */
export async function uninstallLocalPlugin(pluginId: string): Promise<boolean> {
  const removed = await uninstallPlugin(SUBSHELL_SERVER_DATA_DIR, pluginId);
  if (removed) await new PluginStateRepository(db).clear(pluginId);
  // Refresh even on "already absent": the overlay tracks the DIRECTORY, and
  // a hand-removal since the last refresh is exactly what this clears.
  await syncPluginRegistry();
  return removed;
}

/**
 * Boot: bring the instance's plugins directory to a usable state.
 *
 * The sequence itself is `prepareInstalledPlugins` in pane-runtime, and this
 * is its ONLY production caller: since the inversion no agent prepares or
 * seeds anything, so exactly one boot runs this order. Each of its steps is
 * guarded there.
 */
export async function prepareLocalPlugins(): Promise<void> {
  // Route the package's output through this app's logger before it says
  // anything: `apps/server/api/AGENTS.md` is explicit that everything here
  // goes through LogLayer, and these functions run inside this process.
  setPluginLog({
    info: (m) => getLogger().info(m),
    warn: (m, err) => (err === undefined ? getLogger().warn(m) : getLogger().withError(err).warn(m)),
  });
  await prepareInstalledPlugins(SUBSHELL_SERVER_DATA_DIR);
  // AFTER the prepare pass: what it recovered, seeded or refreshed is what
  // the registry must resolve, and seeding built-ins is precisely the case
  // the shadow rule keeps silent about (the compiled copies answer).
  await syncPluginRegistry();
  getLogger().info(`plugins: ${localPluginsDir()}`);
}
