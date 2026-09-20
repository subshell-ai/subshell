import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { apiFetch } from "../lib/api";
import { NODE_QUERY_KEY, NODES_QUERY_KEY } from "../lib/query-keys";
import type { NodeDetail } from "../types/node";

/** Where a node restart stands: before the press, during the outage, and after it. */
export type RestartWaitOutcome = "idle" | "waiting" | "back" | "timeout";

/** What {@link useNodeRestartWait} hands the card. */
export interface NodeRestartWait {
  /** Where the restart stands */
  outcome: RestartWaitOutcome;
  /** Convenience for disabling controls */
  waiting: boolean;
  /** Start waiting, against the `startedAt` the page held before the press */
  begin: (startedAtBefore: string | undefined) => void;
  /**
   * Start waiting for a HELD node to come back LIVE (spec 2026-09-15 §5.3).
   *
   * A separate entry point rather than a flag, because the two waits have
   * nothing in common but their timers. A held node's `ready` never passed
   * the gates, so the plane holds no `runtime` for it and there is no
   * `startedAt` to compare — the wait that `begin` runs would sit until its
   * timeout on every successful update of exactly the machines this feature
   * exists for. What it watches instead is the state change itself: `held`
   * going null AND `status` going online, which together mean a node
   * connected and was accepted.
   */
  beginHeld: () => void;
  /** Return to idle and stop waiting */
  reset: () => void;
}

/**
 * Whether a node's freshly reported `startedAt` names a DIFFERENT process
 * from the one running before the restart.
 *
 * **Exact inequality, with no drift tolerance — and that is a decision, not
 * an oversight.** `startedAt` is derived by the node the same way
 * `admin/status` derives `bootedAt` (`now - uptime*1000`, from a
 * whole-second uptime), which is what forced a five-second tolerance into
 * `isNewBoot`. The difference is WHEN: the node computes this once at
 * daemon start and sends that same frozen string in every `ready`, reconnects
 * included (`apps/node/agent/src/daemon.ts` collects it once and reuses the
 * object), and the plane holds the report on the live socket rather than
 * re-deriving it per read. So two reads of one unrestarted node are byte
 * identical and equality cannot false-positive here.
 *
 * A tolerance would therefore buy nothing and cost something real: a systemd
 * `RestartSec=5` plus a fast node boot puts the new `startedAt` within a few
 * seconds of the old one, so a five-second window would judge a SUCCESSFUL
 * restart to be the same process and the wait would run to its timeout.
 *
 * @param before - the value the page held when the restart was requested
 * @param now - the value the node is reporting now
 */
export function isNewNodeProcess(before: string | undefined, now: string): boolean {
  return before === undefined || now !== before;
}

/** How often the node detail is re-read while waiting. */
const POLL_MS = 1500;

/** How long to wait before saying the node has not come back. */
const TIMEOUT_MS = 60_000;

/**
 * Watch a node go away and come back (spec 2026-09-12 § 6.3).
 *
 * Polls `GET /api/nodes/:id` directly rather than through the query cache,
 * for the reason the server's waiter does: the cache's retry policy and the
 * offline banner own ordinary outages, and this one is expected. The node
 * drops to `offline` and its `runtime` disappears with the socket, so the
 * wait ends only on the pair — online AND a runtime AND a new `startedAt`.
 *
 * The baseline is captured at {@link NodeRestartWait.begin} rather than read
 * from a prop on every render. A prop would go `undefined` the moment the
 * node dropped offline (the report goes with the socket), which both restarts
 * the effect mid-wait and erases the very value being compared against.
 *
 * @param id - the node being restarted
 */
export function useNodeRestartWait(id: string): NodeRestartWait {
  const queryClient = useQueryClient();
  const [outcome, setOutcome] = useState<RestartWaitOutcome>("idle");
  const began = useRef(0);
  const before = useRef<string | undefined>(undefined);
  /**
   * Which of the two "it came back" tests this wait is running.
   *
   * A ref rather than state: it is read inside the polling effect and must not
   * be part of what re-runs it. `begin`/`beginHeld` set it in the same tick
   * they flip `outcome`, which is the only thing the effect depends on.
   */
  const heldWait = useRef(false);

  useEffect(() => {
    if (outcome !== "waiting") return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const tick = async (): Promise<void> => {
      if (cancelled) return;
      try {
        const detail = await apiFetch<NodeDetail>(`/api/nodes/${id}`);
        // A held node has no `runtime` to compare a `startedAt` against — its
        // `ready` never passed the gates — so the test is the state change:
        // no longer held AND online means a node connected and was accepted.
        // The ordinary restart's test is unchanged.
        const back = heldWait.current
          ? detail.held === null && detail.status === "online"
          : detail.status === "online" && detail.runtime && isNewNodeProcess(before.current, detail.runtime.startedAt);
        if (back) {
          if (cancelled) return;
          setOutcome("back");
          void queryClient.invalidateQueries({ queryKey: [...NODE_QUERY_KEY, id] });
          void queryClient.invalidateQueries({ queryKey: NODES_QUERY_KEY });
          return;
        }
      } catch {
        // On its way down, or on its way up: both are this wait's normal shape.
      }
      if (Date.now() - began.current > TIMEOUT_MS) {
        if (!cancelled) setOutcome("timeout");
        return;
      }
      timer = setTimeout(() => void tick(), POLL_MS);
    };

    void tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [outcome, id, queryClient]);

  return {
    outcome,
    waiting: outcome === "waiting",
    begin: (startedAtBefore: string | undefined) => {
      heldWait.current = false;
      before.current = startedAtBefore;
      began.current = Date.now();
      setOutcome("waiting");
    },
    beginHeld: () => {
      heldWait.current = true;
      before.current = undefined;
      began.current = Date.now();
      setOutcome("waiting");
    },
    reset: () => setOutcome("idle"),
  };
}
