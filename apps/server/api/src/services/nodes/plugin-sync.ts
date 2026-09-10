import { builtInIds } from "@internal/pane-runtime";
import type { PluginReportWire } from "@internal/subshell-protocol";
import { HarnessStateError } from "@/api/harness-utils.js";
import { db } from "@/db/index.js";
import { NodesRepository } from "@/db/repositories/nodes.repository.js";
import { LOCAL_NODE_ID, type NodeTable } from "@/db/types/nodes.db-types.js";
import { installLocalPlugin, uninstallLocalPlugin } from "@/services/nodes/local-plugins.js";
import { NodeRpcError, sendCommand } from "@/services/nodes/node-rpc.js";

/**
 * Changing a node's plugin set, which the NODE owns.
 *
 * The server does not decide what a node offers; it asks, and mirrors the
 * answer. So each function here sends a signed command, takes the node's own
 * report from the result, and persists that.
 *
 * **Offline is refused, not queued**, and that is the deliberate opposite of
 * `allowed-dirs-sync.ts`. There the control plane OWNS a security control, so
 * a node running stale rules must be corrected and an edit made while it was
 * offline has to be replayed on reconnect. Here the node owns the setting:
 * there is no desired state to reconcile, and a queue would let the UI show a
 * plugin the node is not actually running.
 *
 * **`local` takes the same two verbs, by a different transport.** It runs in
 * THIS process, so there is no socket, nothing to sign (this server would be
 * asking itself) and nothing to be offline: the command is a function call.
 * Everything else is shared, which is the point of it not being an exception
 * any more (spec 2026-09-09 §11).
 */

/**
 * Sends one plugin command, turning transport failures into statuses a caller
 * can act on.
 *
 * A `NodeRpcError` would otherwise surface as a 500, which reads as "the
 * server broke" for the entirely ordinary case of a node being switched off.
 * 409 says the request was fine and the world was not ready for it.
 */
async function send(node: NodeTable, cmd: Parameters<typeof sendCommand>[1]): Promise<unknown> {
  try {
    return await sendCommand(node.id, cmd);
  } catch (err) {
    if (err instanceof NodeRpcError) {
      throw new HarnessStateError(
        err.code === "offline"
          ? `"${node.name}" is offline. Plugin changes are sent to a running node rather than queued, so start it and try again.`
          : `"${node.name}" did not complete the change: ${err.message}`,
        409,
      );
    }
    throw err;
  }
}

/** The shape a node answers a plugin command with. */
interface PluginCommandResult {
  plugins?: PluginReportWire[];
}

/** Persists the node's own report as the mirror of its declaration. */
async function mirror(nodeId: string, result: unknown): Promise<void> {
  const plugins = (result as PluginCommandResult | null)?.plugins;
  if (!Array.isArray(plugins)) return;
  await new NodesRepository(db).recordPluginReport(nodeId, plugins);
}

/**
 * The shape a plugin id may take, mirroring `assertSafeId` in
 * `@internal/pane-runtime`: ids become directory names, so they are one path
 * segment and nothing else. Duplicated as a REFUSAL rather than imported as a
 * validator because the point here is the status code, not the check.
 */
const SAFE_PLUGIN_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** True for the control-plane host, whose plugins this process owns directly. */
function isLocal(node: NodeTable): boolean {
  return node.id === LOCAL_NODE_ID || node.kind === "local";
}

/**
 * Installs a plugin on one node.
 * @throws when the node is offline, or when it refuses the install
 */
export async function installNodePlugin(node: NodeTable, pluginId: string): Promise<void> {
  if (isLocal(node)) {
    // Checked here rather than left to `installEmbedded`, which throws a bare
    // Error the global handler maps to 500. An id this build cannot install is
    // bad input, and the setup route answers the same way for the same value.
    if (!(await builtInIds()).includes(pluginId)) {
      throw new HarnessStateError(`"${pluginId}" is not a plugin this build carries`, 400);
    }
    await installLocalPlugin(pluginId);
    return;
  }
  const result = await send(node, { type: "plugin_install", id: pluginId });
  await mirror(node.id, result);
}

/**
 * Removes a plugin from one node.
 *
 * Succeeds when it was already absent, because the node answers that way: the
 * caller asked for a state and that state holds.
 * @throws when the node is offline
 */
export async function uninstallNodePlugin(node: NodeTable, pluginId: string): Promise<void> {
  if (isLocal(node)) {
    // Same reason: `uninstallPlugin` refuses an unsafe id with a bare Error,
    // and a malformed id in the path is a 400 rather than a server fault.
    if (!SAFE_PLUGIN_ID.test(pluginId)) {
      throw new HarnessStateError(`"${pluginId}" is not a valid plugin id`, 400);
    }
    await uninstallLocalPlugin(pluginId);
    return;
  }
  const result = await send(node, { type: "plugin_uninstall", id: pluginId });
  await mirror(node.id, result);
}
