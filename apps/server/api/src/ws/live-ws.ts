import { getRequestlessContext } from "@/lib/context.js";
import { logger } from "@/utils/logger.js";
import { consumeWsToken } from "@/ws/ws-token.js";

/** How often the snapshot is re-sent. */
export const LIVE_SNAPSHOT_INTERVAL_MS = 1500;

/** The socket surface this module needs — a narrow view of Elysia's `ElysiaWS`. */
export interface LiveWsSocket {
  data: { query?: Record<string, string> };
  send(data: string): unknown;
  close(code?: number, reason?: string): void;
}

/** Everything the handler touches, injectable so the tests need no server. */
export interface LiveWsDeps {
  /** Redeems the single-use attach token; null when absent, stale or already spent. */
  consumeToken(token: string): string | null;
  /** The viewer's visible subshells — the SHARING-AWARE list, never the owner-only one. */
  listSubshells(userId: string): Promise<unknown[]>;
  /** Snapshot cadence; a parameter only so tests need not sleep for seconds. */
  intervalMs: number;
}

/** Per-socket state, so `close` can stop what `open` started. */
const live = new WeakMap<LiveWsSocket, { stop(): void }>();

/**
 * The dashboard's live feed (spec 2026-09-19), replacing the `/api/events`
 * SSE stream.
 *
 * **Why a WebSocket rather than the SSE stream it replaces.** A browser allows
 * six HTTP/1.1 connections per origin, shared across every tab of that origin,
 * and the instance is served over plain http so there is no HTTP/2 to lift the
 * cap. An `EventSource` holds one of those six for as long as the tab is open:
 * three dashboard tabs spent half the pool before any fetch, and six deadlocked
 * it. A WebSocket does not sit in that pool.
 *
 * Auth is unchanged from the stream it replaces: the browser cannot send its
 * HttpOnly cookie on a WS upgrade (and the Vite dev proxy does not forward
 * Cookie headers there), so the client redeems a single-use 30 s token minted
 * by the cookie-only `POST /api/auth/ws-token`. That mint being cookie-only is
 * what keeps a bearer credential — a subshell's own key included — off this
 * socket; nothing here re-decides it.
 *
 * This step is a TRANSPORT swap and nothing more: the frame is the same full
 * snapshot on the same cadence, built by the same sharing-aware
 * `SubshellsService.listSubshells` that `GET /api/subshells` answers with. The
 * owner-only `SubshellManagerService.listSubshells` must never back it — those
 * two disagreeing is what made an admin's rows flicker in and out on
 * 2026-09-03. Events replace the cadence in the next step.
 */
export function handleLiveOpen(ws: LiveWsSocket, deps: LiveWsDeps): void {
  const token = ws.data.query?.token;
  const userId = token ? deps.consumeToken(token) : null;
  if (!userId) {
    ws.close(4001, "unauthorized");
    return;
  }

  let timer: ReturnType<typeof setInterval> | null = null;
  const stop = (): void => {
    if (timer) clearInterval(timer);
    timer = null;
    live.delete(ws);
  };

  const tick = async (): Promise<void> => {
    let frame: string;
    try {
      frame = JSON.stringify({ type: "snapshot", subshells: await deps.listSubshells(userId) });
    } catch (err) {
      // A list read failing is not a reason to drop a client — the next tick
      // very likely succeeds, and the alternative is a dashboard that
      // disconnects on one slow query.
      logger.withError(err).debug("live ws: snapshot failed; keeping the socket");
      return;
    }
    try {
      ws.send(frame);
    } catch {
      // Sending into a socket that has gone away throws, and that is the
      // disconnect signal that always arrives — `close` may not, if the peer
      // vanished. The SSE route this replaces swallowed this together with the
      // list errors above, and that is precisely what kept a feed ticking for a
      // client that had already left, re-listing every subshell (a DB read plus
      // a tmux capture per running pane) into nothing.
      stop();
    }
  };

  live.set(ws, { stop });
  void tick();
  timer = setInterval(() => void tick(), deps.intervalMs);
}

/** Stops this socket's feed. Safe for a socket that never opened one. */
export function handleLiveClose(ws: LiveWsSocket): void {
  live.get(ws)?.stop();
}

/**
 * The production dependencies.
 *
 * Resolved per connection rather than at import: the services hang off the
 * requestless context, and building them at module scope would open the
 * database merely by importing this file — which is what breaks the compiled
 * binary's non-boot subcommands (`subshell-server mcp`).
 */
export function liveWsDeps(): LiveWsDeps {
  return {
    consumeToken: consumeWsToken,
    listSubshells: (userId) => getRequestlessContext().services.subshells.listSubshells(userId),
    intervalMs: LIVE_SNAPSHOT_INTERVAL_MS,
  };
}
