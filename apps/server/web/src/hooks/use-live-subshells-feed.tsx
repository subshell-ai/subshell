import { apiFetch } from "@internal/node-admin";
import { useQueryClient } from "@tanstack/react-query";
import { createContext, type ReactNode, useContext, useEffect, useState } from "react";
import { SUBSHELLS_QUERY_KEY } from "@/lib/query-keys";
import type { SubshellView } from "@/types/subshell";

interface LiveSubshellsFeedValue {
  /** True while the `/api/events` stream is open and delivering. */
  connected: boolean;
  /** The most recent frame's list, or null until the stream has delivered one. */
  lastList: SubshellView[] | null;
}

const FeedContext = createContext<LiveSubshellsFeedValue>({ connected: false, lastList: null });

/**
 * The ONE live subshell feed for the whole signed-in session (spec
 * 2026-09-03 sidebar-quickadd §6). Mounted by `__root.tsx`; each SSE frame is
 * written straight into the shared `SUBSHELLS_QUERY_KEY` cache, so the
 * sidebar's status dots, the home cards, and every picker read one live
 * source instead of a snapshot taken at navigation.
 *
 * Auth uses the same short-lived single-use ws token as the WS attach path
 * (EventSource cannot send the HttpOnly cookie), so the stream is (re)opened
 * with a fresh token whenever the previous one dies — bounded backoff,
 * mechanics lifted verbatim from the old `useLiveSubshells`.
 *
 * `enabled` gates the stream so it never fires its token POST pre-auth (the
 * provider stays mounted for tree stability; the effect simply does not run).
 */
export function LiveSubshellsFeedProvider({ enabled, children }: { enabled: boolean; children: ReactNode }) {
  const queryClient = useQueryClient();
  const [connected, setConnected] = useState(false);
  const [lastList, setLastList] = useState<SubshellView[] | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let es: EventSource | null = null;
    let cancelled = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

    async function connect() {
      try {
        const { token } = await apiFetch<{ token: string }>("/api/auth/ws-token", { method: "POST" });
        if (cancelled) return;
        // One connection per token (tokens are single-use + 30s TTL).
        es = new EventSource(`/api/events?token=${encodeURIComponent(token)}`);
        es.onmessage = (e) => {
          try {
            const data = JSON.parse(e.data as string) as { subshells: SubshellView[] };
            queryClient.setQueryData(SUBSHELLS_QUERY_KEY, data.subshells);
            setLastList(data.subshells);
            setConnected(true);
          } catch {
            // ignore malformed frame
          }
        };
        // EventSource auto-reconnects on network errors, but the consumed/expired
        // token would 401 forever — tear the stream down and retry with a fresh
        // token (bounded backoff).
        es.onerror = () => {
          setConnected(false);
          es?.close();
          es = null;
          if (!cancelled) {
            const delay = reconnectTimer ? 3000 : 1000;
            reconnectTimer = setTimeout(() => {
              reconnectTimer = null;
              void connect();
            }, delay);
          }
        };
      } catch {
        // token fetch failed; consumers fall back to the REST list cache
        setConnected(false);
      }
    }
    void connect();

    return () => {
      cancelled = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      es?.close();
    };
  }, [enabled, queryClient]);

  return <FeedContext.Provider value={{ connected, lastList }}>{children}</FeedContext.Provider>;
}

/** The root feed's state — read by `useLiveSubshells`; nothing else should need it. */
export function useLiveSubshellsFeed(): LiveSubshellsFeedValue {
  return useContext(FeedContext);
}
