import { useEffect, useState } from "react";
import type { InputQueue, InputQueueStats, RttSamples } from "@/lib/input-queue";

/**
 * The attach's live input-queue facts for a rendered surface (the badge, the
 * Wave C diagnostics HUD), shared so the two cannot pick the queue up or
 * subscribe to it differently.
 *
 * The queue is created by the WS hook's effect, which runs AFTER this
 * consumer's own effects (React is child-first), so it is picked up by a
 * short poll rather than read once at mount. Live facts are then read on
 * every queue notification, coalesced through requestAnimationFrame, and on a
 * 500 ms interval while anything is pending: the stall threshold and the RTT
 * numbers are facts about TIME, not events, so a visible queue keeps ticking
 * even in silence.
 *
 * @param inputQueueRef - the hook-owned queue ref; null until the terminal
 *   mounts its attach
 */
export function useLiveInputQueue(inputQueueRef: { current: InputQueue | null }): {
  /** The queue once picked up; null until then. */
  queue: InputQueue | null;
  /** The queue's live facts, read at the last sync. */
  stats: InputQueueStats;
  /** The queue's recent round-trip times, read at the last sync. */
  rtt: RttSamples;
} {
  const [queue, setQueue] = useState<InputQueue | null>(null);
  useEffect(() => {
    const found = inputQueueRef.current;
    if (found) {
      if (found !== queue) setQueue(found);
      return;
    }
    const poll = setInterval(() => {
      const picked = inputQueueRef.current;
      if (picked) {
        clearInterval(poll);
        setQueue(picked);
      }
    }, 50);
    return () => clearInterval(poll);
  }, [queue, inputQueueRef]);

  const [live, setLive] = useState<{ stats: InputQueueStats; rtt: RttSamples }>({
    stats: { depth: 0, unackedOldestMs: null, inFlight: 0, backlog: 0 },
    rtt: { count: 0, p50: null, max: null },
  });
  useEffect(() => {
    if (!queue) return;
    let raf = 0;
    const sync = () => {
      setLive({ stats: queue.stats, rtt: queue.rtt });
    };
    const schedule = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        sync();
      });
    };
    const unsubscribe = queue.onStats(schedule);
    const tick = setInterval(() => {
      if (queue.stats.depth > 0) sync();
    }, 500);
    sync();
    return () => {
      unsubscribe();
      clearInterval(tick);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [queue]);

  return { queue, stats: live.stats, rtt: live.rtt };
}
