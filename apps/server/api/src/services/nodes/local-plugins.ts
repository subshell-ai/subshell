import {
  buildPluginReports,
  installEmbedded,
  pluginsDir,
  prepareInstalledPlugins,
  setPluginLog,
  uninstallPlugin,
} from "@internal/pane-runtime";
import type { PluginReportWire } from "@internal/subshell-protocol";
import { SUBSHELL_SERVER_DATA_DIR } from "@/constants.js";
import { db } from "@/db/index.js";
import { NodesRepository } from "@/db/repositories/nodes.repository.js";
import { LOCAL_NODE_ID } from "@/db/types/nodes.db-types.js";
import { ensureDefaultProfilesForHarness } from "@/services/default-profiles.js";
import { getLogger } from "@/utils/logger.js";

/**
 * The control-plane host's own plugins, kept exactly like any other node's.
 *
 * `local` used to be the exception: an enable table on this side, a plugins
 * directory on every other. That is what made `effectiveHarnessStates` two
 * functions sharing a name, and what made "this host offers X" mean two
 * different things depending on which host. It is a directory here too now,
 * read and written by the same `@internal/pane-runtime` code an agent runs
 * (spec 2026-09-09 §11).
 *
 * **What stays different is the transport, not the model.** An agent is sent a
 * signed command over a socket; `local` runs in THIS process, so it is a
 * function call. There is nothing to sign (this server asking itself) and
 * nothing to be offline. Every other property is shared, which is the point.
 */

/** Absolute path of this host's plugins directory. */
export function localPluginsDir(): string {
  return pluginsDir(SUBSHELL_SERVER_DATA_DIR);
}

/** This host's plugin reports, in the shape an agent sends. */
export async function localPluginReports(): Promise<PluginReportWire[]> {
  return await buildPluginReports(SUBSHELL_SERVER_DATA_DIR);
}

/**
 * Writes this host's report into its own node row.
 *
 * The same column an agent's report lands in, so one reader serves both and
 * the view has no branch to get wrong.
 */
export async function recordLocalReport(): Promise<void> {
  await new NodesRepository(db).recordPluginReport(LOCAL_NODE_ID, await localPluginReports());
}

/**
 * Installs a plugin on this host, refreshes the mirror, and seeds profiles.
 *
 * The profile seeding is inherited from the enable toggle this replaced, and
 * it is not decoration: a user who has never made a profile for a harness
 * cannot launch it, so a freshly installed plugin would appear in the picker
 * and then have nothing to pick. Best-effort, exactly as it was there — the
 * install has already happened, and an optional insert failing must not turn
 * it into an error.
 */
export async function installLocalPlugin(pluginId: string): Promise<void> {
  await installEmbedded(SUBSHELL_SERVER_DATA_DIR, pluginId);
  await recordLocalReport();
  await ensureDefaultProfilesForHarness(db, pluginId).catch((err: unknown) => {
    getLogger().withError(err).warn(`default-profile seeding failed after installing "${pluginId}"`);
  });
}

/**
 * Removes a plugin from this host and refreshes the mirror.
 * @returns true when something was removed, false when it was already absent
 */
export async function uninstallLocalPlugin(pluginId: string): Promise<boolean> {
  const removed = await uninstallPlugin(SUBSHELL_SERVER_DATA_DIR, pluginId);
  await recordLocalReport();
  return removed;
}

/**
 * Boot: bring this host's plugins directory to a usable state and mirror it.
 *
 * The sequence itself is `prepareInstalledPlugins`, shared with the agent
 * daemon so there is one definition of it rather than two orders behind one
 * "same as the daemon" claim. Each of its steps is guarded there.
 *
 * The MIRROR is written unconditionally afterwards, and that is the part that
 * must not be skipped: `nodes.plugins_json` is what the launch gate, the
 * profile listing and the node page all read, so leaving it unwritten makes a
 * host with plugins on disk report that it offers nothing.
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
  await recordLocalReport();
  getLogger().info(`plugins: ${localPluginsDir()}`);
}
