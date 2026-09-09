import type { PluginReportWire } from "@internal/subshell-protocol";
import { HarnessStateError } from "@/api/harness-utils.js";
import { db } from "@/db/index.js";
import { NodesRepository } from "@/db/repositories/nodes.repository.js";
import { LOCAL_NODE_ID, type NodeTable } from "@/db/types/nodes.db-types.js";
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
 * `local` has no socket. Phase 2 leaves it unsupported rather than pretending:
 * the control-plane host's own plugin set is the seeding step's business until
 * a later phase gives it the same treatment.
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

/** Refuses `local`, which has no socket to send a command over. */
function assertAgent(node: NodeTable): void {
  if (node.id === LOCAL_NODE_ID || node.kind === "local") {
    throw new HarnessStateError("The control-plane host's plugins are not managed from here", 400);
  }
}

/**
 * Installs a plugin on one node.
 * @throws when the node is offline, or when it refuses the install
 */
export async function installNodePlugin(node: NodeTable, pluginId: string): Promise<void> {
  assertAgent(node);
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
  assertAgent(node);
  const result = await send(node, { type: "plugin_uninstall", id: pluginId });
  await mirror(node.id, result);
}
