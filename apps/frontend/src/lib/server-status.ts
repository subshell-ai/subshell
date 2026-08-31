import type { QueryClient } from "@tanstack/react-query";
import { isNetworkError } from "@/lib/api";
import { queryClient } from "@/lib/query-client";

/** What the shell needs: a boolean snapshot + a subscription. */
export interface ServerStatusStore {
  /** Registers a listener; called on every offline↔online transition. Returns the unsubscribe. */
  subscribe(cb: () => void): () => void;
  /** Current truth: true while any ACTIVE query is stuck on a NetworkError. */
  getSnapshot(): boolean;
}

/**
 * Derives "the mote server is unreachable" from the query cache — it never
 * polls. The QueryClient's network-retry loop (query-client.ts) IS the probe:
 * while any active query sits in `NetworkError` the server is down; the first
 * successful retry fires a cache event and the state clears. Factory form so
 * tests bind a store to their own client; the app uses the shared singleton.
 * Scoping to ACTIVE queries keeps unmounted stale errors from pinning the
 * banner: only what the user is looking at defines "offline".
 */
export function createServerStatusStore(client: QueryClient): ServerStatusStore {
  let offline = false;
  let watching = false;
  const listeners = new Set<() => void>();

  const compute = () =>
    client
      .getQueryCache()
      .getAll()
      .some((q) => q.isActive() && q.state.status === "error" && isNetworkError(q.state.error));

  const refresh = () => {
    const next = compute();
    if (next === offline) return;
    offline = next;
    for (const l of [...listeners]) l();
  };

  return {
    subscribe(cb) {
      if (!watching) {
        watching = true;
        client.getQueryCache().subscribe(refresh);
      }
      listeners.add(cb);
      if (listeners.size === 1) refresh(); // catch failures predating the first mount
      return () => {
        listeners.delete(cb);
      };
    },
    getSnapshot: () => offline,
  };
}

/** The app-wide store over the shared client. */
export const serverStatus = createServerStatusStore(queryClient);
/** Stable references for useSyncExternalStore. */
export const subscribeServerStatus = (cb: () => void) => serverStatus.subscribe(cb);
export const getServerSnapshot = () => serverStatus.getSnapshot();
