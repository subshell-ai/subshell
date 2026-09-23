import { type LiveServerFrame, parseLiveClientFrame } from "@internal/subshell-protocol";
import { getRequestlessContext } from "@/lib/context.js";
import type { SubshellsService } from "@/services/subshells.service.js";
import { logger } from "@/utils/logger.js";
import { registerLiveSocket, unregisterLiveSocket } from "@/ws/live-registry.js";
import { topicsForViewer } from "@/ws/live-topics.js";
import { consumeWsToken, type WsTokenIdentity } from "@/ws/ws-token.js";

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

/**
 * The wire, spelled once: a snapshot row is per-viewer and carries `access`,
 * a broadcast row cannot (one payload, every subscriber). The envelope lives
 * in `@internal/subshell-protocol` so the browser reads the same statement —
 * `ws/live-publisher.ts` is the other half, sending the `subshell` frames.
 */
type LiveFrame = LiveServerFrame<VisibleSubshells[number], never>;

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
  data: {
    query?: Record<string, string>;
    liveStop?: () => void;
    liveViewerId?: string;
    /** True while a previews request is being served — see {@link handleLiveMessage}. */
    liveCapturing?: boolean;
  };
  send(data: string): unknown;
  /**
   * Joins a pub/sub topic (Bun's own, forwarded by Elysia). Optional so a
   * test double may omit it; a socket that cannot subscribe simply receives
   * its snapshot and no events.
   */
  subscribe?(topic: string): unknown;
  /** 1 = OPEN. Absent on hand-rolled doubles, which is read as "still open". */
  readonly readyState?: number;
  close(code?: number, reason?: string): void;
}

/** Everything the handler touches, injectable so the tests need no server. */
export interface LiveWsDeps {
  /** Redeems the single-use attach token; null when absent, stale or already spent. */
  consumeToken(token: string): WsTokenIdentity | null;
  /**
   * The viewer's visible subshells — the SHARING-AWARE list, never the
   * owner-only one. Called WITHOUT previews: see {@link previewsFor}.
   */
  listSubshells(userId: string): Promise<VisibleSubshells>;
  /**
   * Screens for the ids a client asked about, filtered to what it may see.
   * On demand because most pages render no screens at all, and capturing a
   * pane costs a `capture-pane` spawn each.
   */
  previewsFor(userId: string, ids: string[]): Promise<Map<string, string[]>>;
  /** Whether this viewer holds the admin role — decides the `admins` topic. */
  isAdmin(userId: string): Promise<boolean>;
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
 * by `POST /api/auth/ws-token`. The mint is no longer cookie-only — Bearer
 * keys may mint SCOPED attach tokens for one pane — and this socket is exactly
 * where that distinction is enforced: a token carrying a `subshellId` binding
 * is refused here, so the whole-user feed stays reachable only by the human
 * (unscoped) tokens it was always open to. The refusal lives at REDEMPTION,
 * paired with the bind check in `attach-resolve`: both redemption sites read
 * the binding, and minting cannot bypass either.
 *
 * **There is no cadence.** One snapshot at connect — built by the same
 * sharing-aware `SubshellsService.listSubshells` that `GET /api/subshells`
 * answers with, and carrying no screens, since capturing a pane costs a spawn
 * and only the cards draw one — and after that a frame only when something
 * changed, published to the topics this socket subscribed to here. The
 * owner-only `SubshellManagerService.listSubshells` must never back the
 * snapshot: those two disagreeing is what made an admin's rows flicker in and
 * out on 2026-09-03.
 */
export async function handleLiveOpen(ws: LiveWsSocket, deps: LiveWsDeps): Promise<void> {
  const token = ws.data.query?.token;
  const identity = token ? deps.consumeToken(token) : null;
  // A SCOPED token (any Bearer-key mint names one subshell) is refused on
  // this socket outright: this feed carries the caller's WHOLE visible list,
  // which is far wider than the one pane a machine credential was allowed to
  // name. Only unscoped human (cookie-minted) tokens reach it, as always.
  if (!identity || identity.subshellId !== null) {
    ws.close(4001, "unauthorized");
    return;
  }
  const userId = identity.userId;

  let stopped = false;
  const stop = (): void => {
    stopped = true;
    unregisterLiveSocket(ws.data.liveViewerId, ws);
    ws.data.liveStop = undefined;
  };

  // Who this socket belongs to, for the messages it may send later. Stashed
  // rather than re-derived: the token is single-use and already spent.
  ws.data.liveViewerId = userId;
  // Findable by a role change, which must close this socket: the topics below
  // are chosen ONCE, so a demotion would otherwise leave an ex-admin on the
  // instance-wide topic for as long as the tab stays open.
  registerLiveSocket(userId, ws);

  // ARMED BEFORE THE FIRST AWAIT, and that ordering is load-bearing: this
  // handler suspends twice before it sends anything, and a `close` landing in
  // either window would otherwise find no stopper installed and be forgotten.
  // `ws/subshell-ws.ts` carries the same hazard as its `detachedEarly` flag.
  ws.data.liveStop = stop;

  // GUARDED like the snapshot below, and for the same reason: a rejection here
  // used to reject into the plugin's `.catch`, which only logs — leaving a
  // socket that is open, subscribed to nothing, and permanently silent. The
  // client marks itself connected only once a snapshot lands and schedules a
  // reconnect only from `onclose`, so nothing would ever have fired again.
  let isAdmin: boolean;
  try {
    isAdmin = await deps.isAdmin(userId);
  } catch (err) {
    logger.withError(err).warn("live ws: could not resolve the viewer's role; closing so the client reconnects");
    ws.close(1011, "open failed");
    return;
  }
  if (stopped) return;

  /**
   * Subscribe BEFORE the list read, so no event fired during it is missed.
   *
   * The opposite hazard — a snapshot read before an event but delivered after
   * it, clobbering the newer row — is answered on the CLIENT, which keeps any
   * row an event arrived for since this connect. An event is by construction
   * newer than a snapshot whose read began before it, so no sequence number
   * and no server-side buffer are needed (spec 2026-09-19 §4.1a).
   */
  for (const topic of topicsForViewer({ viewerId: userId, isAdmin })) {
    ws.subscribe?.(topic);
  }

  // ONE snapshot, at connect. The 1.5 s cadence is gone: every field it
  // re-sent is written by the 60 s reconcile sweep or by a user action, and
  // both now publish. What the snapshot is FOR is resync — a fresh connect
  // and every reconnect — which is why it stayed when the timer went.
  try {
    const subshells = await deps.listSubshells(userId);
    if (stopped || (ws.readyState !== undefined && ws.readyState !== WS_OPEN)) return;
    sendFrame(ws, { type: "snapshot", subshells });
  } catch (err) {
    // CLOSE, rather than leave it open. The client marks itself connected only
    // once a snapshot lands, and nothing else will arrive to change that — an
    // open socket that never delivered would show as permanently offline with
    // no reconnect scheduled, because no close ever fired. Closing hands the
    // recovery to the client's own bounded backoff.
    logger.withError(err).warn("live ws: initial snapshot failed; closing so the client reconnects");
    ws.close(1011, "snapshot failed");
  }
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
    listSubshells: (userId) =>
      // No previews in the snapshot — the cards ask for those, and every other
      // page would otherwise pay a `capture-pane` per running pane to render
      // none of them.
      getRequestlessContext().services.subshells.listSubshells(userId, { previews: false }),
    previewsFor: (userId, ids) => getRequestlessContext().services.subshells.previewsFor(userId, ids),
    isAdmin: async (userId) => (await getRequestlessContext().repos.userMeta.getRole(userId)) === "admin",
  };
}

/**
 * Ceiling on the screens one message may ask for.
 *
 * A DEFENSIVE bound, not the product rule: the client caps what it asks for to
 * what it is actually showing (`hooks/use-card-previews.ts`), so reaching this
 * means a client that is not ours or one that has drifted. It truncates rather
 * than refusing — an over-long ask still gets most of its screens — which is
 * only acceptable because the client's own cap is the smaller number.
 */
export const MAX_PREVIEW_REQUEST = 60;

/**
 * Handles a client frame. The only thing a client may ask for is screens.
 *
 * Previews are PULLED rather than pushed (spec 2026-09-19 §4.4): the cards are
 * the one surface that renders them, so a page showing none costs nothing, and
 * a card that wants a fresher screen after a change asks again. That keeps the
 * fan-out free of per-socket state — the server holds no watch list, it just
 * answers.
 *
 * The ids are filtered to what this viewer may see by the ordinary visible-set
 * read; an id they cannot see is simply absent from the answer, never refused,
 * so this cannot be used to probe for existence.
 */
export async function handleLiveMessage(ws: LiveWsSocket, raw: unknown, deps: LiveWsDeps): Promise<void> {
  const userId = ws.data.liveViewerId;
  if (!userId) return;
  // Validated by the shared parser, so the shape this accepts is the shape
  // the browser is typed against rather than a second reading of it.
  const frame = parseLiveClientFrame(raw);
  if (!frame) return;

  // A client that received a row it has never seen cannot render it: a
  // broadcast carries no `access`, and inventing one would show edit controls
  // to a `view` grantee. So it asks for the list again instead — cheap, since
  // a snapshot captures no screens.
  if (frame.type === "resync") {
    try {
      const subshells = await deps.listSubshells(userId);
      if (ws.readyState === undefined || ws.readyState === WS_OPEN) {
        sendFrame(ws, { type: "snapshot", subshells });
      }
    } catch (err) {
      logger.withError(err).warn("live ws: resync snapshot failed");
    }
    return;
  }

  const wanted = frame.ids.slice(0, MAX_PREVIEW_REQUEST);
  if (wanted.length === 0) return;
  // ONE capture run per socket at a time. Each id is a `capture-pane` spawn,
  // and a client that asks again before the last answer landed — a filter
  // being typed, a burst of changes — would otherwise multiply that by however
  // many requests are in flight.
  //
  // A dropped ask is not retried, and the client does not re-ask on its own:
  // the trigger that loses to this guard is the per-id ask a change fires, not
  // a change in the set being shown. So the cost of the guard is a screen one
  // beat staler than it could be, which is inside what §4.4 already accepts
  // about pulled previews.
  if (ws.data.liveCapturing) return;
  ws.data.liveCapturing = true;
  try {
    const previews = await deps.previewsFor(userId, wanted);
    for (const [id, lines] of previews) {
      // `liveStop` is cleared by `handleLiveClose`, so its absence is this
      // socket having been closed while the captures ran — `readyState` alone
      // would not see a close the adapter reported without moving it.
      if (!ws.data.liveStop) return;
      if (ws.readyState !== undefined && ws.readyState !== WS_OPEN) return;
      sendFrame(ws, { type: "preview", id, lines });
    }
  } finally {
    ws.data.liveCapturing = false;
  }
}

/** One send, typed against the shared envelope so a frame the browser cannot parse is a type error. */
function sendFrame(ws: LiveWsSocket, frame: LiveFrame): void {
  ws.send(JSON.stringify(frame));
}
