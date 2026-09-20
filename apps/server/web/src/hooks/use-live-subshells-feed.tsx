import { apiFetch } from "@internal/node-admin";
import { useQueryClient } from "@tanstack/react-query";
import { createContext, type ReactNode, useContext, useEffect, useMemo, useState } from "react";
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
 *
 * **Quiet frames must cost nothing.** Every observer of `SUBSHELLS_QUERY_KEY`
 * — sidebar, pickers, every open pane's trust row — would otherwise rebuild
 * on this stream's 1.5 s beat whether or not anything changed. It does not:
 * `setQueryData` structurally shares the write (unchanged rows keep their
 * references; a wholly unchanged list keeps the ARRAY's), and `lastList` is
 * set from the cache read-back rather than the freshly parsed frame, so an
 * identical frame leaves every reference — context value included — intact
 * and React renders nothing. The frame's real cost is now the parse itself
 * and the work of the rows that actually moved.
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
            // Read back, never the parsed frame: `setQueryData` shares the
            // write, so the cache holds the previous array when the frame
            // changed nothing and the previous row objects for the rows it
            // did not touch. Handing consumers THAT is what keeps a quiet
            // 1.5 s beat from re-rendering anything.
            setLastList(queryClient.getQueryData<SubshellView[]>(SUBSHELLS_QUERY_KEY) ?? data.subshells);
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

  // One value object per distinct state, not per render: without this the
  // provider re-rendering for ANY reason hands every `useContext` consumer a
  // fresh object and re-renders the tree through the back door the shared
  // cache write just closed.
  const value = useMemo<LiveSubshellsFeedValue>(() => ({ connected, lastList }), [connected, lastList]);

  return <FeedContext.Provider value={value}>{children}</FeedContext.Provider>;
}

/** The root feed's state — read by `useLiveSubshells`; nothing else should need it. */
export function useLiveSubshellsFeed(): LiveSubshellsFeedValue {
  return useContext(FeedContext);
}
