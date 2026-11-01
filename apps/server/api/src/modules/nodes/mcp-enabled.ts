import type { NodeMcpEnabledWire } from "@internal/subshell-protocol";
import { getRequestlessContext } from "@/app/context.js";
import { LOCAL_NODE_ID, type NodeTable } from "@/db/types/nodes.db-types.js";
import { audit } from "@/modules/audit.js";
import { sendCommand } from "@/modules/nodes/node-rpc.js";
import { logger } from "@/shared/logger.js";

/**
 * The per-node MCP-use switch, written in exactly one place: the posture
 * `ssh-enabled.ts` and `preview-enabled.ts` established. One change site, the
 * plane as sole author, the machine holding a mirror it never votes on, and a
 * reconcile that ends every disagreement by pushing the row.
 *
 * **It differs from both of them in one place, and that place is the whole
 * point of reading this file before copying one.** This flag defaults to
 * ALLOWED. SSH and previews gate features that are opt-in, so a machine that
 * has never been pushed a value refuses, and silence is safely read as
 * refusal. MCP wiring predates its own switch, so an upgrade must leave every
 * machine wiring exactly what it wired before: an absent mirror reads allowed,
 * and only an explicit `on: false` refuses. Read this the other way round and
 * the first boot after the migration strips cross-agent comms from a fleet
 * that never opted out.
 *
 * The row is still the record. The mirror exists so a machine can refuse what
 * a stale or buggy plane tries to wire anyway, which is the difference between
 * "the plane skips it" and "it isn't available on this node".
 */

/**
 * Read the switch the way the launch gate reads it. An absent row or an
 * unwritten column reads as ALLOWED, which is the whole fleet's status quo;
 * only an explicit 0 refuses.
 */
export async function getNodeMcpEnabled(nodeId: string): Promise<boolean> {
  const row = await getRequestlessContext().repos.nodes.findById(nodeId);
  return (row?.mcpEnabled ?? 1) !== 0;
}

/**
 * Flip one node's MCP switch: row, audit, and the best-effort push, all in
 * this one function, so no caller can perform half the act. The stamp is
 * minted HERE (one change site mints once); the route supplies the acting
 * human, never a time.
 *
 * Nothing is torn down on the way through. A pane whose MCP child is already
 * running keeps it: the switch reaches launches and restarts, and severing a
 * tool set from under a mid-turn agent is a worse surprise than the delay.
 */
export async function setNodeMcpEnabled(nodeId: string, actorUserId: string, on: boolean): Promise<void> {
  const changedAt = new Date().toISOString();
  const { repos } = getRequestlessContext();
  const row = await repos.nodes.setMcpEnabled(nodeId, { on, changedAt });
  await audit({
    actorUserId,
    action: "node.mcp_enabled.update",
    targetType: "node",
    targetId: nodeId,
    metadataJson: JSON.stringify({ on }),
  });
  // The row is written and audited BEFORE the push, so a node that answers the
  // command cannot be looking at a mirror the record has not caught up to, and
  // a push that fails (the node is offline) costs nothing: the value re-lands
  // at the node's next `ready` through {@link reconcileMcpEnabled}.
  if (row) pushSetMcpEnabledBestEffort(nodeId, { on: row.mcpEnabled !== 0, changedAt });
}

/** The node-row fields {@link decideMcpEnabled} reads. Nothing else is relevant. */
type McpRow = Pick<NodeTable, "mcpEnabled" | "mcpEnabledAt">;

/** What reconciliation decided about one node's two copies of the flag. */
export type McpDecision =
  /** The two ends agree, or there is nothing coherent to send. */
  | "noop"
  /** Relay the row's value with the row's own stamp, byte-identical. */
  | "push-row"
  /**
   * The row has never been written and the machine is refusing anyway. Push
   * the row's allowance with a stamp minted now: a mirror that came apart or
   * was hand-edited must not strand a machine on the side nobody chose, and
   * there is no existing stamp to relay.
   */
  | "push-repair";

/**
 * Decide what to do when the plane's row and the node's report disagree.
 * PURE: it reads two values and answers; the caller performs.
 *
 * | node reports | plane row | → |
 * |---|---|---|
 * | nothing | allowed (default or written) | `noop`: silence means ALLOW here, and that matches the row |
 * | the row's value | any value | `noop`: agreement, the steady state; a push would echo forever |
 * | nothing | refused | `push-row`: the machine lost its file while the owner said no; hand it back |
 * | the other value | with a stamp | `push-row`: the row is the record; the machine is told, never asked |
 * | the other value | never written | `push-repair`: nothing exists to relay, and unlike SSH this disagreement is NOT inert, because the mirror itself strips wiring. The row's allowance wins with a fresh stamp |
 *
 * Stamps are never compared, and nothing ever adopts: an old, corrupt, or
 * hand-edited mirror does not move the row. That direction is the rule.
 *
 * @param row - the plane's node row (the two MCP fields only)
 * @param reported - what the machine says its mirror answers, or undefined
 *   when it reported none (no file, or a malformed `ready` field the lenient
 *   parser dropped)
 */
export function decideMcpEnabled(row: McpRow, reported: NodeMcpEnabledWire | undefined): McpDecision {
  const rowOn = (row.mcpEnabled ?? 1) !== 0;
  // Silence reads ALLOWED. This is the inverted line: ssh and preview read it
  // as refusal because those features are opt-in.
  if ((reported?.on ?? true) === rowOn) return "noop";
  if (row.mcpEnabledAt) return "push-row";
  return "push-repair";
}

/**
 * Send one node the MCP state the plane holds, so both copies end
 * byte-identical.
 *
 * `local` is skipped: the control-plane host has no agent socket and no mirror
 * file, so its answer to the gate is the DB row itself.
 */
export async function pushSetMcpEnabled(nodeId: string, state: NodeMcpEnabledWire): Promise<void> {
  if (nodeId === LOCAL_NODE_ID) return;
  await sendCommand(nodeId, { type: "set_mcp_enabled", on: state.on, changedAt: state.changedAt });
}

/**
 * {@link pushSetMcpEnabled}, fire-and-forget with the failure logged. An
 * offline node simply misses it: the plane already refuses to compose wiring
 * for a row that says no, and the machine re-learns the value on its next
 * `ready` through {@link reconcileMcpEnabled}.
 */
export function pushSetMcpEnabledBestEffort(nodeId: string, state: NodeMcpEnabledWire): void {
  void pushSetMcpEnabled(nodeId, state).catch((err: unknown) => {
    logger
      .withError(err)
      .warn(`mcp-enabled push failed for node ${nodeId}; its mirror stays stale until it reconnects`);
  });
}

/**
 * Reconcile one node's report against the plane's row: the body of the
 * `onMcpEnabled` lifecycle hook, fed by `ready.mcpEnabled` and by the
 * `mcp_enabled` event a machine sends when its mirror moved underneath it.
 *
 * One read and at most one fire-and-forget push. Nothing to stop (an MCP flip
 * severs no live pane), nothing to write, nothing to await. A row that
 * disagrees with the machine pushes; never the other direction.
 */
export async function reconcileMcpEnabled(nodeId: string, reported: NodeMcpEnabledWire | undefined): Promise<void> {
  const { repos } = getRequestlessContext();
  const row = await repos.nodes.findById(nodeId);
  if (!row) return;
  const on = (row.mcpEnabled ?? 1) !== 0;
  const decision = decideMcpEnabled(row, reported);
  if (decision === "noop") return;
  if (decision === "push-repair") {
    pushSetMcpEnabledBestEffort(nodeId, { on, changedAt: new Date().toISOString() });
    return;
  }
  const stamp = row.mcpEnabledAt;
  if (stamp === null) return; // `decideMcpEnabled` only answers push-row when a stamp exists.
  pushSetMcpEnabledBestEffort(nodeId, { on, changedAt: stamp });
}
