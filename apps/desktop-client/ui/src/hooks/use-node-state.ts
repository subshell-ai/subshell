/**
 * The machine's state, as two TanStack queries.
 *
 * `node_probe` is the expensive one — two CLI spawns plus the ladder probes —
 * which is why {@link PROBE_POLL_MS} is seconds and why polling is SUSPENDED
 * while an action runs. (The cheap probe a fast poll would reach for,
 * `status --probe`, is not merely expensive: it supersede-kicks a live agent,
 * possibly one on another machine for this same node. The Rust side makes it
 * unreachable, and nothing here may add an affordance that asks for it.)
 */
import { useQuery } from "@tanstack/react-query";
import { errorText } from "@/lib/actions";
import { nodeProbe, nodeSettings } from "@/lib/ipc";

export const PROBE_KEY = ["node-probe"] as const;
export const SETTINGS_KEY = ["node-settings"] as const;

/** How often the probe re-reads the machine on its own. Seconds, deliberately. */
export const PROBE_POLL_MS = 5_000;

/**
 * Read the probe and the app's preferences.
 *
 * @param paused Whether an action is in flight. Polling stops while one is:
 *   two CLI spawns racing a `service restart` is a probe that reads a machine
 *   mid-transition, and the action's own re-probe is about to run anyway.
 */
export function useNodeState(paused: boolean) {
  const probe = useQuery({
    queryKey: PROBE_KEY,
    queryFn: nodeProbe,
    refetchInterval: paused ? false : PROBE_POLL_MS,
    // Every retry is two more CLI spawns and delays the message by the backoff.
    // A probe that could not run is something to say, not something to hide.
    retry: false,
  });
  const settings = useQuery({
    queryKey: SETTINGS_KEY,
    queryFn: nodeSettings,
    // In-process on the Rust side: no spawn, so nothing to poll for. Refetched
    // after every action instead.
    retry: false,
  });

  return {
    probe: probe.data,
    settings: settings.data,
    /** True until the first probe lands — the "Checking this machine…" state. */
    firstProbePending: probe.isPending,
    /**
     * Why the probe itself could not be read.
     *
     * Distinct from `probe.error`, which is the CLI's own words carried INSIDE
     * a successful probe. This one is the command rejecting — a missing
     * permission, say — and it must reach the screen rather than leaving the
     * window stuck on stale facts.
     */
    readError: probe.error ? `Could not read this machine's state: ${errorText(probe.error)}` : "",
  };
}
