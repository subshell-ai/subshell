import { apiFetch, errMessage } from "@internal/node-admin";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLiveSubshellsFeed } from "@/hooks/use-live-subshells-feed";
import { SUBSHELL_QUERY_KEY } from "@/lib/query-keys";
import type { SubshellView } from "@/types/subshell";

/**
 * Everything one pane's Preview surface needs (spec §6, §7).
 *
 * Two protocol halves sit behind `startWatch`, and both or neither is the
 * rule: the REST POST opens the pane's ONE screencast bridge on the plane,
 * and the `watch` frame on the live socket registers THIS device as a
 * recipient. The REST half alone starts a bridge whose frames have nowhere
 * to go; a socket attached to a bridge this tab never joined would paint one
 * browser's canvas from another port's. So the frame rides only after the
 * POST answered ok, and a 409 (`watch-port-conflict` among them) stops there
 * with its name rendered, not swallowed.
 *
 * Refusals and revocations are signal-free on the wire (Task 11's ruling):
 * nothing announces a dropped viewer. The dark states are this side's job -
 * the named REST error above, and the canvas's own 5-second stale rule the
 * viewer implements off the arrival clock.
 */

/** One listening socket in the pane's process tree, as the info route answers. */
export interface PreviewPortRow {
  proto: "tcp" | "tcp6";
  port: number;
  pid: number;
}

/** The pane's virtual display, when it has one. */
export interface PreviewScreen {
  display: string;
  rfbPort: number;
}

/** `GET /api/subshells/:id/views`'s always-answering shape. */
export interface PreviewInfo {
  ports: PreviewPortRow[];
  cdpPort: number | null;
  screen: PreviewScreen | null;
  /** Which display process died since launch; only meaningful beside `screen: null`. */
  screenLost?: "Xvfb" | "x11vnc";
  nodeEnabled: boolean;
  reason?: string;
}

/** `POST /:id/views/open`'s answer: the proxy path to point a frame at. */
export interface PreviewOpenResult {
  proxyBase: string;
}

export interface UseSubshellPreview {
  /** The last info answer, or undefined until the first one lands. */
  info: PreviewInfo | undefined;
  infoLoading: boolean;
  /** The info query's own failure text. The route never errors, so this is a network story. */
  error: string | null;
  /** True while this tab holds the watch: the REST bridge and (once the socket answers) the frame registration. */
  watching: boolean;
  /** The refused watch, named (e.g. a `watch-port-conflict`), or null. */
  watchError: string | null;
  openPort: (port: number, serviceId?: string) => Promise<PreviewOpenResult>;
  startWatch: (port?: number) => Promise<void>;
  stopWatch: () => Promise<void>;
  /** Ask for a fresh info answer, throttled to one request per window. */
  refresh: () => void;
}

/** The info poll's floor: at most one request per five-second window (spec §7). */
export const INFO_MIN_MS = 5_000;

/** The one query key for one pane's preview info. */
export function previewInfoQueryKey(id: string): readonly [...typeof SUBSHELL_QUERY_KEY, string, "preview"] {
  return [...SUBSHELL_QUERY_KEY, id, "preview"] as const;
}

/**
 * The preview controller for one pane. The route composes it into
 * `<PreviewSection>`; every verb the surface drives comes from here.
 */
export function useSubshellPreview(id: string, subshell: SubshellView | undefined): UseSubshellPreview {
  const client = useQueryClient();
  const feed = useLiveSubshellsFeed();

  // Throttle anchor: when the last answer was FETCHED (not when it arrived).
  // `refresh()` decides against this, and the queryFn stamps it, so focus
  // events and output bursts can never out-poll one request per window.
  const lastFetchedAt = useRef(0);
  const query = useQuery({
    queryKey: previewInfoQueryKey(id),
    queryFn: async () => {
      lastFetchedAt.current = Date.now();
      return apiFetch<PreviewInfo>(`/api/subshells/${encodeURIComponent(id)}/views`);
    },
    // No row, no question: the page shows a not-found card until then.
    enabled: subshell !== undefined,
  });

  const refresh = useCallback(() => {
    if (Date.now() - lastFetchedAt.current < INFO_MIN_MS) return;
    void client.invalidateQueries({ queryKey: previewInfoQueryKey(id) });
  }, [client, id]);

  // Stable hop over the latest `refresh` for the once-mounted focus listener.
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;

  // Pane focus refetches (spec §7's trigger pair, half one).
  useEffect(() => {
    const onFocus = () => refreshRef.current();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);

  // ...and half two: the row's own output moved, which the live feed writes
  // into `subshell.lastOutputAt`. The same throttle covers both.
  const lastOutputAt = subshell?.lastOutputAt;
  useEffect(() => {
    if (lastOutputAt != null) refreshRef.current();
  }, [lastOutputAt]);

  const [watching, setWatching] = useState(false);
  const [watchError, setWatchError] = useState<string | null>(null);
  // Read inside socket-lifetime effects where a stale state closure would
  // re-send for a watch this tab no longer holds.
  const watchingRef = useRef(false);
  const watchGeneration = useRef(0);
  const currentPane = useRef(id);
  currentPane.current = id;
  const sendRef = useRef(feed.send);
  sendRef.current = feed.send;
  const connected = feed.connected;

  /**
   * A socket that died mid-watch leaves every canvas dark forever unless
   * somebody re-registers. The re-fire on `connected` going true IS the
   * registration path (Task 11's ruling): the wire sends no signal when a
   * subscription silently ends, so the hook asks again with its own truth.
   */
  useEffect(() => {
    if (!connected || !watchingRef.current) return;
    sendRef.current({ type: "watch", id });
  }, [connected, id]);

  const startWatch = useCallback(
    async (port?: number) => {
      const generation = ++watchGeneration.current;
      setWatchError(null);
      try {
        await apiFetch(`/api/subshells/${encodeURIComponent(id)}/views/browser/watch`, {
          method: "POST",
          // An absent port asks the route to fall back to the cached cdpPort.
          body: JSON.stringify(port === undefined ? {} : { port }),
        });
      } catch (err) {
        // The named refusal (watch-port-conflict, the caps, the 400 naming
        // what is missing) renders; no frame goes out, because there is no
        // bridge this tab joined.
        if (generation === watchGeneration.current) setWatchError(errMessage(err, "The watch could not be started."));
        return;
      }
      if (generation !== watchGeneration.current) {
        // A late POST must not revive a closed view or attach the next pane.
        // Release its server interest unless a newer watch still owns this pane.
        if (currentPane.current !== id || !watchingRef.current) {
          void apiFetch(`/api/subshells/${encodeURIComponent(id)}/views/browser/watch`, { method: "DELETE" }).catch(
            () => {},
          );
        }
        return;
      }
      watchingRef.current = true;
      setWatching(true);
      // A false return means the socket is closed; `watching` stays true and
      // the reconnect effect is what re-registers.
      sendRef.current({ type: "watch", id });
    },
    [id],
  );

  const stopWatch = useCallback(async () => {
    watchGeneration.current += 1;
    watchingRef.current = false;
    setWatching(false);
    sendRef.current({ type: "unwatch", id });
    try {
      await apiFetch(`/api/subshells/${encodeURIComponent(id)}/views/browser/watch`, { method: "DELETE" });
    } catch {
      // Idempotent by contract, and a failure means the bridge's own idle
      // timer closes it. Nothing to tell the user: they stopped watching.
    }
  }, [id]);

  // Leaving the page mid-watch releases both halves, and a NAVIGATION to
  // another pane runs this same cleanup for the OLD id. The state reset is
  // the load-bearing part of that second use: React runs the cleanup before
  // the next effects, so the reconnect re-fire below (whose deps include
  // `id`) sees `false` and does not send a `watch` frame for the new pane -
  // a pane this tab never opened a bridge for, since `startWatch` must POST
  // first. Without the reset, navigation rendered a watching pane B whose
  // Stop would DELETE a bridge this tab never joined. The DELETE stays
  // fire-and-forget: the tab is closing the question, not waiting.
  useEffect(
    () => () => {
      watchGeneration.current += 1;
      // The error clears even when there is nothing to release: a refused
      // watch sets its named alert with no live watch behind it, and pane B
      // must never inherit pane A's red line.
      setWatchError(null);
      if (!watchingRef.current) return;
      watchingRef.current = false;
      setWatching(false);
      sendRef.current({ type: "unwatch", id });
      void apiFetch(`/api/subshells/${encodeURIComponent(id)}/views/browser/watch`, { method: "DELETE" }).catch(
        () => {},
      );
    },
    [id],
  );

  const openPort = useCallback(
    (port: number, serviceId?: string) =>
      apiFetch<PreviewOpenResult>(`/api/subshells/${encodeURIComponent(id)}/views/open`, {
        method: "POST",
        body: JSON.stringify(serviceId ? { serviceId } : { port }),
      }),
    [id],
  );

  return useMemo<UseSubshellPreview>(
    () => ({
      info: query.data,
      infoLoading: query.isPending,
      error: query.isError ? errMessage(query.error, "The preview info could not be read.") : null,
      watching,
      watchError,
      openPort,
      startWatch,
      stopWatch,
      refresh,
    }),
    [
      query.data,
      query.isPending,
      query.isError,
      query.error,
      watching,
      watchError,
      openPort,
      startWatch,
      stopWatch,
      refresh,
    ],
  );
}
