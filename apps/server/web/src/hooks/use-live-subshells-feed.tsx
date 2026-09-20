import { apiFetch } from "@internal/node-admin";
import { useQueryClient } from "@tanstack/react-query";
import { createContext, type ReactNode, useContext, useEffect, useMemo, useState } from "react";
import { SUBSHELLS_QUERY_KEY } from "@/lib/query-keys";
import type { SubshellView } from "@/types/subshell";

interface LiveSubshellsFeedValue {
  /** True while the `/ws/live` socket is open and delivering. */
  connected: boolean;
  /** The most recent snapshot's list, or null until one has arrived. */
  lastList: SubshellView[] | null;
}

/** Fixed delay before the first reconnect attempt; later ones back off to {@link RECONNECT_MAX_MS}. */
const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 3_000;

const FeedContext = createContext<LiveSubshellsFeedValue>({ connected: false, lastList: null });

/**
 * The ONE live subshell feed for the whole signed-in session (spec
 * 2026-09-03 sidebar-quickadd §6). Mounted by `__root.tsx`; each snapshot is
 * written straight into the shared `SUBSHELLS_QUERY_KEY` cache, so the
 * sidebar's status dots, the home cards, and every picker read one live
 * source instead of a snapshot taken at navigation.
 *
 * **It is a WebSocket, and that is the point** (spec 2026-09-19). This was an
 * `EventSource` on `/api/events`, which held one of the browser's SIX
 * HTTP/1.1 connections per origin for the life of the tab — the instance is
 * served over plain http, so there is no HTTP/2 to lift that cap. Three
 * dashboard tabs spent half the pool before any fetch, and six deadlocked it:
 * every request queued behind streams that never end. A WebSocket does not
 * sit in that pool.
 *
 * Auth is the same short-lived single-use ws token the attach path uses (the
 * HttpOnly cookie is not sent on a WS upgrade through the Vite dev proxy), and
 * the token is spent at CONNECT — nothing expires a live socket afterwards, so
 * a reconnect is a dropped connection rather than a clock.
 *
 * `enabled` gates the socket so it never fires its token POST pre-auth (the
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
    let ws: WebSocket | null = null;
    let cancelled = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let attempts = 0;

    /** Arms the next attempt, replacing any pending one so two paths cannot stack. */
    function scheduleReconnect() {
      if (cancelled || reconnectTimer) return;
      const delay = attempts > 1 ? RECONNECT_MAX_MS : RECONNECT_MIN_MS;
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        void connect();
      }, delay);
    }

    async function connect() {
      attempts += 1;
      let token: string;
      try {
        ({ token } = await apiFetch<{ token: string }>("/api/auth/ws-token", { method: "POST" }));
      } catch {
        // Token fetch failed (signed out, backend down). No socket exists, so
        // no close handler will fire — arm the retry here or the feed is over.
        setConnected(false);
        scheduleReconnect();
        return;
      }
      if (cancelled) return;

      const proto = window.location.protocol === "https:" ? "wss" : "ws";
      const socket = new WebSocket(`${proto}://${window.location.host}/ws/live?token=${encodeURIComponent(token)}`);
      ws = socket;

      socket.onmessage = (e) => {
        try {
          const frame = JSON.parse(e.data as string) as { type?: string; subshells?: SubshellView[] };
          if (frame.type !== "snapshot" || !frame.subshells) return;
          queryClient.setQueryData(SUBSHELLS_QUERY_KEY, frame.subshells);
          // Read back, never the parsed frame: `setQueryData` shares the
          // write, so the cache holds the previous array when the snapshot
          // changed nothing and the previous row objects for the rows it did
          // not touch. Handing consumers THAT is what keeps a quiet beat from
          // re-rendering anything.
          setLastList(queryClient.getQueryData<SubshellView[]>(SUBSHELLS_QUERY_KEY) ?? frame.subshells);
          setConnected(true);
          attempts = 0; // a delivered snapshot is what proves the connection good
        } catch {
          // ignore malformed frame
        }
      };
      socket.onclose = () => {
        // Ignore a superseded socket's close: reporting it would clobber the
        // state a newer connection has already set.
        if (ws !== socket) return;
        ws = null;
        setConnected(false);
        scheduleReconnect();
      };
      // `onerror` is always followed by `onclose`, which owns the retry — this
      // only stops the error surfacing as an unhandled event.
      socket.onerror = () => {};
    }
    void connect();

    return () => {
      cancelled = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      const socket = ws;
      ws = null;
      socket?.close(1000, "provider unmounted");
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
