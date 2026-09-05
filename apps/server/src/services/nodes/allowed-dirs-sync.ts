import { LOCAL_NODE_ID } from "@/db/types/nodes.db-types.js";
import { getRequestlessContext } from "@/lib/context.js";
import { sendCommand } from "@/services/nodes/node-rpc.js";
import { logger } from "@/utils/logger.js";

/**
 * Pushing a node's directory allowlist down to the node (spec 2026-09-05).
 *
 * The control plane owns the list; the NODE enforces it against a copy it
 * persists. Keeping those two in agreement is this module's whole job, and it
 * happens at exactly two moments:
 *
 * 1. **On edit** — the owner changed the rules; tell the node now.
 * 2. **After `ready`** — the node just (re)connected; tell it the current
 *    rules. This is the reconciliation, and it is what makes an edit made
 *    while the node was OFFLINE eventually take effect. Without it a node
 *    could run indefinitely on rules its owner had already replaced.
 *
 * Both are best-effort. A push that fails is not an error the operator must
 * act on, because the control plane enforces the same rules itself at create
 * time — the node copy is defence in depth against a compromised control
 * plane, not the only gate. The window it leaves is narrow and closes on the
 * node's next reconnect; it is recorded in `docs/security.md`.
 *
 * `local` is skipped: the control-plane host has no node socket to push over,
 * and its launches are gated server-side in the same code path as every other
 * node's.
 */

/**
 * Sends the node its current rules.
 *
 * @param nodeId - the node to sync; `local` is a no-op
 * @param dirs - the rules to push; omit to read the stored set (the `ready`
 *   path, which has no list in hand)
 */
export async function pushAllowedDirs(nodeId: string, dirs?: readonly string[]): Promise<void> {
  if (nodeId === LOCAL_NODE_ID) return;
  const payload = dirs ?? (await getRequestlessContext().repos.nodeAllowedDirs.listForNode(nodeId));
  await sendCommand(nodeId, { type: "set_allowed_dirs", dirs: [...payload] });
}

/**
 * {@link pushAllowedDirs}, fire-and-forget with the failure logged.
 *
 * The call sites are a route handler that has already committed its write and
 * a WS event handler that must not block — neither can meaningfully await or
 * retry, and an unhandled rejection from `sendCommand` (which rejects on
 * offline/timeout, both routine) would be noise at best.
 */
export function pushAllowedDirsBestEffort(nodeId: string, dirs?: readonly string[]): void {
  void pushAllowedDirs(nodeId, dirs).catch((err: unknown) => {
    logger
      .withError(err)
      .debug(`allowed-dirs push failed for node ${nodeId}; the node keeps its last set until it reconnects`);
  });
}
