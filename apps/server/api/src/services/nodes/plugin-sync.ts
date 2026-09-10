import { builtInIds, parsePackageSpec } from "@internal/pane-runtime";
import type { PluginReportWire } from "@internal/subshell-protocol";
import { HarnessStateError } from "@/api/harness-utils.js";
import { SUBSHELL_PLUGIN_REGISTRY_URL } from "@/constants.js";
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
 *
 * **Phase 3 added the `spec` parameter to install, and it means one thing on
 * both transports: fetch that package instead of the embedded copy.** The
 * server neither resolves nor rewrites it — the same string reaches the
 * node's parser or this host's `installPlugin`.
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

/** The message for a thrown value, which is not always an Error. */
function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Installs a plugin on one node.
 *
 * **A present `spec` is validated before either door opens** (phase 3): a
 * malformed npm spec is bad input — a 400 naming it, the same shape as the
 * spec-less bad-id refusal — and it must never spend a signed command or
 * reach a fetch. This validates SHAPE only; whether the package exists,
 * matches its announced digest, or loads is the registry's or the node's
 * answer, and refusals come back through the 409 paths below.
 *
 * When a spec is absent the command is the v1 shape: `{ type, id }` with no
 * `spec` key at all. The agent parses exactly what it is given, so this layer
 * forwards the string verbatim — normalizing or re-spelling a spec here would
 * put a second parser between what a human typed and what a node installs.
 * @param registryUrl - a test seam (see `installLocalPlugin`); production
 * resolves the configured `SUBSHELL_PLUGIN_REGISTRY_URL`
 * @throws 400 for a malformed spec, or a spec-less id this build cannot
 * install on the control-plane host; 409 when an agent is offline or refuses,
 * or when the local install itself fails (the target declined the change,
 * whichever target it was)
 */
export async function installNodePlugin(
  node: NodeTable,
  pluginId: string,
  spec?: string,
  registryUrl: string = SUBSHELL_PLUGIN_REGISTRY_URL,
): Promise<void> {
  if (spec !== undefined) {
    try {
      parsePackageSpec(spec);
    } catch (err) {
      throw new HarnessStateError(describe(err), 400);
    }
  }
  if (isLocal(node)) {
    if (spec === undefined) {
      // Checked here rather than left to `installPlugin`, which throws a bare
      // Error the global handler maps to 500. An id this build cannot install
      // is bad input, and the setup route answers the same way for the same
      // value. With a spec there is no such pre-check: the spec IS the
      // request, and the registry's answer decides.
      if (!(await builtInIds()).includes(pluginId)) {
        throw new HarnessStateError(`"${pluginId}" is not a plugin this build carries`, 400);
      }
    }
    try {
      await installLocalPlugin(pluginId, spec, registryUrl);
    } catch (err) {
      if (err instanceof HarnessStateError) throw err;
      // Integrity, a claim collision, a failed load-check: the pane-runtime
      // message says which. An AGENT refusal of the same install reaches the
      // caller as 409 through `send`, and this is the same event one process
      // closer, so it must not reach it as a 500 dressed as a server fault.
      throw new HarnessStateError(describe(err), 409);
    }
    return;
  }
  const result = await send(
    node,
    spec === undefined ? { type: "plugin_install", id: pluginId } : { type: "plugin_install", id: pluginId, spec },
  );
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
