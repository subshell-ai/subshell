import { db } from "@/db/index.js";
import { getLive } from "@/services/nodes/node-registry.js";
import {
  bestEffortRunCancel,
  nodeSshInputControl,
  nodeSshRunStatus,
  SshNodeRefusal,
} from "@/services/ssh/ssh-node-client.js";
import { SshPanesRepository } from "@/services/ssh/ssh-panes.repository.js";
import { applyRunFacts, sshRunsRepo } from "@/services/ssh/ssh-run-mirror.js";
import { logger } from "@/utils/logger.js";

/**
 * Reconciliation on node (re)connect (SSH-SUPPORT.md §3 Durable dispatch:
 * "Reconcile known IDs after reconnect... stale signed commands refused by
 * expiry"). The coordinator wires the call into the node-ws-handler's
 * post-`ready` hooks - the exact hunk is the task-D report's integration
 * request; nothing here is reachable until that line exists, and nothing
 * here re-DISPATCHES a start, which is the rule this module exists to obey.
 *
 * The order is the spec's: pending CANCELLATIONS first (an offline-period
 * cancel is dispatched before any new work on the machine), then the status
 * census over unsettled runs (a cancelled run's status answer still matters
 * - did it die or win its race - and every fold is the monotone reducer, so
 * the two passes cannot corrupt each other). A run the node no longer knows
 * (`run_unknown`) settles to `unknown`: not failed, not completed, never a
 * retry.
 *
 * Managed panes get their input-control state RE-ASSERTED (the plane's
 * current mode + generation) so a revocation or takeover that landed while
 * the link was down fences node-side too; the node refuses a transition that
 * would LOWER its generation, so replaying the plane's number is idempotent
 * and cannot un-fence (frozen `ssh_input_control` contract).
 */

const runs = sshRunsRepo();
const panes = new SshPanesRepository(db);

/** One pass for a node that just became live. Never throws; every step is best-effort per row. */
export async function reconcileSshNode(nodeId: string): Promise<void> {
  if (!getLive(nodeId)) return;

  for (const run of await runs.listPendingCancelsForNode(nodeId)) {
    const facts = await bestEffortRunCancel(nodeId, run.id);
    if (facts) await applyRunFacts(run.id, facts);
  }

  for (const run of await runs.listUnsettledForNode(nodeId)) {
    try {
      const facts = await nodeSshRunStatus(nodeId, run.id);
      await applyRunFacts(run.id, facts);
    } catch (err) {
      if (err instanceof SshNodeRefusal && err.code === "run_unknown") {
        await applyRunFacts(run.id, {
          runId: run.id,
          lifecycle: "unknown",
          cancelRequested: run.cancelRequested === 1,
          cancelLocalConfirmed: false,
          deadlineHit: run.deadlineHit === 1,
          remoteStatus: null,
          remoteStatusConfirmed: false,
          localExitCode: null,
          localExitSignal: null,
        });
        continue;
      }
      logger.withError(err).warn(`ssh reconcile status ask for run ${run.id} on node ${nodeId} failed`);
    }
  }

  for (const pane of await panes.listByNodeLive(nodeId)) {
    try {
      await nodeSshInputControl(nodeId, {
        subshellId: pane.subshellId,
        mode: pane.controlOwner,
        generation: pane.controlGeneration,
      });
    } catch (err) {
      // A pane that died during the outage answers a refusal; its row is
      // reconciled to retired by the ordinary lifecycle path (C's), not here.
      logger.withError(err).warn(`ssh control re-assert for pane ${pane.subshellId} on node ${nodeId} failed`);
    }
  }
}
