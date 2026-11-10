import { LOCAL_NODE_ID } from "@/db/types/nodes.db-types.js";
import { claimLocalRun, localRunHolder } from "@/modules/plugins/local-run-lock.js";

/**
 * One harness package-manager run per NODE at a time, whatever it is for.
 *
 * The plane-side half of the serialization, shared by install and update: two
 * CLIs can share one package manager (`npm i -g` is the common case), so an
 * install and an update — or two of either — running at once can still race
 * over the same files. The value records the harness id and the verb, so a
 * refusal can say what is already running. The node also queues harness runs
 * among themselves, but that is a backstop; this guard is what turns a double
 * press into a 409 before a byte is streamed.
 */
interface RunningRun {
  id: string;
  verb: "install" | "update";
}

const inFlight = new Map<string, RunningRun>();

/** A reserved harness-run slot; releasing it twice is harmless. */
export interface HarnessRunClaim {
  release(): void;
}

/** A slot already held by another harness run on this node. */
export class HarnessRunRefused extends Error {
  readonly status = 409;

  constructor(message: string) {
    super(message);
    this.name = "HarnessRunRefused";
  }
}

/**
 * Reserve this node's harness-run slot, or explain why not.
 *
 * Called by a route BEFORE the response body opens, because a refusal that
 * loses a race after that point can only arrive as an `error` frame with a
 * 200 status. `updateHarness` and `installHarnessOnNode` claim for themselves
 * when their caller has not.
 * @param nodeId - the machine the run executes on
 * @param id - the harness about to run
 * @param verb - what is about to run, for the refusal's wording
 */
export function claimHarnessRun(
  nodeId: string,
  id: string,
  verb: "install" | "update",
): HarnessRunClaim | HarnessRunRefused {
  const running = inFlight.get(nodeId);
  if (running !== undefined) {
    const doing = running.verb === "install" ? "installed" : "updated";
    return new HarnessRunRefused(`"${running.id}" is already being ${doing} on this node.`);
  }
  // The control-plane host's installers share this filesystem too, and their
  // lock is per plugin id, so a harness run has to take the host slot as well.
  let releaseHost: (() => void) | undefined;
  if (nodeId === LOCAL_NODE_ID) {
    const holder = localRunHolder();
    releaseHost = holder === undefined ? claimLocalRun(`${verb} "${id}"`) : undefined;
    if (!releaseHost) {
      return new HarnessRunRefused(
        `The control-plane host is busy with ${holder ?? "another install"}; try again when it finishes.`,
      );
    }
  }
  inFlight.set(nodeId, { id, verb });
  let released = false;
  return {
    release() {
      if (released) return;
      released = true;
      if (inFlight.get(nodeId)?.id === id) inFlight.delete(nodeId);
      releaseHost?.();
    },
  };
}
