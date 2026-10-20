import { apiFetch } from "@internal/node-admin";
import type { HarnessSubagentSnapshot } from "@subshell-ai/plugin-api";
import { type QueryClient, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useSyncExternalStore } from "react";

/** App-wide batch snapshot: every visible subshell's reported children in one record. */
const HARNESS_SUBAGENTS_KEY = ["harness-subagents"] as const;

const HARNESS_SUBAGENTS_POLL_MS = 2000;

/**
 * ONE interval for the whole app, shared by whoever currently wants fresh data.
 * TanStack's `refetchInterval` is an observer-level option, so putting it on
 * this query would give every mounted row its own timer against the same
 * endpoint: a sidebar with N live panes issued roughly 2N batch requests every
 * 2 s, each of which lists every visible subshell server-side.
 *
 * The registry is a REFCOUNT PER QUERY CLIENT, not a set of per-observer
 * invalidators: a tick calls `invalidateQueries` once per client (measured —
 * N invalidator calls per tick re-fan into N fetches, because invalidation is
 * not deduped across calls). Observers of the same client share one entry,
 * and the timer exists only while at least one wants updates.
 */
const watchers = new Map<QueryClient, number>();
let ticker: ReturnType<typeof setInterval> | null = null;

function watchHarnessSubagents(client: QueryClient): () => void {
  watchers.set(client, (watchers.get(client) ?? 0) + 1);
  ticker ??= setInterval(() => {
    // A hidden tab gets nothing to look at, and a raw setInterval keeps
    // ticking where `refetchInterval` would have paused: the batch read lists
    // every visible subshell server-side, so a dashboard left backgrounded
    // over lunch would hammer it. The first tick after the tab is visible
    // again refetches, so a stale roster costs seconds, never correctness.
    if (document.visibilityState === "hidden") return;
    for (const watching of watchers.keys()) watching.invalidateQueries({ queryKey: HARNESS_SUBAGENTS_KEY });
  }, HARNESS_SUBAGENTS_POLL_MS);
  return () => {
    const left = (watchers.get(client) ?? 1) - 1;
    if (left <= 0) watchers.delete(client);
    else watchers.set(client, left);
    if (watchers.size === 0 && ticker) {
      clearInterval(ticker);
      ticker = null;
    }
  };
}

/**
 * The reported subagents of one subshell, read from the shared batch snapshot.
 * Pass `enabled` as the row's liveness (RUNNING is the row's TWO facts:
 * `status === "running"` AND `alive`), so rows for dead panes neither fetch nor
 * keep the shared ticker alive; polling only runs while some active observer is
 * mounted.
 */
export function useHarnessSubagents(id: string, enabled = true) {
  const client = useQueryClient();
  const active = enabled && Boolean(id);
  useEffect(() => {
    if (!active) return;
    return watchHarnessSubagents(client);
  }, [active, client]);
  return useQuery({
    queryKey: HARNESS_SUBAGENTS_KEY,
    queryFn: () => apiFetch<Record<string, HarnessSubagentSnapshot>>("/api/subshells/subagents"),
    select: (states) => states[id],
    enabled: active,
    staleTime: 1000,
  });
}

/**
 * Switches currently in flight, counted per pane. The pane has ONE queued
 * view command server-side, so two surfaces clicking at once (a row and the
 * header's return button) would silently replace each other's request while
 * only one of them looked busy. Pending therefore belongs to the PANE, not
 * to the mutation instance that happened to send the POST.
 */
const inFlightSelects = new Map<string, number>();
const selectWatchers = new Map<string, Set<() => void>>();

function shiftInFlight(id: string, delta: number): void {
  const next = (inFlightSelects.get(id) ?? 0) + delta;
  if (next > 0) inFlightSelects.set(id, next);
  else inFlightSelects.delete(id);
  for (const notify of selectWatchers.get(id) ?? []) notify();
}

/**
 * Asks the server to move the PARENT's own terminal view onto a reported child
 * (null returns to the main agent). The server queues the command and answers
 * before the harness switches views, so a resolved mutation means the request
 * landed, not that the view already moved — renderers keep showing the last
 * confirmed state until a poll carries the new one. `isPending` is shared
 * across every hook instance for the same pane, so all switch controls go
 * blocked together while one request is on the wire.
 */
export function useSelectHarnessAgent(id: string) {
  const client = useQueryClient();
  const select = useMutation({
    mutationFn: async (agentId: string | null) => {
      shiftInFlight(id, 1);
      try {
        return await apiFetch(`/api/subshells/${id}/subagents/select`, {
          method: "POST",
          body: JSON.stringify({ agentId }),
        });
      } finally {
        shiftInFlight(id, -1);
      }
    },
    onSuccess: () => client.invalidateQueries({ queryKey: HARNESS_SUBAGENTS_KEY }),
  });
  const subscribe = useCallback(
    (notify: () => void) => {
      let watchers = selectWatchers.get(id);
      if (!watchers) {
        watchers = new Set();
        selectWatchers.set(id, watchers);
      }
      watchers.add(notify);
      return () => {
        watchers.delete(notify);
        // Drop the key once empty (and still the one this watcher created),
        // so a long-lived app does not accumulate an entry per pane id that
        // ever mounted a switch surface.
        if (watchers.size === 0 && selectWatchers.get(id) === watchers) selectWatchers.delete(id);
      };
    },
    [id],
  );
  const panePending = useSyncExternalStore(subscribe, () => inFlightSelects.has(id));
  return { ...select, isPending: select.isPending || panePending };
}
