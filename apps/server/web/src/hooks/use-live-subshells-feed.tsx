import { apiFetch } from "@internal/node-admin";
import type { LiveClientFrame, LiveServerFrame } from "@internal/subshell-protocol";
import { useQueryClient } from "@tanstack/react-query";
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { SUBSHELL_QUERY_KEY, SUBSHELLS_QUERY_KEY } from "@/lib/query-keys";
import type { SubshellView } from "@/types/subshell";

/**
 * What this feed receives. `Omit<…, "access">` is the wire's own statement
 * rather than a preference: a broadcast reaches every subscriber of a topic,
 * so there is nobody to stamp a per-viewer access for — which is why a row
 * this client has never seen is re-requested instead of rendered.
 */
type LiveFrame = LiveServerFrame<SubshellView, Omit<SubshellView, "access">>;

/** One send, typed against the shared envelope so a frame the server ignores is a type error. */
function send(socket: WebSocket, frame: LiveClientFrame): void {
  socket.send(JSON.stringify(frame));
}

interface LiveSubshellsFeedValue {
  /** True while the `/ws/live` socket is open and delivering. */
  connected: boolean;
  /** The most recent snapshot's list, or null until one has arrived. */
  lastList: SubshellView[] | null;
  /**
   * Asks the server for these subshells' screens.
   *
   * Previews are PULLED (spec 2026-09-19 §4.4): the snapshot carries none,
   * because the cards are the only surface that renders them and capturing a
   * pane costs a `capture-pane` spawn each. The cards call this for what they
   * are showing, and again when a change arrives for one of them. A page
   * showing no cards costs nothing.
   */
  requestPreviews: (ids: string[]) => void;
}

/** Fixed delay before the first reconnect attempt; later ones back off to {@link RECONNECT_MAX_MS}. */
const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 3_000;

const FeedContext = createContext<LiveSubshellsFeedValue>({
  connected: false,
  lastList: null,
  requestPreviews: () => {},
});

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
  // Set by the live effect to the CURRENT socket's sender; a stable callback
  // wraps it so consumers never re-render when the socket is replaced.
  const requestRef = useRef<(ids: string[]) => void>(() => {});
  const requestPreviews = useCallback((ids: string[]) => requestRef.current(ids), []);

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

      // Ids this connection has already heard an EVENT for. The snapshot's read
      // may have begun before such an event, so applying it wholesale would
      // clobber the newer row with an older one — this is the whole of the
      // ordering story, and the reason no sequence number is needed
      // (spec 2026-09-19 §4.1a).
      const liveIds = new Set<string>();
      // Ids this connection has been told it cannot see. A snapshot whose read
      // began BEFORE the removal would otherwise put the row back — `liveIds`
      // protects a changed row from a stale snapshot, and this does the same
      // for a removed one.
      const goneIds = new Set<string>();

      // Rows whose screens this page is showing. Kept so a change to one can
      // re-pull its screen — the server holds no watch list of its own.
      const showing = new Set<string>();
      requestRef.current = (ids: string[]) => {
        showing.clear();
        for (const id of ids) showing.add(id);
        if (ids.length > 0 && socket.readyState === WebSocket.OPEN) {
          send(socket, { type: "previews", ids });
        }
      };

      /**
       * One resync in flight at a time.
       *
       * An Everyone-shared row is in EVERY tab's list, so the one transition
       * that produces a `subshell-recheck` produces it for everybody at once —
       * and a row can earn several asks in a window (a reachability change and
       * a level change are separate reasons). Each ask is a full visible-set
       * read, so they are collapsed: the snapshot that lands answers every
       * question asked before it, because it is read after all of them.
       */
      let resyncPending = false;
      const askForSnapshot = () => {
        if (resyncPending || socket.readyState !== WebSocket.OPEN) return;
        resyncPending = true;
        send(socket, { type: "resync" });
      };

      const commit = (next: SubshellView[]) => {
        queryClient.setQueryData(SUBSHELLS_QUERY_KEY, next);
        // Read back, never the value just written: `setQueryData` shares the
        // write structurally, so unchanged rows keep their object identity and
        // an unchanged list keeps the array's. Handing consumers THAT is what
        // keeps an event nobody is rendering from re-rendering anything.
        setLastList(queryClient.getQueryData<SubshellView[]>(SUBSHELLS_QUERY_KEY) ?? next);
        setConnected(true);
      };

      /**
       * Keeps ONE subshell's own cache entry in step with the list.
       *
       * `/subshells/$id` reads `["subshell", id]`, a different cache from the
       * list's `["subshells"]` — so writing only the list left that page
       * learning nothing after mount once the 5 s poll went. A pane dying
       * while its own page was open, the very thing this design measures at
       * half a second, reached every surface except the one showing it.
       *
       * Written only when the entry EXISTS: creating one for a page nobody
       * opened would fill the cache with rows the detail view never asked
       * for, and the page fetches on mount anyway.
       */
      const syncDetail = (id: string, next: Partial<SubshellView>) => {
        const key = [...SUBSHELL_QUERY_KEY, id];
        const held = queryClient.getQueryData<SubshellView>(key);
        if (!held) return;
        // Same merge the list takes — with one asymmetry worth being precise
        // about. A BROADCAST carries neither this viewer's `access` nor a
        // screen, so the held ones must survive it. A SNAPSHOT row is
        // resolved per viewer and does carry `access`, and there it is
        // authoritative. `??` says exactly that, and nothing else does.
        queryClient.setQueryData(key, {
          ...held,
          ...next,
          access: next.access ?? held.access,
          preview: next.preview ?? held.preview,
        });
      };

      /**
       * The row may no longer be this viewer's to see. Invalidate rather than
       * guess: an ACTIVE detail query refetches and resolves to the honest
       * answer (the row, or the 404 the page renders as not-found), and an
       * inactive one is merely marked stale, so a page nobody is looking at
       * costs nothing.
       */
      const recheckDetail = (id: string) => {
        void queryClient.invalidateQueries({ queryKey: [...SUBSHELL_QUERY_KEY, id] });
      };

      socket.onmessage = (e) => {
        try {
          // The envelope is the server's own (`@internal/subshell-protocol`),
          // so the asymmetry below is a type rather than a convention: a
          // snapshot row carries this viewer's `access`, a broadcast row
          // cannot. A cast, since JSON.parse answers `any` — the frames are
          // still checked field by field before anything is applied.
          const frame = JSON.parse(e.data as string) as Partial<LiveFrame>;
          const current = queryClient.getQueryData<SubshellView[]>(SUBSHELLS_QUERY_KEY) ?? [];

          if (frame.type === "snapshot" && frame.subshells) {
            // Rows this connection already has fresher, event-sourced copies of
            // win over the snapshot; everything else the snapshot decides,
            // including which rows exist at all.
            const kept = new Map(current.filter((r) => liveIds.has(r.id)).map((r) => [r.id, r]));
            // Screens already held are carried across: the snapshot has none
            // (it never captures), so applying it plainly would blank every
            // card until the next pull.
            const screens = new Map(current.filter((r) => r.preview?.length).map((r) => [r.id, r.preview]));
            const settled = frame.subshells
              // A row this connection was told is gone stays gone, whatever
              // a snapshot read before that says.
              .filter((r) => !goneIds.has(r.id))
              .map((r) => {
                const live = kept.get(r.id);
                if (live) return live;
                const preview = screens.get(r.id);
                return preview ? { ...r, preview } : r;
              });
            commit(settled);
            resyncPending = false;
            // The detail page gets what the LIST got, never the raw frame:
            // a stale snapshot's row loses to the event-sourced copy here
            // exactly as it does there, or the two caches disagree about the
            // same subshell until something else moves it.
            for (const row of settled) syncDetail(row.id, row);
            attempts = 0; // a delivered snapshot is what proves the connection good
            // A reconnect re-pulls what this page is showing, since the fresh
            // snapshot's rows are screenless.
            if (showing.size > 0) send(socket, { type: "previews", ids: [...showing] });
            return;
          }

          if (frame.type === "subshell" && frame.id && frame.row) {
            const { id, row } = frame;
            liveIds.add(id);
            // A later statement about this row is by construction NEWER than
            // the removal that put it in `goneIds` — so the removal stops
            // applying. Without this a revoke followed by a re-grant on one
            // live socket left the row permanently invisible: the re-grant
            // broadcast arrives, the client holds nothing, it resyncs, and
            // the snapshot carrying the row is filtered right back out.
            goneIds.delete(id);
            const previous = current.find((r) => r.id === id);
            // `access` is deliberately absent from a broadcast — one payload
            // reaches every subscriber, so it cannot carry a per-viewer stamp.
            // Keep the access this viewer already holds; a row we have never
            // seen has none, and guessing it wrong would show edit controls to
            // a `view` grantee — so ask for the list instead. That is how a
            // NEWLY created subshell reaches an admin or an Everyone grantee,
            // who have no other way to learn it exists now that the polls are
            // gone.
            if (!previous) {
              askForSnapshot();
              return;
            }
            // The screen is not in a broadcast either — keep the one held and
            // ask for a fresh one when this card is on screen.
            const merged = { ...previous, ...row, access: previous.access, preview: previous.preview } as SubshellView;
            commit(current.map((r) => (r.id === id ? merged : r)));
            syncDetail(id, row);
            if (showing.has(id) && socket.readyState === WebSocket.OPEN) {
              send(socket, { type: "previews", ids: [id] });
            }
            return;
          }

          if (frame.type === "preview" && frame.id && Array.isArray(frame.lines)) {
            const { id, lines } = frame;
            const previous = current.find((r) => r.id === id);
            if (!previous) return;
            commit(current.map((r) => (r.id === id ? { ...r, preview: lines } : r)));
            return;
          }

          // "Your access to this row may have changed." Asked rather than
          // asserted for two reasons the server cannot resolve on its own: an
          // Everyone grant ending reaches the people who kept the row
          // alongside those who lost it, and a level change (`edit` → `view`)
          // moves nothing a broadcast can carry. So nothing is dropped here —
          // the snapshot, which IS resolved per viewer, decides.
          //
          // Ignoring it when this client holds no such row bounds the cost of
          // a NAMED change, which is most of them. It buys nothing on the
          // Everyone transition, where by definition every tab holds the row:
          // that one costs one visible-set read per open tab, which is why
          // `askForSnapshot` collapses the asks rather than sending each.
          if (frame.type === "subshell-recheck" && frame.id) {
            // DELIBERATELY does not clear `goneIds`, unlike the `subshell`
            // branch. This frame is a QUESTION, and it is published to
            // `live:everyone` exactly when an Everyone grant ends — so it
            // reaches people who just lost the row as well as those who kept
            // it. Clearing here would re-open the race the set exists for: a
            // named grant revoked (sticky `gone`), then the Everyone grant
            // ended, then a snapshot whose read began before the revoke
            // lands and resurrects the row.
            //
            // Nothing is lost by the asymmetry: a re-GRANT never produces a
            // recheck, it produces a `subshell` broadcast, and that branch
            // clears.
            recheckDetail(frame.id);
            if (!current.some((r) => r.id === frame.id)) return;
            askForSnapshot();
            return;
          }

          if (frame.type === "subshell-gone" && frame.id) {
            const { id } = frame;
            liveIds.add(id);
            goneIds.add(id);
            recheckDetail(id);
            if (!current.some((r) => r.id === id)) return; // never held it; nothing to drop
            commit(current.filter((r) => r.id !== id));
          }
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
  const value = useMemo<LiveSubshellsFeedValue>(
    () => ({ connected, lastList, requestPreviews }),
    [connected, lastList, requestPreviews],
  );

  return <FeedContext.Provider value={value}>{children}</FeedContext.Provider>;
}

/** The root feed's state — read by `useLiveSubshells`; nothing else should need it. */
export function useLiveSubshellsFeed(): LiveSubshellsFeedValue {
  return useContext(FeedContext);
}
