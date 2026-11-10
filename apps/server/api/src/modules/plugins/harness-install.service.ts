import { builtInIds, getHarness } from "@internal/pane-runtime";
import { type NodeHarnessUpdateResult, parseNodeHarnessUpdateResult } from "@internal/subshell-protocol";
import { detectOnNode } from "@/modules/nodes/inventory.js";
import { sendCommand } from "@/modules/nodes/node-rpc.js";
import { claimHarnessRun, type HarnessRunClaim, HarnessRunRefused } from "@/modules/plugins/harness-run-lock.js";
import { logger } from "@/shared/logger.js";
import { enabledHarnessPlugins } from "./store.js";

/**
 * Installing a harness CLI on a REMOTE node (issue #250 follow-up).
 *
 * The control-plane host's own install path is the installer service, which
 * runs the line in this process. An enrolled node runs the same line through
 * the signed `harness_install` command instead, so the cross compile, the
 * package manager and the PATH are the node's, not the server's. Only a
 * BUILT-IN plugin can be installed this way: the installer line travels from
 * the manifest compiled into THIS binary, so what may run is changed by
 * editing this repo, never by anything a request sends.
 */

/**
 * The RPC deadline: the node's own ten-minute budget plus transport headroom,
 * so a command that uses all of it still answers.
 */
const HARNESS_INSTALL_RPC_TIMEOUT_MS = 10 * 60 * 1000 + 30_000;

/** A refusal decided before anything runs, with the status the route answers. */
export class HarnessInstallRefused extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404,
  ) {
    super(message);
    this.name = "HarnessInstallRefused";
  }
}

/** Test seams: the wire and the detection refresh the service would otherwise call. */
export interface HarnessInstallDeps {
  send?: typeof sendCommand;
  detect?: typeof detectOnNode;
}

/**
 * The shell line that installs one harness, or undefined when it offers none.
 *
 * Only an agent harness from the BUILT-IN set: a plain shell or an ssh pane
 * drives no CLI to install, and a plugin installed from the registry carries
 * no manifest this binary vouches for, so its line is not ours to run.
 */
export async function harnessInstallCommand(id: string): Promise<string | undefined> {
  const harness = getHarness(id);
  if (harness?.type !== "agent-harness") return undefined;
  if (!(await builtInIds()).includes(id)) return undefined;
  const command = harness.installHint.command.trim();
  return command === "" ? undefined : command;
}

/**
 * The refusals the route settles BEFORE it opens a stream, so they can still
 * be real status codes: an unknown plugin, one this build does not carry as a
 * built-in, one that drives no installable program, and one this instance does
 * not offer. The line is answered before the instance check because it is a
 * fact about the binary, not about the operator's plugin state — and a harness
 * with no installer needs no catalogue read to explain itself. The run slot is
 * deliberately not checked here: that refusal belongs to {@link claimHarnessRun},
 * and a plugin refusal must not depend on whether another run holds the node.
 */
export async function refuseHarnessInstall(id: string): Promise<HarnessInstallRefused | undefined> {
  if (!getHarness(id)) return new HarnessInstallRefused(`"${id}" is not a plugin this build carries`, 404);
  if (!(await builtInIds()).includes(id)) {
    return new HarnessInstallRefused(
      `"${id}" is not a built-in plugin; only built-in harness plugins can be installed from here`,
      400,
    );
  }
  if ((await harnessInstallCommand(id)) === undefined) {
    return new HarnessInstallRefused(`"${id}" doesn't offer an install.`, 400);
  }
  const offered = (await enabledHarnessPlugins()).some((r) => r.id === id && !r.broken);
  if (!offered) return new HarnessInstallRefused(`"${id}" is not offered by this instance`, 404);
  return undefined;
}

/**
 * Runs a built-in installer on an enrolled node and answers the same result
 * shape updates do.
 *
 * After a run that returned before its deadline the node's cached detection is
 * refreshed, so the page that refetches shows the binary the install just put
 * there. A TIMED-OUT run skips that refresh: `runBounded` kills only the direct
 * child, so a vendor pipeline may still be installing, and a detect taken now
 * could cache a half-installed answer. A failed refresh is logged rather than
 * failing the install: the run itself succeeded, and the next page load or
 * periodic pass repairs the cache.
 *
 * @param claim - the slot the route reserved before streaming; when absent,
 *   this call claims and releases its own
 */
export async function installHarnessOnNode(
  nodeId: string,
  id: string,
  claim?: HarnessRunClaim,
  deps: HarnessInstallDeps = {},
): Promise<NodeHarnessUpdateResult> {
  const owned = claim ?? claimHarnessRun(nodeId, id, "install");
  if (owned instanceof HarnessRunRefused) throw owned;
  try {
    const command = await harnessInstallCommand(id);
    if (command === undefined) throw new HarnessInstallRefused(`"${id}" doesn't offer an install.`, 400);
    const data = await (deps.send ?? sendCommand)(
      nodeId,
      { type: "harness_install", harnessId: id, command },
      { timeoutMs: HARNESS_INSTALL_RPC_TIMEOUT_MS },
    );
    const result = parseNodeHarnessUpdateResult(data);
    if (!result) throw new Error(`node "${nodeId}" answered a malformed harness install result`);
    if (result.harnessId !== id) {
      throw new Error(`node "${nodeId}" answered for harness "${result.harnessId}", not "${id}"`);
    }
    if (!result.timedOut) {
      try {
        await (deps.detect ?? detectOnNode)(nodeId);
      } catch (err) {
        logger.withError(err).warn(`harness "${id}" installed on node "${nodeId}", but its detection refresh failed`);
      }
    }
    return result;
  } finally {
    owned.release();
  }
}
