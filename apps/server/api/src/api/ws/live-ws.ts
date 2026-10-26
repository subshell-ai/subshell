import { type LiveServerFrame, parseLiveClientFrame } from "@internal/subshell-protocol";
import { registerLiveSocket, sendPreviewStreamSocket, unregisterLiveSocket } from "@/api/ws/live-registry.js";
import { topicsForViewer } from "@/api/ws/live-topics.js";
import { consumeWsToken, type WsTokenIdentity } from "@/api/ws/ws-token.js";
import { getRequestlessContext } from "@/app/context.js";
import { backupPasswordChangeRequired } from "@/modules/backups/backup-admin-recovery.js";
import { configurePreviewStreamSender, getPreviewBroker } from "@/modules/previews/preview-broker.js";
import { type Access, accessAtLeast, loadSubshellAccess } from "@/modules/subshells/access.js";
import type { SubshellsService } from "@/modules/subshells/subshells.service.js";
import { accountDisabled } from "@/modules/users/account-status.js";
import { logger } from "@/shared/logger.js";

/**
 * The broker's ONE crossing into the socket layer, installed at module load
 * so no `watch` can attach a stream before its serializer exists.
 *
 * The assignment is pure: it constructs nothing, so import stays cheap and
 * the compiled binary's non-boot subcommands are unaffected; the broker
 * itself remains lazy behind `getPreviewBroker()`, called only from the
 * handlers below.
 */
configurePreviewStreamSender(sendPreviewStreamSocket);

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
 * `api/ws/live-publisher.ts` is the other half, sending the `subshell` frames.
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
   * are the same instances across both. `api/ws/subshell-ws.ts` learned this the
   * same way and keys its viewer registry by a generated id for it; the rule
   * is written down in `apps/server/api/AGENTS.md`.
   */
  data: {
    query?: Record<string, string>;
    liveStop?: () => void;
    liveViewerId?: string;
    /** True while a previews request is being served — see {@link handleLiveMessage}. */
    liveCapturing?: boolean;
    /**
     * The socket-lifetime key the preview stream set holds this socket
     * under. `liveViewerId` answers WHO (a user, shared by all their tabs);
     * this answers WHICH SOCKET, because a `watch` subscription belongs to
     * one connection: a reconnect is legitimately a new viewer (the same
     * reasoning `subshell-ws.ts` carries for its viewer id). It rides
     * `data` rather than being the socket object because the object is
     * swapped per callback, see this interface's header.
     */
    streamViewerId?: string;
  };
  /**
   * The underlying socket. Elysia keeps backpressure (`getBufferedAmount`)
   * on the RAW side only, measured in `remote-subshell-ws.ts`; the preview
   * adapter reads the method off this exactly as that file's
   * `RawWithBackpressure` does. Optional so hand-rolled doubles may omit
   * it, which the adapter reads as zero debt.
   */
  raw?: unknown;
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
  /**
   * Whether the viewer's account is DISABLED — the post-redeem re-ask
   * (`attach-resolve` names the race on its token branch; this is the feed's
   * twin). A mint passes `authGuard`, the disable commits, and
   * `dropUserTokensFor` walks the store; a mint whose insert lands AFTER that
   * walk survives the sweep for its whole 30 s life, and `dropLiveSocketsFor`
   * already ran before this socket existed. The store cannot see that; the
   * FLAG cannot be beaten, so redemption re-asks it.
   */
  accountDisabled(userId: string): Promise<boolean>;
  /** Human viewers must finish temporary-password recovery before receiving the feed. */
  passwordChangeRequired(userId: string): Promise<boolean>;
  /**
   * The viewer's access to ONE pane, the whole question a `watch` or
   * `unwatch` asks before touching the preview stream set. A seam because
   * the answer needs the database, and it is the SAME question the REST
   * preview gate asks (`preview-gate` → `loadSubshellAccess`), not a second
   * reading of it: one resolver keeps the two doors of one pane answering
   * identically, which is the whole point of the §11.14 control.
   */
  accessFor(userId: string, paneId: string): Promise<Access>;
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
  // And WHICH socket this is, for the preview stream set a later `watch`
  // joins. Minted here, before any await: the message handler can arrive on
  // a fresh socket immediately, and a key that appears only after some check
  // would silently make the first watch unrevocable by close.
  ws.data.streamViewerId = crypto.randomUUID();
  // Findable so a revocation can reach it: the disable drop is the
  // load-bearing one (a disabled account must not keep streaming, and cannot
  // re-mint), and a role change still closes the socket so the reconnect
  // rebuilds the client's chrome. Since 2026-10-09 the role chooses no feed
  // topics at all, so the role drop is hygiene - see live-registry's header.
  registerLiveSocket(userId, ws);

  // ARMED BEFORE THE FIRST AWAIT, and that ordering is load-bearing: this
  // handler suspends before it sends anything (twice now), and a `close`
  // landing in either window would otherwise find no stopper installed and be
  // forgotten. `api/ws/subshell-ws.ts` carries the same hazard as its
  // `detachedEarly` flag.
  ws.data.liveStop = stop;

  // The DISABLE re-ask, before the role read and before any row is fetched:
  // this is the one redemption path where a token outlives the disable sweep
  // that should have eaten it (`attach-resolve`'s token-branch comment names
  // the check-then-act; the store was walked while this insert was still in
  // flight). The refusal is the same 4001 a bad token gets — a disable is
  // never an enumeration signal. A THROWING re-ask fails CLOSED like the role
  // read below, which is also the correct shape here: unlike a node socket
  // (re-dialed and re-asked by the pre-socket gate), a live feed socket is
  // never re-checked after it opens, so a transient that kept it would keep a
  // missed socket for the tab's whole life; closing costs a reconnect, and
  // the reconnect's fresh mint answers the same question through `authGuard`.
  try {
    if ((await deps.accountDisabled(userId)) || (await deps.passwordChangeRequired(userId))) {
      ws.close(4001, "unauthorized");
      return;
    }
  } catch (err) {
    logger.withError(err).warn("live ws: could not re-ask the account state; closing so the client reconnects");
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
  for (const topic of topicsForViewer({ viewerId: userId })) {
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
  // Stream subscriptions die with the connection, keyed by the
  // socket-lifetime id that `open` minted. The key is read from `data` for
  // the same reason the stopper is: the wrapper `close` receives is not the
  // one that attached. Detaching through the broker rather than a local set
  // is the point: the broker owns the pane-side bookkeeping (per-pane
  // counts, idle-bridge closing) and a close that only edited a local list
  // would strand those. Safe when this socket watched nothing.
  const streamKey = ws.data?.streamViewerId;
  if (streamKey) getPreviewBroker().detachSocketsFor(streamKey);
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
    accountDisabled: (userId) => accountDisabled(getRequestlessContext().db, userId),
    passwordChangeRequired: (userId) => backupPasswordChangeRequired(getRequestlessContext().db, userId),
    // The ordinary gate, exactly as `attach-resolve` and the REST preview
    // gate call it: shares count (a pane's own key never reaches this
    // socket anyway - a scoped token is refused at redemption), roles carry
    // no arm here since 2026-10-09.
    accessFor: async (userId, paneId) => {
      const { repos } = getRequestlessContext();
      const { access } = await loadSubshellAccess(
        { subshells: repos.subshells, shares: repos.subshellShares },
        userId,
        paneId,
      );
      return access;
    },
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
 * Handles a client frame: a screens ask is answered here (pulled), and a
 * `watch`/`unwatch` joins or leaves the broker's pushed screencast fan-out
 * (see {@link handlePreviewSubscription}). Both paths resolve the pane
 * through the ordinary access gate, so the socket can never carry a row or a
 * stream its owner could not fetch over REST.
 *
 * Previews are PULLED rather than pushed (spec 2026-09-19 §4.4): the cards are
 * the one surface that renders them, so a page showing none costs nothing, and
 * a card that wants a fresher screen after a change asks again. That answer
 * path keeps no per-socket state: the server holds no screens list, it just
 * answers. The STREAM path is where subscription state lives, and it lives
 * in the preview broker rather than here: this handler is the broker's one
 * door.
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

  // The screencast subscription verbs. Both gate on the same access question
  // and both answer a refusal with silence: no frame back, no close, no
  // signal a stranger can read as "this pane exists".
  if (frame.type === "watch" || frame.type === "unwatch") {
    await handlePreviewSubscription(ws, userId, frame.type, frame.id, deps);
    return;
  }
  if (frame.type !== "previews") return;

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

/**
 * The raw-socket backpressure shape, restated narrow exactly as
 * `remote-subshell-ws.ts` does: the wrapper carries neither the property nor
 * a method, so the byte-debt the broker checks before every send has to come
 * off `raw`.
 */
type RawWithBackpressure = { getBufferedAmount?: () => number };

/**
 * Joins or leaves one pane's screencast fan-out on behalf of this socket.
 *
 * The gate is the ordinary one (`view` or better through the shared
 * resolver, shares on, roles carrying no arm since 2026-10-09), and every
 * refusal path is silence: the caller's socket keeps streaming its feed, and
 * nothing written here ever closes it. `unwatch` runs the same gate for the
 * same grammar, though its refusal is meaningless to enforce (detaching what
 * is not attached is a no-op); the check just keeps the pair uniform.
 *
 * After the gate, the broker owns everything: the per-pane subscriber cap
 * (its refusal is a RETURNED VALUE plus its own audit row; the socket's
 * experience is a dark canvas, so the value is swallowed here), the
 * slow-viewer byte-debt drop, and the revocation sweep. What crosses to the
 * broker is the narrowest socket it accepts (a send-through plus the raw
 * debt read), keyed by the socket-lifetime id so a close can always find
 * this entry even after its wrapper was swapped.
 */
async function handlePreviewSubscription(
  ws: LiveWsSocket,
  userId: string,
  verb: "watch" | "unwatch",
  paneId: string,
  deps: LiveWsDeps,
): Promise<void> {
  const broker = getPreviewBroker();
  let access: Access = "none";
  try {
    // A sweep cannot detach a subscription that hasn't registered yet. If
    // revocation overtook this read, ask again before attaching. Bound the
    // retries so continuous permission changes cannot hold this task forever.
    for (let attempt = 0; attempt < 3; attempt++) {
      const revision = broker.streamAccessRevision();
      if ((await deps.accountDisabled(userId)) || (await deps.passwordChangeRequired(userId))) return;
      const answer = await deps.accessFor(userId, paneId);
      if (revision === broker.streamAccessRevision()) {
        access = answer;
        break;
      }
    }
  } catch (err) {
    // Fail CLOSED: an unanswered access question is no access. The socket
    // stays open on its feed; the next frame will ask again on its own.
    logger.withError(err).warn("live ws: could not resolve pane access for a watch; treating as none");
    return;
  }
  if (!accessAtLeast(access, "view")) return;
  // The gate suspends, and a close may land in the window: `liveStop` is
  // cleared by `handleLiveClose`, so its absence means this socket is dead
  // and must not join (or leave) a set it can no longer be detached from.
  // Same marker the previews loop below leans on.
  if (!ws.data.liveStop) return;
  const streamKey = ws.data.streamViewerId;
  if (!streamKey) return;
  if (verb === "unwatch") {
    broker.detachStream(paneId, streamKey);
    return;
  }
  broker.attachStream(paneId, streamKey, userId, {
    send: (data) => ws.send(data),
    getBufferedAmount: () => (ws.raw as RawWithBackpressure | undefined)?.getBufferedAmount?.() ?? 0,
  });
  // The return value is the cap's refusal or acceptance, and both end this
  // handler's work identically; the audit trail a refusal writes belongs to
  // the broker, which owns the cap.
}

/** One send, typed against the shared envelope so a frame the browser cannot parse is a type error. */
function sendFrame(ws: LiveWsSocket, frame: LiveFrame): void {
  ws.send(JSON.stringify(frame));
}
