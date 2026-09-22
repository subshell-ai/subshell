/**
 * The probe's poll is the app's refresh (operator ruling 2026-09-22): there is
 * no Refresh button anywhere, so the interval's WIRING is the freshness
 * guarantee, and it is pinned here rather than assumed — the cadence is the
 * constant, the suspension while an action runs is real, and the settings
 * query is deliberately not on an interval.
 *
 * The wiring is read off the query instances themselves (`options
 * .refetchInterval`) rather than waited for: the point is what the queries are
 * configured to do, not a wall-clock sleep.
 */

import { describe, expect, it } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook } from "@testing-library/react";
import { PROBE_KEY, PROBE_POLL_MS, SETTINGS_KEY, useNodeState } from "@/hooks/use-node-state";
import { installFakeIpc } from "./harness";

describe("useNodeState's poll wiring", () => {
  it("re-reads the machine every five seconds, pauses for actions, never polls settings", () => {
    installFakeIpc();
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
    });
    const { rerender } = renderHook(({ paused }) => useNodeState(paused), {
      wrapper: ({ children }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>,
      initialProps: { paused: false },
    });

    const probe = client.getQueryCache().find({ queryKey: PROBE_KEY });
    const settings = client.getQueryCache().find({ queryKey: SETTINGS_KEY });
    if (!probe || !settings) throw new Error("the hook's queries did not mount");
    // The cache lookup's option types omit the interval; the value useQuery
    // was handed is still on the instance, so it is read off at runtime.
    const intervalOf = (q: unknown) => (q as { options: { refetchInterval?: unknown } }).options.refetchInterval;

    // The worst case the ruling names is the cadence already in place: five
    // seconds, as the constant — so a future edit that drifts the number is
    // this test's failure, not a quiet change of promise.
    expect(PROBE_POLL_MS).toBe(5_000);
    expect(intervalOf(probe)).toBe(PROBE_POLL_MS);

    // While an action is in flight the interval stops: the action's own
    // re-probe is about to run, and two CLI spawns racing a `service restart`
    // read a machine mid-transition.
    rerender({ paused: true });
    expect(intervalOf(probe)).toBe(false);

    // Settings is action-coherent by design — the runner refetches it after
    // every action — so it carries no interval of its own.
    expect(intervalOf(settings)).toBeUndefined();
  });
});
