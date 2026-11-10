import { getHarness, runBounded, summarizeBoundedRun } from "@internal/pane-runtime";
import { type NodeHarnessUpdateResult, parseNodeHarnessUpdateResult } from "@internal/subshell-protocol";
import { LOCAL_NODE_ID } from "@/db/types/nodes.db-types.js";
import { detectOnNode } from "@/modules/nodes/inventory.js";
import { sendCommand } from "@/modules/nodes/node-rpc.js";
import { claimHarnessRun, type HarnessRunClaim, HarnessRunRefused } from "@/modules/plugins/harness-run-lock.js";
import { logger } from "@/shared/logger.js";
import { enabledHarnessPlugins } from "./store.js";

/**
 * Updating the CLI a harness plugin drives (issue #250).
 *
 * The line is the plugin manifest's `subshell.update.command`, or its
 * `install.command` when the installer doubles as the updater — resolved once
 * by the adapter (`HarnessPlugin.updateHint`), so no surface re-derives it.
 * It runs on the machine that holds the harness: in this process for `local`,
 * through the signed `harness_update` command for an enrolled node.
 *
 * Bounds are the installers' (`runBounded`): an allowlisted environment, a
 * login-shell PATH, closed stdin, a ten-minute deadline and the output cap.
 * The manifest parser already refuses a line that needs privileges.
 */

/** The installer budget, reused: an update is the same kind of run. */
export const HARNESS_UPDATE_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * The RPC deadline for a remote run: the node's own budget plus transport
 * headroom, so a command that uses all ten minutes still answers.
 */
export const HARNESS_UPDATE_RPC_TIMEOUT_MS = HARNESS_UPDATE_TIMEOUT_MS + 30_000;

/** A refusal decided before anything runs, with the status the route answers. */
export class HarnessUpdateRefused extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409,
  ) {
    super(message);
    this.name = "HarnessUpdateRefused";
  }
}

/**
 * The shell line that updates one harness, or undefined when it offers none.
 *
 * Only an agent harness: a plain shell or an ssh pane drives no CLI whose
 * version a pane would keep, and the node page offers Update on the same
 * subset (`HarnessInfo.type`).
 */
export function harnessUpdateCommand(id: string): string | undefined {
  const harness = getHarness(id);
  if (harness?.type !== "agent-harness") return undefined;
  const command = harness.updateHint?.command.trim();
  return command === "" || command === undefined ? undefined : command;
}

/**
 * The refusals the route settles BEFORE it opens a stream, so they can still
 * be real status codes: an unknown plugin, one this instance does not offer,
 * and one with no update path. `updateHarness` re-reads the line for itself
 * (the registry can change between the check and the run); serialization is
 * {@link claimHarnessRun}'s job and is deliberately absent here, so a
 * refusal about the plugin never depends on whether another run holds the
 * slot.
 */
export async function refuseHarnessUpdate(id: string): Promise<HarnessUpdateRefused | undefined> {
  const offered = (await enabledHarnessPlugins()).some((r) => r.id === id && !r.broken);
  if (!getHarness(id)) return new HarnessUpdateRefused(`"${id}" is not a plugin this build carries`, 404);
  if (!offered) return new HarnessUpdateRefused(`"${id}" is not offered by this instance`, 404);
  if (harnessUpdateCommand(id) === undefined) {
    return new HarnessUpdateRefused(`"${id}" doesn't offer an update.`, 400);
  }
  return undefined;
}

/**
 * Runs the update to completion and answers the same shape on both machines.
 *
 * After a REMOTE run the node's cached detection is refreshed, so the page
 * that refetches shows the version the update just installed. A failed refresh
 * is logged rather than failing the update: the run itself succeeded, and the
 * next page load or periodic pass repairs the cache.
 *
 * @param claim - the slot the route reserved before streaming; when absent,
 *   this call claims and releases its own
 */
export async function updateHarness(
  nodeId: string,
  id: string,
  onLine?: (line: string) => void,
  claim?: HarnessRunClaim,
): Promise<NodeHarnessUpdateResult> {
  const owned = claim ?? claimHarnessRun(nodeId, id, "update");
  if (owned instanceof HarnessRunRefused) throw owned;
  try {
    const command = harnessUpdateCommand(id);
    if (command === undefined) throw new HarnessUpdateRefused(`"${id}" doesn't offer an update.`, 400);
    if (nodeId === LOCAL_NODE_ID) return await runUpdateCommand(id, command, onLine);
    const result = await runOnNode(nodeId, id, command);
    try {
      await detectOnNode(nodeId);
    } catch (err) {
      logger.withError(err).warn(`harness "${id}" updated on node "${nodeId}", but its detection refresh failed`);
    }
    return result;
  } finally {
    owned.release();
  }
}

/**
 * The control-plane host's own half: the same bounded runner the installers
 * use. Exported so its reporting shape — a non-zero exit as a RESULT, the
 * joined output, the timeout marker — is testable without touching a vendor's
 * installer.
 */
export async function runUpdateCommand(
  id: string,
  command: string,
  onLine?: (line: string) => void,
): Promise<NodeHarnessUpdateResult> {
  const result = await runBounded(["sh", "-c", command], { timeoutMs: HARNESS_UPDATE_TIMEOUT_MS, onLine });
  return { harnessId: id, ...summarizeBoundedRun(result, HARNESS_UPDATE_TIMEOUT_MS, "update") };
}

/** An enrolled node's half: one signed command, one validated answer. */
async function runOnNode(nodeId: string, id: string, command: string): Promise<NodeHarnessUpdateResult> {
  const data = await sendCommand(
    nodeId,
    { type: "harness_update", harnessId: id, command },
    { timeoutMs: HARNESS_UPDATE_RPC_TIMEOUT_MS },
  );
  const result = parseNodeHarnessUpdateResult(data);
  if (!result) throw new Error(`node "${nodeId}" answered a malformed harness update result`);
  if (result.harnessId !== id) {
    throw new Error(`node "${nodeId}" answered for harness "${result.harnessId}", not "${id}"`);
  }
  return result;
}
