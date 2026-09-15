import type { NodeMaintenanceWire } from "@internal/subshell-protocol";
import { PresetsRepository } from "@/db/repositories/presets.repository.js";
import { SubshellsRepository } from "@/db/repositories/subshells.repository.js";
import type { MaintenanceSource, NodeTable } from "@/db/types/nodes.db-types.js";
import { LOCAL_NODE_ID } from "@/db/types/nodes.db-types.js";
import { getRequestlessContext } from "@/lib/context.js";
import { audit } from "@/services/audit.js";
import { sendCommand } from "@/services/nodes/node-rpc.js";
import { SubshellManagerService } from "@/services/subshell-manager.service.js";
import { logger } from "@/utils/logger.js";

/**
 * Node maintenance, performed in exactly one place (spec 2026-09-14 §5.2).
 *
 * The act has four steps that must not come apart — write the flag, stop what
 * is running, tell the machine, record it — and it is reachable from two
 * directions: an owner in a browser (`PUT /api/nodes/:id/maintenance`) and the
 * machine itself (`subshell maintenance on`, arriving as a `maintenance` event
 * or as `ready.maintenance`). Two implementations of a four-step act is two
 * implementations that drift, and the half that drifts is whichever one nobody
 * exercised — so both callers land here.
 *
 * **The state is ONE flag with two copies**, and `changedAt` is the whole
 * reconciliation protocol: either side may be written while the other is
 * unreachable, so on reconnect the newer stamp wins and ties go to the plane,
 * which is the record. Clock skew is accepted and bounded — an adopted stamp
 * is clamped to `now`, and the push that follows every reconcile rewrites the
 * machine's file with the clamped value, so a future-dated node clock can
 * outrank the plane once per reconnect and never permanently.
 */

/** What reconciliation decided about one node's two copies of the flag. */
export type MaintenanceDecision = "adopt-node" | "push-plane" | "noop";

/** The node-row fields {@link decideMaintenance} reads — nothing else is relevant. */
type MaintenanceRow = Pick<NodeTable, "maintenance" | "maintenanceAt">;

/**
 * Decide what to do when the plane's row and the node's report disagree.
 * PURE — it reads two stamps and answers; the caller performs.
 *
 * The table (spec §5.2), and why each row is what it is:
 *
 * | node reports | plane row | → |
 * |---|---|---|
 * | nothing | never written | `noop` — neither end has an opinion |
 * | nothing | written | `push-plane` — the node has no file; give it ours |
 * | something | never written | `adopt-node` — only one side has an opinion |
 * | newer | older | `adopt-node` |
 * | older | newer | `push-plane` |
 * | equal | equal | `noop` |
 *
 * Equality is a `noop` rather than a push because the plane is the record: two
 * identical stamps are the normal steady state (every reconcile ends with a
 * push, so the two files converge byte-for-byte), and treating it as a
 * disagreement would send a command on every heartbeat forever. A differing
 * `on` under equal stamps is pathological — two writes in the same
 * millisecond — and the next real flip realigns it.
 *
 * An UNPARSEABLE node stamp is `push-plane`, not `adopt-node`: a value that
 * cannot be compared can never be reconciled, so adopting it would freeze the
 * node's copy as permanently unbeatable.
 *
 * @param row - the plane's node row
 * @param reported - what the machine says its own file holds, or undefined
 *   when it reported nothing (no file there, or a malformed `ready` field the
 *   lenient parser dropped)
 */
export function decideMaintenance(row: MaintenanceRow, reported: NodeMaintenanceWire | undefined): MaintenanceDecision {
  const planeAt = row.maintenanceAt ? Date.parse(row.maintenanceAt) : Number.NaN;
  if (!reported) return Number.isNaN(planeAt) ? "noop" : "push-plane";
  const nodeAt = Date.parse(reported.changedAt);
  if (Number.isNaN(nodeAt)) return "push-plane";
  if (Number.isNaN(planeAt)) return "adopt-node";
  if (nodeAt > planeAt) return "adopt-node";
  if (nodeAt < planeAt) return "push-plane";
  return "noop";
}

/**
 * Clamp a stamp the plane is ADOPTING to the present.
 *
 * A machine with a fast clock would otherwise write a stamp no later plane
 * flip could beat, leaving the node permanently authoritative over a flag its
 * owner is trying to change from a browser. Clamping costs nothing when the
 * clocks agree, and the push that follows adoption rewrites the machine's file
 * with the clamped value — so the skew is corrected rather than merely ignored.
 *
 * @param changedAt - the stamp the node reported
 * @param nowIso - the present, as the plane sees it
 */
export function clampAdoptedStamp(changedAt: string, nowIso: string): string {
  const reported = Date.parse(changedAt);
  const now = Date.parse(nowIso);
  if (Number.isNaN(reported) || Number.isNaN(now)) return nowIso;
  return reported > now ? nowIso : changedAt;
}

/**
 * Send one node the maintenance state the plane holds, so both files end
 * byte-identical.
 *
 * `local` is skipped: the control-plane host has no agent socket, no mirror
 * file, and no second gate — its launches are refused by the node row alone.
 *
 * @param nodeId - the node to tell; `local` is a no-op
 * @param state - the STORED value, relayed verbatim; never re-stamped here,
 *   or the relay would outrank the decision it is carrying
 */
export async function pushSetMaintenance(nodeId: string, state: NodeMaintenanceWire): Promise<void> {
  if (nodeId === LOCAL_NODE_ID) return;
  await sendCommand(nodeId, { type: "set_maintenance", on: state.on, changedAt: state.changedAt });
}

/**
 * {@link pushSetMaintenance}, fire-and-forget with the failure logged — the
 * shape `pushAllowedDirsBestEffort` established, for the same reasons.
 *
 * An offline node simply misses it: the flag is already on the plane's row,
 * which is what refuses launches, and the node re-learns the value on its next
 * `ready` through {@link reconcileMaintenance}. There is nothing a caller
 * could usefully await or retry.
 */
export function pushSetMaintenanceBestEffort(nodeId: string, state: NodeMaintenanceWire): void {
  void pushSetMaintenance(nodeId, state).catch((err: unknown) => {
    logger
      .withError(err)
      .warn(`maintenance push failed for node ${nodeId}; its mirror stays stale until it reconnects`);
  });
}

/** A manager built from the requestless graph — `restartInFlight` is module-global, so any instance is safe. */
function managerForMaintenance(): SubshellManagerService {
  const { db } = getRequestlessContext();
  return new SubshellManagerService({
    subshells: new SubshellsRepository(db),
    presets: new PresetsRepository(db),
  });
}

/** The arguments both entry points share. */
interface MaintenanceWrite {
  /** Node whose flag is being written. */
  nodeId: string;
  /** True = the node accepts no new subshells. */
  on: boolean;
  /** ISO 8601 of the write that produced `on` (an adopted value is already clamped). */
  changedAt: string;
  /** Which end decided it. */
  source: MaintenanceSource;
  /** The admin/owner who asked; null when the machine decided (`source: "node"`). */
  actorUserId: string | null;
}

/**
 * Stop what is running, tell the machine, and record it — everything that
 * follows the flag write. Split out so the reconcile path can perform it
 * WITHOUT holding up the socket's frame queue (see
 * {@link reconcileMaintenance}); the route awaits it, because it owes the
 * caller the count.
 */
async function applyMaintenanceEffects(write: MaintenanceWrite): Promise<{ stopped: string[] }> {
  const { repos } = getRequestlessContext();
  const stopped: string[] = [];
  if (write.on) {
    // Read AFTER the flag is written, which is what makes a concurrent flip
    // harmless: the second writer finds nothing left to stop rather than
    // racing this loop over the same rows.
    const rows = await repos.nodes.listRunningForNode(write.nodeId);
    const manager = managerForMaintenance();
    for (const row of rows) {
      // Sequential, not `Promise.all`: each of these is a kill RPC to the
      // same node, and a node that is being taken out of service is the last
      // place to open N concurrent commands on one socket.
      await manager.terminateForMaintenance(row);
      stopped.push(row.id);
    }
  }
  pushSetMaintenanceBestEffort(write.nodeId, { on: write.on, changedAt: write.changedAt });
  await audit({
    actorUserId: write.actorUserId,
    action: "node.maintenance.update",
    targetType: "node",
    targetId: write.nodeId,
    metadataJson: JSON.stringify({
      on: write.on,
      source: write.source,
      stopped,
      changedAt: write.changedAt,
    }),
  });
  return { stopped };
}

/**
 * Put a node into (or out of) maintenance: the whole act, awaited.
 *
 * The flag is written FIRST and everything else follows from the row, which
 * is the ordering that makes this safe to run twice and safe to run
 * concurrently — a second call finds the flag already set and no running rows
 * to stop, so it stops nothing, pushes the same value, and audits an empty
 * `stopped`. It also means the plane refuses launches from the first await
 * onward rather than at the end of a loop that may take a kill RPC per row.
 *
 * Works on an OFFLINE node, by design: the flag lands, each row retires with
 * `killUnverified` (the kill could not be confirmed, the row is retired
 * anyway), the push fails and is re-run at the node's next `ready`, and the
 * reconnect census best-effort-kills any pane that survived.
 *
 * @returns the ids stopped — the route audits and reports them, and "how many
 *   subshells did this take down" is the one number a person needs afterwards
 */
export async function setNodeMaintenance(write: MaintenanceWrite): Promise<{ stopped: string[] }> {
  const { repos } = getRequestlessContext();
  await repos.nodes.setMaintenance(write.nodeId, {
    on: write.on,
    changedAt: write.changedAt,
    source: write.source,
  });
  return await applyMaintenanceEffects(write);
}

/**
 * Reconcile one node's report against the plane's row — the body of the
 * `onMaintenance` lifecycle hook, fed by `ready.maintenance` and by the
 * `maintenance` event a machine sends when its own file changed.
 *
 * Adopting writes the row and then performs the effects WITHOUT awaiting
 * them. That is not indifference to failure: this runs on the socket's
 * serialized frame queue, and stopping N subshells is N kill round-trips at
 * up to ten seconds each — awaited, it would stall every later frame from
 * that node (heartbeats, exits, command results) behind a maintenance window.
 * The flag itself IS awaited, so the hook returns with launches already
 * refused; the loop and the reconnect census are idempotent over the same
 * rows, so whichever finishes second finds nothing to do.
 *
 * @param nodeId - the SOCKET's authenticated identity, never a frame's claim
 * @param reported - the machine's own copy, or undefined when it reported none
 */
export async function reconcileMaintenance(nodeId: string, reported: NodeMaintenanceWire | undefined): Promise<void> {
  const { repos } = getRequestlessContext();
  const row = await repos.nodes.findById(nodeId);
  if (!row) return;
  const decision = decideMaintenance(row, reported);
  if (decision === "noop") return;
  if (decision === "push-plane") {
    // Nothing to write and nothing to stop: the plane's value already stands,
    // so this is purely "make the machine's file agree with it". A row that
    // was never written has no stamp to send, and `decideMaintenance` never
    // routes that case here.
    if (row.maintenanceAt) {
      pushSetMaintenanceBestEffort(nodeId, { on: row.maintenance === 1, changedAt: row.maintenanceAt });
    }
    return;
  }
  // `decideMaintenance` only answers "adopt-node" when `reported` is set.
  const adopted = reported as NodeMaintenanceWire;
  const write: MaintenanceWrite = {
    nodeId,
    on: adopted.on,
    changedAt: clampAdoptedStamp(adopted.changedAt, new Date().toISOString()),
    source: "node",
    actorUserId: null,
  };
  await repos.nodes.setMaintenance(nodeId, { on: write.on, changedAt: write.changedAt, source: write.source });
  void applyMaintenanceEffects(write).catch((err: unknown) => {
    logger.withError(err).warn(`maintenance reconcile effects failed for node ${nodeId}`);
  });
}
