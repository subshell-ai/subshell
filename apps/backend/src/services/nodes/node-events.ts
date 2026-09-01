import type { NodeEvent } from "@internal/session-protocol";

/**
 * The backend event plane for `/ws/node` (spec 2026-08-31 §3.3, phase 2).
 * Two module-scope pieces the WS handler feeds, plus the slot the session
 * manager fills (Task 10):
 *
 * - **Output bus** — `subscribe_output` commands hand a `subId` to the agent;
 *   every `output` frame for it fans out through {@link dispatchOutput}.
 *   Subscribers are whoever opened the tail (terminal attaches); the map is
 *   module-scope because the socket handler has no natural owner for it.
 * - **Lifecycle hooks** — `exit` and `sessions_report` events drive session
 *   state reconciliation. Until Task 10 registers the hooks (and on test
 *   imports of the raw handler), the slot is empty and those frames produce
 *   one warn line each, nothing else — deliberately NOT an error: agents send
 *   them unconditionally.
 *
 * Ordering note: the handler dispatches frames per-socket through
 * `handleNodeMessageQueued` (P1-T10), so handlers here may `await` freely —
 * the next frame on that socket cannot interleave beneath them.
 */

/** The `output` frame the bus carries (frozen wire shape). */
type OutputEvent = Extract<NodeEvent, { type: "output" }>;

/** Handlers subscribed to one `subId` (insertion order; safe to mutate during dispatch). */
const outputSubs = new Map<string, Set<(ev: OutputEvent) => void>>();

/**
 * Register `handler` for every `output` frame carrying `subId`.
 * Multiple subscribers per subId are allowed (each tail opens its own).
 * @param subId - the subscription id handed to the agent by `subscribe_output`
 * @param handler - called synchronously per frame, in subscribe order
 * @returns a disposer that removes exactly this registration (idempotent)
 */
export function subscribeOutput(subId: string, handler: (ev: OutputEvent) => void): () => void {
  let set = outputSubs.get(subId);
  if (!set) {
    set = new Set();
    outputSubs.set(subId, set);
  }
  set.add(handler);
  let done = false;
  return () => {
    if (done) return;
    done = true;
    const current = outputSubs.get(subId);
    if (!current) return;
    current.delete(handler);
    if (current.size === 0) outputSubs.delete(subId);
  };
}

/**
 * Fan one `output` frame out to the subscribers of its `subId`.
 * Routing is subId-only — the accepted trust boundary for §3.3 events: the
 * frame arrived on a socket already authenticated as that node, and subIds
 * are unguessable uuids minted by the subscriber, so nothing here re-checks
 * the frame's `sessionId` against the subscription's session.
 * @param ev - the parsed `output` event
 * @returns true when at least one handler received it, false for an unknown subId
 */
export function dispatchOutput(ev: OutputEvent): boolean {
  const set = outputSubs.get(ev.subId);
  if (!set || set.size === 0) return false;
  // Snapshot: a handler may dispose (or add) subscriptions while we dispatch.
  for (const handler of [...set]) handler(ev);
  return true;
}

/**
 * Server-side consumers of the agent's session lifecycle events (spec §3.3).
 * `nodeId` is always the SOCKET's authenticated identity — never anything the
 * frame claims — so a compromised agent cannot attribute events to a
 * different node.
 */
export interface NodeLifecycleHooks {
  /** The agent reports one of its supervised harness panes exited. */
  onExit(nodeId: string, sessionId: string, exitCode: number | null, at: string): Promise<void> | void;
  /** The agent's full supervised-session census (reconcile after reconnect). */
  onSessionsReport(
    nodeId: string,
    report: Extract<NodeEvent, { type: "sessions_report" }>["sessions"],
  ): Promise<void> | void;
}

let lifecycleHooks: NodeLifecycleHooks | undefined;

/**
 * Install (or clear, with `undefined`) the lifecycle hooks. Task 10 calls
 * this at boot; until then `exit`/`sessions_report` frames warn-and-drop.
 * @param hooks - the implementation to install, or `undefined` to clear
 */
export function setNodeLifecycleHooks(hooks: NodeLifecycleHooks | undefined): void {
  lifecycleHooks = hooks;
}

/**
 * The currently installed lifecycle hooks (`undefined` = slot empty).
 * @returns the hooks the WS handler should invoke for exit/sessions_report
 */
export function getNodeLifecycleHooks(): NodeLifecycleHooks | undefined {
  return lifecycleHooks;
}

/**
 * Empties the output bus and the hooks slot. Test seam only — production
 * callers must not call this; @internal.
 */
export function resetNodeEventsForTests(): void {
  outputSubs.clear();
  lifecycleHooks = undefined;
}
