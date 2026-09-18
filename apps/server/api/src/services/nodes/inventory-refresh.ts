import { IS_TEST } from "@/constants.js";
import { LOCAL_NODE_ID } from "@/db/types/nodes.db-types.js";
import { detectOnNodeBestEffort, INVENTORY_TTL_MS } from "@/services/nodes/inventory.js";
import { listOnline } from "@/services/nodes/node-registry.js";
import { logger } from "@/utils/logger.js";

/**
 * Keeping every online agent node's harness inventory fresh while nobody is
 * looking.
 *
 * The plane still ASKS and the node still only answers — spec 2026-09-10 §4's
 * load-bearing half is untouched, and nothing here runs on a node's own
 * initiative. What changes is the set of things that count as asking. It used
 * to be a person: a node page opened, a Re-check pressed, a launch attempted.
 * That left the two moments a cache is most likely to be wrong with nobody to
 * ask — a machine that just enrolled and connected for the first time, and a
 * machine somebody installed a CLI on an hour ago — so a node's harness list
 * stayed wrong until its owner happened to open its page. That is the defect
 * this closes; the trigger is the node becoming reachable
 * (`node-ws-handler`'s `ready` kick) and then this timer.
 *
 * **The cadence is derived from {@link INVENTORY_TTL_MS}, not chosen beside
 * it.** The launch gate (`api/harness-utils.ts`) counts an agent's cached
 * answer only while it is FRESH, so a refresh period LONGER than the TTL
 * would leave an online, healthy node reading as unusable for the remainder
 * of every cycle — a refresh that fails at the one thing that matters most.
 * Half the TTL means one skipped or failed pass still leaves the cache fresh,
 * and a TTL change moves the cadence with it rather than leaving two numbers
 * to be kept in step by hand.
 *
 * **No stagger, deliberately.** A pass is one small frame per online node on
 * a socket that already exists, and the probing it triggers happens on N
 * different machines concurrently — the plane pays for the frames, not for
 * the PATH walks. Spreading them would add a cursor (which node is next) and
 * a failure mode (a node skipped because a pass was cut short) to bound a
 * cost that is not on this host. Revisit it if a fleet ever makes the frames
 * themselves measurable, not before.
 */

/**
 * How often every online agent node is re-asked what it has installed.
 *
 * Half of {@link INVENTORY_TTL_MS} — see the module note: the period has to
 * sit BELOW the freshness window the launch gate applies, or the refresh
 * leaves gaps in exactly the state it exists to maintain.
 */
export const NODE_INVENTORY_REFRESH_MS = INVENTORY_TTL_MS / 2;

/** The seams a test replaces: who is online, what "detect" means, and the clock. */
export interface InventoryRefreshDeps {
  /** Ids with a live connection. Production: the node registry (never a DB scan). */
  online(): string[];
  /** Kick one node's detection, fire-and-forget. Production: {@link detectOnNodeBestEffort}. */
  detect(nodeId: string): void;
  /** The clock. Production: an unref'd `setInterval`, so a pending tick never holds the process open. */
  schedule(tick: () => void, everyMs: number): { stop(): void };
}

const defaultDeps: InventoryRefreshDeps = {
  online: listOnline,
  detect: detectOnNodeBestEffort,
  schedule: (tick, everyMs) => {
    const timer = setInterval(tick, everyMs);
    timer.unref?.();
    return { stop: () => clearInterval(timer) };
  },
};

let depsOverride: InventoryRefreshDeps | undefined;

/**
 * Test seam. Refuses outside the suite — the `setOriginRefreshDepsForTests`
 * pattern: a production import able to swap these could redirect which
 * machines this plane probes.
 * @internal
 */
export function setInventoryRefreshDepsForTests(deps: InventoryRefreshDeps | null): void {
  if (!IS_TEST) throw new Error("setInventoryRefreshDepsForTests is a test-only seam");
  depsOverride = deps ?? undefined;
}

function deps(): InventoryRefreshDeps {
  return depsOverride ?? defaultDeps;
}

/**
 * One pass: kick detection on every online AGENT node.
 *
 * The online set comes from the REGISTRY rather than a `status='online'`
 * query, for the same reason the offline sweep takes it from there — the
 * registry is authoritative for reachability, and a node that dropped between
 * the read and the send simply has its command fail, which
 * {@link detectOnNodeBestEffort} already absorbs into a debug line.
 *
 * `local` is skipped BY NAME rather than left to no-op inside the driver: its
 * harnesses are probed live on every read (the table at the top of
 * `inventory.ts`), so a `detect` for it is meaningless, and the filter says so
 * where a reader is asking what this pass covers. In production it can never
 * appear here anyway — the upgrade hook refuses a `local` dial-in — so this is
 * the belt to that structural brace.
 *
 * Synchronous: each kick is fire-and-forget by construction, so a pass returns
 * as soon as the frames are queued and never waits on a node.
 * @returns the node ids this pass asked (test/diagnostic visibility)
 */
export function refreshOnlineNodeInventories(): string[] {
  const { online, detect } = deps();
  const asked: string[] = [];
  for (const nodeId of online()) {
    if (nodeId === LOCAL_NODE_ID) continue;
    try {
      detect(nodeId);
      asked.push(nodeId);
    } catch (err: unknown) {
      // Only a throwing seam can land here; the default never throws. One
      // node must not cost the rest of the pass.
      logger.withError(err).debug(`node ${nodeId}: periodic detection kick failed`);
    }
  }
  return asked;
}

/**
 * Arms the timer. Returns its stop handle; the interval is unref'd, so nothing
 * need call it on exit.
 *
 * `setInterval` never fires immediately, which is what keeps the first pass
 * off the boot path — and costs nothing, because a node that connects during
 * boot is kicked by its own `ready` frame.
 */
export function startInventoryRefresh(): { stop(): void } {
  return deps().schedule(() => {
    try {
      refreshOnlineNodeInventories();
    } catch (err: unknown) {
      // The timer must survive anything a pass can do to itself: an uncaught
      // throw in a timer callback reaches `index.ts`'s uncaughtException
      // handler, which exits the process.
      logger.withError(err).warn("the node inventory refresh pass failed; the last known inventories stand");
    }
  }, NODE_INVENTORY_REFRESH_MS);
}
