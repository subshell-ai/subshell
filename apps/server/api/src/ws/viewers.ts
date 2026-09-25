/**
 * Who is watching each subshell, and what that means for its pane.
 *
 * A tmux pane has ONE grid, so the moment two devices watch the same subshell
 * something has to choose. This module owns that state — the per-subshell
 * viewer registry, the sizing policy, the output pump registry and the resize
 * queue — while the RULE it applies is `resolveSharedGrid` in
 * `@internal/subshell-protocol`, where the browser can read it too.
 *
 * It exists as its own module because BOTH attach paths need all of it, and
 * having the remote relay import it from the local attach handler was the
 * import cycle between those two files. Nothing here knows how an attach
 * works; the attach paths know about this.
 */

import { DEFAULT_SIZING, resolveSharedGrid, type SizingPolicy, type ViewerPresence } from "@internal/subshell-protocol";
import { encodeFrame, type WireMode } from "@internal/subshell-protocol/wire";
import { getRequestlessContext } from "@/lib/context.js";
import { publishLive } from "@/services/live-bus.js";
import type { NodeLauncher } from "@/services/nodes/node-launcher.js";
import { logger } from "@/utils/logger.js";
import { resetInputHoldsForTests } from "@/ws/input-hold.js";
import { resetInputWindowsForTests } from "@/ws/input-window.js";
import { createGeometryQueue, type PaneGeometry } from "@/ws/pane-geometry.js";
import { createPaneStreamRegistry } from "@/ws/pane-stream.js";

/**
 * Minimal WebSocket surface used by the attach handler (ElysiaWS provides it).
 * `send` takes a string (the JSON mode) or bytes (the CBOR mode): both are
 * what a negotiated and an un-negotiated socket exchange.
 */
export interface WsSocket {
  data: WsData;
  send(data: string | Uint8Array): unknown;
  close(code?: number, reason?: string): void;
  readonly raw?: { request?: { headers: Headers } };
}

/**
 * Per-socket state both attach paths (local here, remote in
 * `remote-subshell-ws.ts`) build and `Object.assign` onto `ws.data`, so
 * `handleSubshellMessage`/`cleanupSubshellWs` serve either kind. Exported for
 * the remote relay; the shape is the contract between the two files.
 */
export interface WsData {
  /** Machine handle for every pane touchpoint (spec §6.3 seam; local in phase 0). */
  launcher: NodeLauncher;
  socket: string;
  subshellId: string;
  /**
   * The node the subshell runs on (`local` for the control-plane host). Wave
   * D keys the plane→node input hold by it — the node-ws-handler's `ready`
   * moment is what re-fires a failed write, so the hold has to know which
   * node's readiness to follow. Both attach paths set it from the row.
   */
  nodeId: string;
  logFile: string;

  /** True when the caller may send terminal input (`edit`/`owner`); a `view` grantee is read-only. */
  canInput: boolean;
  /**
   * True when this socket belongs to the human the row's pushes go to (a
   * cookie identity on their own row) — stashed on `ws.data` by the open
   * handler before either attach path builds its literal, the same channel
   * `attachUserId` uses. The shared message handler lets the first TYPED
   * frame answer the row's unseen push (`ws/unseen-answer.ts`); absent
   * (fakes, pre-stamp frames) answers nothing, which is the safe direction.
   */
  attendsPush?: boolean;
  /**
   * The grid THIS viewer can display, as last reported. One input to the
   * shared-grid decision (`@internal/subshell-protocol`); never applied on its own,
   * because a pane has one size and other devices may be watching it.
   */
  capacity?: { cols: number; rows: number };
  /** Identifies this viewer in the `viewers` frame; lives as long as the socket. */
  viewerId: string;
  /**
   * True while this viewer's page is not being rendered. Set by the client's
   * `visibility` frame; a hidden viewer takes no part in sizing.
   */
  hidden?: boolean;
  /**
   * Set by `cleanupSubshellWs` when the socket closed before the attach
   * had assigned anything to `ws.data`. The attach reads it the moment it
   * assigns, and abandons instead of registering a viewer nothing can ever
   * remove. See the check in `handleSubshellWs`.
   */
  detachedEarly?: boolean;
  /** Human name for the device, from the connect URL (already normalized). */
  deviceLabel: string;
  /** ISO timestamp of the attach, for "watching since" in the devices list. */
  since: string;
  /**
   * The upgrade request's User-Agent, stashed by the `/ws` `upgrade` hook
   * (`ws.raw.request` is absent in Elysia's WS open context). Journal-only —
   * it names the client bundle behind a "still garbled" report.
   */
  attachUa?: string;
  /**
   * The encoding this connection negotiated on its attach URL (`&enc=cbor`,
   * spec 2026-09-21 Wave B). ABSENT means JSON: every socket built before the
   * field existed, every test fake, and every hand-built socket speaks JSON,
   * which is exactly the byte-identical default the negotiation promises. A
   * connection's mode never changes mid-attach: it is a property of the URL
   * the client dialed, decided once in the attach handlers.
   */
  wireMode?: WireMode;
  /**
   * Whose account this socket authenticated as, stashed by the attach entry
   * point (`handleSubshellWs`) as soon as `resolveAttach` answers, BEFORE the
   * local path registers itself or delegates to the remote relay — the one
   * `ws.data` channel both paths share. Nothing on the attach path reads it;
   * {@link dropTerminalSocketsFor} is its only consumer, because the account
   * behind a live socket is otherwise unanswerable: the registry keys panes,
   * not people, and a disable has to find PEOPLE.
   */
  attachUserId?: string;
  cleanup?: () => void;
}

/**
 * The wire form of one frame for ONE socket: CBOR bytes on a negotiated
 * connection, the exact JSON string every un-negotiated client has always
 * received on the rest. ONE helper because every send on the attach path must
 * make the same decision from the same socket state: a send site that
 * stringifies by hand is the regression that ships a JSON frame into a CBOR
 * client (which the decoder happens to survive as a string, but never as
 * bytes).
 *
 * @param ws - The socket the frame is going to
 * @param frame - The frame object
 * @returns The encoded frame, ready for `ws.send`
 */
export function encodeForSocket(ws: WsSocket, frame: object): string | Uint8Array {
  return ws.data?.wireMode === "cbor" ? encodeFrame(frame) : JSON.stringify(frame);
}

/**
 * Wraps CBOR bytes for {@link WsSocket.send}. Elysia's `ElysiaWS.send`
 * JSON.stringifies EVERY object it is handed that is not a Buffer: a bare
 * `Uint8Array` would leave the socket as a TEXT frame of `{"0":165,...}`,
 * which no CBOR client can read (measured live, 2026-09-21: the first e2e
 * run rendered a negotiated terminal blank while every unit test stayed
 * green, because the fakes record what they are given, not what Elysia does
 * with it). A Buffer VIEW over the same bytes is what Elysia's own
 * `isBuffer` guard passes straight through to Bun's binary send, with no
 * copy.
 * @param bytes - The CBOR-encoded frame
 * @returns The payload to hand to `ws.send`
 */
function wsBinaryPayload(bytes: Uint8Array): Buffer {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

/**
 * Sends one frame to THIS socket, in that socket's own negotiated encoding.
 * Absorbs the send error (socket already gone; its close handler does the
 * bookkeeping), which is the posture every send site here already had.
 * @param ws - The sending socket
 * @param frame - The server frame
 */
export function sendFrame(ws: WsSocket, frame: object): void {
  try {
    const payload = encodeForSocket(ws, frame);
    ws.send(typeof payload === "string" ? payload : wsBinaryPayload(payload));
  } catch {
    // socket already gone; its close handler does the bookkeeping
  }
}

/**
 * One output pump per subshell, shared by every viewer watching it (see
 * `ws/pane-stream.ts`). Both attach paths subscribe to it: the pump's state
 * (decoder, sync stripper, log offset) belongs to the SUBSHELL rather than to
 * a socket, which is what lets several devices watch one pane and see
 * byte-identical chunks in the same order.
 */
export const paneStreams = createPaneStreamRegistry();

/**
 * How each subshell's grid is decided, while anyone is watching it.
 *
 * Deliberately in memory and dropped with the last viewer: a pin names a
 * VIEWER, and viewer ids do not survive a disconnect, so persisting it would
 * only preserve a pin that can never match again.
 */
const sizingPolicies = new Map<string, SizingPolicy>();

/** Last lastOutputAt write per subshell — the heartbeat throttle, stream-lived. */
const lastOutputWrites = new Map<string, number>();

/**
 * Records that a subshell produced output, at most once per 2s, and ANNOUNCES
 * the stamp.
 *
 * Keyed by SUBSHELL, not by socket: the pump is shared now, so a per-viewer
 * throttle would multiply the write rate by the number of devices watching.
 *
 * The announce is not optional. This stamp is what the UI renders as "this
 * pane is printing" (the blinking active dot is derived from `lastOutputAt`
 * against the clock), and under the event-driven feed an unannounced write
 * reaches no client: the row cached in every open tab kept its stale stamp,
 * so a printing pane read idle and never blinked. For a subshell on an agent
 * node this is the ONLY fresh `lastOutputAt` there is (the 60s mtime sweep is
 * LOCAL-ONLY by design), so the dot was doubly dead there. Announcing a
 * per-write would be the spam the feed replaced; the 2s throttle above is
 * what makes this an activity STAMP, and the publisher's per-id coalescing
 * bounds the frames. (Still attached-only: an agent pane nobody is watching
 * relays no output, so its stamp waits for an attach, an act, or a
 * terminate.)
 * @param subshellId - The subshell that produced output
 */
export function persistOutputFor(subshellId: string): void {
  const now = Date.now();
  if (now - (lastOutputWrites.get(subshellId) ?? 0) < 2000) return;
  lastOutputWrites.set(subshellId, now);
  getRequestlessContext()
    .repos.subshells.update(subshellId, { lastOutputAt: new Date().toISOString() })
    .then(() => publishLive({ kind: "subshell.changed", id: subshellId }))
    .catch((err: unknown) => logger.withError(err).warn("failed to persist lastOutputAt"));
}

/**
 * Every socket watching each subshell, keyed by subshell id and then by
 * VIEWER id.
 *
 * Keyed by `viewerId`, never by socket identity: Elysia hands the `close`
 * handler a different wrapper object than `open`, so `delete(ws)` silently
 * missed and every disconnected viewer stayed in the map forever. Measured
 * live — `deleteHit=false` on every close — with two consequences: the pane
 * stayed pinned to the smallest viewer that had EVER attached (it never grew
 * back when a small device left), and the presence list filled with ghosts.
 *
 * This replaces the old one-viewer-per-subshell rule, where a new attach
 * closed the previous one (code 4003) so that a single terminal was the sole
 * size authority. Opening a subshell on a laptop closed it on the phone. The
 * pane's one grid is now arbitrated instead — see `resolveSharedGrid` in
 * `@internal/subshell-protocol` — which needs the whole set, not the newest.
 */
const liveViewers = new Map<string, Map<string, WsSocket>>();

/**
 * Drops every scrap of per-subshell state this module holds, WITHOUT closing
 * any socket. Only for tests.
 *
 * Tests reuse subshell ids across cases, and each of these maps outliving a
 * case corrupts the next one in a way that reads as a product bug rather than
 * a leak — so they are cleared TOGETHER rather than left for each test file
 * to remember:
 *
 * - viewers: a prior case's socket would still be registered.
 * - sizing policy / heartbeat stamps: a pin or a throttle from another case.
 * - pumps: a case that left a subscription open hands the next one a running
 *   stream, whose attach then reuses it and never builds a source at all —
 *   the failure reads as "the tail never started".
 * - applied geometry: a size another case already applied silently swallows
 *   this one's identical request as a no-op, and no resize reaches tmux.
 *
 * @internal
 */
export function resetLiveViewersForTests(): void {
  liveViewers.clear();
  sizingPolicies.clear();
  lastOutputWrites.clear();
  paneStreams.resetForTests();
  geometryQueue.releaseAll();
  // The input windows join this reset: tests reuse subshell ids, and a
  // surviving window would silently drop the next case's id-1 keystroke as an
  // already-written duplicate. The Wave D holds join them for the same
  // reason — a surviving hold would re-fire the previous case's keystroke
  // into the next one's pane.
  resetInputWindowsForTests();
  resetInputHoldsForTests();
}

/**
 * Drops every subshell's remembered pane size. Only for tests, which reuse
 * subshell ids across cases and would otherwise see one case's applied size
 * silently suppress the next case's identical request as a no-op.
 * @internal
 */
export function resetGeometryQueueForTests(ids: string[]): void {
  for (const id of ids) geometryQueue.release(id);
}

/**
 * Sends a frame to every socket currently watching `subshellId`.
 *
 * Use this, not `ws.send`, for anything that describes the PANE: the pane is
 * shared, so a change one viewer caused is news to all of them. The
 * `geometry` frame is the case that bit — sent only to the joiner, it left
 * every incumbent rendering a grid the pane no longer held.
 *
 * The payload is encoded PER MODE, not once: one subshell's viewers can be in
 * BOTH wire modes at once (a tab that negotiated CBOR beside a cached PWA
 * that did not), so the JSON string and the CBOR bytes are each built at most
 * once and handed to the sockets that want them. The encode sits INSIDE the
 * per-viewer try, memoized across same-mode viewers: an encode that throws
 * then costs only that viewer's delivery, exactly like a send to a dead
 * socket already did, and the loop still reaches the viewers after it.
 *
 * @param subshellId - Subshell whose viewers to notify
 * @param frame - The server frame to send
 */
export function broadcastToViewers(subshellId: string, frame: object): void {
  const viewers = liveViewers.get(subshellId);
  if (!viewers) return;
  // Built lazily and at most once per mode: a same-mode audience pays for
  // exactly one encode, the same one-payload economics the old code had.
  let jsonPayload: string | null = null;
  let cborPayload: Uint8Array | null = null;
  // Snapshot: a send can close a socket, and mutating the map mid-iteration
  // would skip the viewer after it.
  for (const viewer of [...viewers.values()]) {
    const wantsCbor = viewer.data?.wireMode === "cbor";
    try {
      if (wantsCbor) {
        cborPayload ??= encodeFrame(frame);
        viewer.send(wsBinaryPayload(cborPayload));
      } else {
        jsonPayload ??= JSON.stringify(frame);
        viewer.send(jsonPayload);
      }
    } catch {
      // socket already gone, or the encode itself refused: this viewer misses
      // this one frame, the way a dead socket already did. The loop continues,
      // so no other viewer ever pays for it.
    }
  }
}

/**
 * Pushes the current viewer list to everyone watching `subshellId`.
 *
 * Per-recipient rather than one shared payload, because each client needs to
 * know WHICH entry is itself (`you`) — a device cannot otherwise tell whether
 * the small viewport holding the pane down is its own.
 *
 * @param subshellId - Subshell whose viewers to notify
 */
export function broadcastViewers(subshellId: string): void {
  const viewers = liveViewers.get(subshellId);
  if (!viewers || viewers.size === 0) return;
  const sockets = [...viewers.values()];
  const presence: ViewerPresence[] = sockets
    .filter((v) => v.data)
    .map((v) => ({
      id: v.data.viewerId,
      label: v.data.deviceLabel,
      capacity: v.data.capacity ?? null,
      since: v.data.since,
      canInput: v.data.canInput,
      hidden: v.data.hidden === true,
    }));
  const policy = sizingPolicies.get(subshellId) ?? DEFAULT_SIZING;
  for (const socket of sockets) {
    if (!socket.data) continue;
    // Per-recipient encoding (this frame carries `you`), through the ONE
    // helper every send on the attach path uses.
    sendFrame(socket, {
      type: "viewers",
      you: socket.data.viewerId,
      viewers: presence,
      sizing: { mode: policy.mode, pinnedViewerId: policy.pinnedViewerId ?? null },
      // The input-ack capability (spec 2026-09-21 Wave A), always true on a
      // current server. It rides this frame rather than a hello of its own
      // because both attach paths broadcast it right after the replay, so
      // it reaches the client on the local AND the remote path, and it is
      // the frame most likely to arrive: the replay frame is skipped when
      // the capture fails. An older client ignores the unknown field; an
      // older server omits it and the client keeps fire-and-forget.
      inputAcks: true,
    });
  }
}

/**
 * Re-decides the pane's grid from every attached viewer and asks for it.
 *
 * Called whenever the viewer SET changes (attach, detach) or any viewer
 * reports a new capacity. The answer is a pure function of that set
 * (`resolveSharedGrid`), which is what makes several viewers safe: the same
 * devices always produce the same grid regardless of who spoke last, so the
 * pane cannot bounce between two sizes the way last-writer-wins did.
 *
 * @param subshellId - Subshell whose viewers to poll
 * @param launcher - Launcher owning the pane
 * @param socket - tmux socket for the pane
 */
export function applySharedGeometry(subshellId: string, launcher: NodeLauncher, socket: string): void {
  const grid = sharedGridFor(subshellId);
  if (grid) requestPaneResize(launcher, socket, subshellId, grid.cols, grid.rows);
}

/**
 * The grid every viewer of `subshellId` can display, or null when none has
 * reported a usable one.
 * @param subshellId - Subshell whose viewers to poll
 * @returns The shared grid, or null
 */
export function sharedGridFor(subshellId: string): PaneGeometry | null {
  const viewers = liveViewers.get(subshellId);
  if (!viewers || viewers.size === 0) return null;
  const inputs = [...viewers.values()]
    .filter((v) => v.data)
    .map((v) => ({
      id: v.data.viewerId,
      capacity: v.data.capacity ?? null,
      hidden: v.data.hidden === true,
      // A `view` grantee watches; it does not get to shrink the owner's pane
      // (see the rungs in `resolveSharedGrid`).
      canInput: v.data.canInput,
    }));
  return resolveSharedGrid(inputs, sizingPolicies.get(subshellId) ?? DEFAULT_SIZING);
}

/**
 * The one place a CLIENT resize frame reaches the pane, so requests can
 * neither overlap nor land out of order, and every settled size is announced
 * as fact.
 *
 * It is NOT the pane's only writer: the attach path fits the pane directly
 * before capturing (it must be awaited, and it ends with its own authoritative
 * readback), and the repaint nudge steps the width ±1 and back. Both tell the
 * queue what they did through {@link seedPaneGeometry} — otherwise `applied`
 * describes a size the pane no longer holds and the next matching client
 * request is dropped as a no-op.
 */
const geometryQueue = createGeometryQueue({
  onGeometry: (subshellId, size) => {
    broadcastToViewers(subshellId, { type: "geometry", cols: size.cols, rows: size.rows });
  },
  onError: (err, subshellId) => {
    logger.withError(err).warn(`ws resize failed for ${subshellId}`);
  },
});

/**
 * Asks the queue to put `subshellId`'s pane at `cols`x`rows`.
 * @param launcher - Launcher owning the pane
 * @param socket - tmux socket for the pane
 * @param subshellId - Subshell whose pane to resize
 * @param cols - Requested width in columns
 * @param rows - Requested height in rows
 */
export function requestPaneResize(
  launcher: NodeLauncher,
  socket: string,
  subshellId: string,
  cols: number,
  rows: number,
): void {
  geometryQueue.request(subshellId, cols, rows, {
    apply: (c, r) => launcher.resize(socket, subshellId, c, r),
    read: () => launcher.paneSize(socket, subshellId),
  });
}

/**
 * Sets how a subshell's pane is sized while several devices watch it.
 *
 * In memory, and dropped with the last viewer: a pin names a VIEWER, and
 * viewer ids do not survive a disconnect, so persisting it would only preserve
 * a pin that can never match again.
 *
 * @param subshellId - The subshell
 * @param policy - `auto` (smallest visible viewer) or `pinned` (one decides)
 */
export function setSizingPolicy(subshellId: string, policy: SizingPolicy): void {
  sizingPolicies.set(subshellId, policy);
}

/**
 * Records a pane size this queue did not apply, so its no-op short-circuit
 * stays honest. The attach fit and the repaint nudge both move the pane
 * directly; without this the queue believes a stale size is current and drops
 * the client's next request for the real one.
 * @param subshellId - Subshell whose pane moved
 * @param cols - The size the pane now holds, in columns
 * @param rows - The size the pane now holds, in rows
 */
export function seedPaneGeometry(subshellId: string, cols: number, rows: number): void {
  geometryQueue.seed(subshellId, cols, rows);
}

/**
 * Reads the pane's grid for the attach announcement.
 * @param launcher - Launcher owning the pane
 * @param socket - tmux socket for the pane
 * @param subshellId - Subshell to read
 * @returns The pane's grid, or null when it cannot be read
 */
export async function readPaneGeometry(
  launcher: NodeLauncher,
  socket: string,
  subshellId: string,
): Promise<PaneGeometry | null> {
  try {
    return await launcher.paneSize(socket, subshellId);
  } catch {
    return null;
  }
}

/**
 * The pane's cursor, or null — the same no-throw grammar as
 * {@link readPaneGeometry}. Null ships the replay without its cursor restore,
 * which is the pre-`pane_cursor` behavior: degraded for a cursor near the top
 * of the grid, never a wrong guess.
 */
export async function readPaneCursor(
  launcher: NodeLauncher,
  socket: string,
  subshellId: string,
): Promise<{ x: number; y: number } | null> {
  try {
    return await launcher.paneCursor(socket, subshellId);
  } catch {
    return null;
  }
}

/**
 * Adds a socket to the set watching `subshellId`.
 *
 * MUST be called after `Object.assign(ws.data, data)`: the map is keyed by
 * `ws.data.viewerId`, which does not exist until the context object carries
 * it. Registering earlier keys every viewer under `undefined`, so the second
 * attach evicts the first from the map and the pane is sized for a viewer
 * nobody can see.
 *
 * @param ws - The attached socket, with its `WsData` already assigned
 * @param subshellId - The subshell it is watching
 */
export function registerViewer(ws: WsSocket, subshellId: string): void {
  const viewerId = ws.data?.viewerId;
  if (!viewerId) return;
  const viewers = liveViewers.get(subshellId) ?? new Map<string, WsSocket>();
  viewers.set(viewerId, ws);
  liveViewers.set(subshellId, viewers);
}

/**
 * Close every live browser terminal socket with one code.
 *
 * Used by the self-restart, with 1012 Service Restart — below the 4000 line,
 * which is what makes `use-subshell-ws.ts` retry rather than treat it as a
 * refusal. The maps are NOT cleared here: each socket's own close handler runs
 * `detachViewer`, which is where the rest of the bookkeeping lives, and this
 * process is about to exit anyway.
 *
 * @returns how many sockets were asked to close
 */
export function closeAllViewers(code: number, reason: string): number {
  let closed = 0;
  for (const viewers of liveViewers.values()) {
    for (const ws of viewers.values()) {
      try {
        ws.close(code, reason);
        closed++;
      } catch {
        // A socket already gone is the outcome this wanted anyway.
      }
    }
  }
  return closed;
}

/**
 * Close every terminal socket ONE user holds, with one code.
 *
 * The account-disable drop for browser terminals, the sibling of
 * `dropLiveSocketsFor` in `ws/live-registry.ts`. The live-feed sweep stopped
 * being the whole story the day this module grew `attachUserId`: a terminal
 * socket authenticates at connect and is never re-checked either (the same
 * rule §11.5 records), so a disabled account with a pane open on screen kept
 * streaming it until the tab happened to close.
 *
 * The walk is by WHO attached, not by what they attached to — which is what
 * makes it complete in both directions an owner-enumeration could not be: it
 * finds the user's socket on a pane they merely watch (shared IN, no row
 * ownership involved), and it leaves every OTHER viewer of the disabled
 * user's own panes attached — the disable is the account's, not the
 * bystander's, and closing innocent viewers is collateral, not containment.
 *
 * Like {@link closeAllViewers}, the maps are NOT cleared here: each socket's
 * own close handler runs `detachViewer`, which is where the teardown
 * bookkeeping lives. The close code is the same BELOW-4000 convention — the
 * client retries rather than reporting a refusal, and while the flag stands
 * the retry cannot get far: the mint runs through `authGuard`, and
 * `resolveAttach`'s own paths refuse the disabled account it does reach.
 *
 * @param userId - whose sockets to drop
 * @param reason - the close reason the sockets carry
 * @returns how many sockets were asked to close, for the audit line
 */
export function dropTerminalSocketsFor(userId: string, reason = "account disabled"): number {
  let closed = 0;
  for (const viewers of [...liveViewers.values()]) {
    // Snapshot per pane: closing a socket is expected to run its own close
    // handler, and a `detachViewer` that empties a pane deletes the map we
    // are standing in.
    for (const ws of [...viewers.values()]) {
      if (ws.data?.attachUserId !== userId) continue;
      try {
        ws.close(1012, reason);
        closed++;
      } catch {
        // A socket already gone is the outcome this wanted anyway.
      }
    }
  }
  return closed;
}

/**
 * Removes a viewer and re-settles everything that depended on it.
 *
 * The whole detach bookkeeping lives here rather than in the close handler so
 * that the maps stay private to this module — and because every one of these
 * steps was, at some point, the thing that was forgotten.
 *
 * @param ws - The socket that closed
 */
export function detachViewer(ws: WsSocket): void {
  const subshellId = ws.data?.subshellId;
  const viewerId = ws.data?.viewerId;
  const viewers = subshellId ? liveViewers.get(subshellId) : undefined;
  if (!subshellId || !viewerId || !viewers?.delete(viewerId)) return;

  if (viewers.size === 0) {
    liveViewers.delete(subshellId);
    sizingPolicies.delete(subshellId);
    // The pump is gone with the last viewer, so its throttle stamp is dead
    // weight — and an entry kept here would also suppress the FIRST
    // lastOutputAt write of a subshell re-attached within 2s.
    lastOutputWrites.delete(subshellId);
    // No one is watching, so the remembered "already applied" size must go
    // too: the next attach has to be able to re-assert the same geometry (the
    // pane may have been resized by anything in between), and holding the
    // entry would make that request look like a no-op.
    geometryQueue.release(subshellId);
    return;
  }

  if (!ws.data) return;
  // The pin named THIS viewer, so it no longer names anything.
  // `decideSharedGrid` already falls through to auto for a pin it cannot
  // resolve, so the pane was never wrong — but the policy still rode the
  // presence frame, and the UI faithfully reported "pinned" plus a "Back to
  // automatic" for a pin that had not been in effect since the moment that
  // device closed its tab. A control that lies about the state it controls is
  // worse than no control.
  const policy = sizingPolicies.get(subshellId);
  if (policy?.pinnedViewerId === viewerId) sizingPolicies.delete(subshellId);
  // Someone is still watching, and the pane may have been held small on this
  // viewer's account — re-decide without it so it can grow back.
  applySharedGeometry(subshellId, ws.data.launcher, ws.data.socket);
  broadcastViewers(subshellId);
}
