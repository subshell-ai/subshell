import { getRequestlessContext } from "@/lib/context.js";
import type { SubshellsService } from "@/services/subshells.service.js";
import { logger } from "@/utils/logger.js";
import { consumeWsToken } from "@/ws/ws-token.js";

/**
 * Exactly what the sharing-aware list answers with, derived from the method
 * itself rather than restated.
 *
 * The view shape is a local alias inside the service, and this seam must not
 * be the reason it gets exported: deriving it means a change there is a type
 * error HERE, which is the only mechanical guard that the socket and
 * `GET /api/subshells` keep resolving the same thing.
 */
type VisibleSubshells = Awaited<ReturnType<SubshellsService["listSubshells"]>>;

/** How often the snapshot is re-sent. */
export const LIVE_SNAPSHOT_INTERVAL_MS = 1500;

/** `ElysiaWS.readyState` (a getter over `raw.readyState`) when the peer is still there. */
const WS_OPEN = 1;

/** The socket surface this module needs — a narrow view of Elysia's `ElysiaWS`. */
export interface LiveWsSocket {
  /**
   * The request context Elysia spreads onto every socket.
   *
   * **State lives HERE, never on the socket object.** Elysia's bun adapter
   * constructs a fresh `ElysiaWS` wrapper per callback (`new ElysiaWS(ws,
   * context)` in both `open` and `close`, measured on 1.4.29), so the object
   * `close` receives is NOT the one `open` received — while `data` and `raw`
   * are the same instances across both. `ws/subshell-ws.ts` learned this the
   * same way and keys its viewer registry by a generated id for it; the rule
   * is written down in `apps/server/api/AGENTS.md`.
   */
  data: { query?: Record<string, string>; liveStop?: () => void };
  send(data: string): unknown;
  /** 1 = OPEN. Absent on hand-rolled doubles, which is read as "still open". */
  readonly readyState?: number;
  close(code?: number, reason?: string): void;
}

/** Everything the handler touches, injectable so the tests need no server. */
export interface LiveWsDeps {
  /** Redeems the single-use attach token; null when absent, stale or already spent. */
  consumeToken(token: string): string | null;
  /** The viewer's visible subshells — the SHARING-AWARE list, never the owner-only one. */
  listSubshells(userId: string): Promise<VisibleSubshells>;
  /** Snapshot cadence; a parameter only so tests need not sleep for seconds. */
  intervalMs: number;
}

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
  let warnedFailure = false;
  const stop = (): void => {
    if (timer) clearInterval(timer);
    timer = null;
    ws.data.liveStop = undefined;
  };

  const tick = async (): Promise<void> => {
    // The peer going away is the ONE signal that reliably reaches a running
    // tick, and it has to be read rather than caught: on bun 1.4.2 `send()`
    // into a dead socket RETURNS 0, it does not throw. Nor is that return
    // usable as the signal — bun documents 0 as "message dropped", which
    // covers a closed socket AND one shed under backpressure, so acting on it
    // would tear down the feed of a client merely slow on a large snapshot.
    // `readyState` has no such ambiguity.
    if (ws.readyState !== undefined && ws.readyState !== WS_OPEN) {
      stop();
      return;
    }
    let frame: string;
    try {
      frame = JSON.stringify({ type: "snapshot", subshells: await deps.listSubshells(userId) });
    } catch (err) {
      // A list read failing is not a reason to drop a client — the next tick
      // very likely succeeds, and the alternative is a dashboard that
      // disconnects on one slow query. But a feed that fails FOREVER shows
      // the client "offline" while the socket stays open, so say so once:
      // debug is off by default, and once-per-socket rather than once-per-tick
      // keeps a broken instance from spending the log's 200 KB cap on it.
      if (!warnedFailure) {
        warnedFailure = true;
        logger.withError(err).warn("live ws: snapshot failed; socket stays open and will retry");
      }
      return;
    }
    warnedFailure = false;
    ws.send(frame);
  };

  // On `ws.data`, never on `ws` — see {@link LiveWsSocket.data}. Synchronous
  // with the arming below, so no close can land between the two.
  ws.data.liveStop = stop;
  void tick();
  timer = setInterval(() => void tick(), deps.intervalMs);
}

/**
 * Stops this socket's feed. Safe for a socket that never opened one, and safe
 * to call twice.
 *
 * Reads the stopper back off `ws.data` because the wrapper handed to `close`
 * is a different object from the one `open` received — keying anything by the
 * socket here silently finds nothing and leaks the interval for the life of
 * the process.
 */
export function handleLiveClose(ws: LiveWsSocket): void {
  ws.data?.liveStop?.();
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
