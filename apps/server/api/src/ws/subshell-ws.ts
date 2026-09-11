import { parseClientFrame } from "@internal/subshell-protocol";
import { LOCAL_NODE_ID } from "@/db/types/nodes.db-types.js";
import { getRequestlessContext } from "@/lib/context.js";
import { accessAtLeast } from "@/lib/subshell-access.js";
import { launcherFor } from "@/services/nodes/launcher-registry.js";
import { replayLineCap } from "@/services/nodes/log-tail.js";
import type { RemoteLauncher } from "@/services/nodes/remote-launcher.js";
import { subshellLogPath } from "@/services/nodes/subshell-paths.js";
import { logger } from "@/utils/logger.js";
import { forensicsEnabled, recordAttachPaint } from "@/ws/attach-forensics.js";
import { resolveAttach } from "@/ws/attach-resolve.js";
import { captureToReplayText } from "@/ws/capture-text.js";
import type { PaneGeometry } from "@/ws/pane-geometry.js";
import { captureStable, fitPaneAndRepaint, RESIZE_SETTLE_MS } from "@/ws/pane-repaint.js";
import { createLogTailSource, createPanePollSource } from "@/ws/pane-sources.js";
import type { Subscription } from "@/ws/pane-stream.js";
import { attachRemoteSubshellWs } from "@/ws/remote-subshell-ws.js";
import {
  applySharedGeometry,
  broadcastToViewers,
  broadcastViewers,
  detachViewer,
  paneStreams,
  persistOutputFor,
  readPaneGeometry,
  registerViewer,
  setSizingPolicy,
  sharedGridFor,
  type WsData,
  type WsSocket,
} from "@/ws/viewers.js";

/**
 * WebSocket attach endpoint: streams a subshell's live output to the client
 * and forwards client input to the tmux pane verbatim (send-keys -l).
 *
 * Auth: the `token` query param is the short-lived (30 s), single-use WS
 * attach token minted by `POST /api/auth/ws-token` — NOT the better-auth
 * subshell token. Attaching requires at least `view` access to the subshell
 * (spec 2026-08-31 §4): the owner, an admin, or anyone it is shared with. A
 * viewer watches read-only; only `edit`/`owner` may send input (see `canInput`).
 *
 * Attach paints ONCE: a `capture-pane -e -S -<cap>` replay ships the visible
 * grid plus the last `cap` reflowed history rows — tmux's own rendered text,
 * never historical raw log bytes. The live tail then streams EVERY byte from
 * a join point taken before the resize — a bounded overlap the client
 * replays over the snapshot (idempotent full-row repaints) rather than a gap
 * (skipped diffs desync a diff-renderer permanently; this exact gap was the
 * final "jumbled until you resize" root cause).
 *
 * A row whose `nodeId` names an agent node (spec §6.5) is delegated whole to
 * `attachRemoteSubshellWs` — the browser contract there is byte-identical;
 * everything past the delegation below is the local path.
 *
 * This module is the LOCAL attach and the plugin's three entry points
 * (`handleSubshellWs`, `handleSubshellMessage`, `cleanupSubshellWs`) — the
 * orchestration only. Who is watching and what that means for the pane lives
 * in `ws/viewers.ts`, making a pane repaint in `ws/pane-repaint.ts`, and what
 * a client declared on its URL in `ws/attach-params.ts`. Both attach paths
 * import those three, which is what dissolved the old `subshell-ws` ↔
 * `remote-subshell-ws` import cycle: the relay no longer reaches into the
 * local attach handler for shared machinery.
 */
export async function handleSubshellWs(ws: WsSocket, url: URL): Promise<void> {
  // Who is asking, may they, and about which subshell — one decision, made
  // without touching the socket (see `attach-resolve.ts`). Refusals come back
  // rather than closing there, so every close code is owned here.
  const resolved = await resolveAttach({
    url,
    cookieHeader: ws.raw?.request?.headers.get("cookie") ?? "",
    // `ws.data.attachUa` is stashed by the plugin's `upgrade` hook, because
    // `ws.raw.request` is NOT populated in Elysia's WS open context (that read
    // is the fallback for direct callers, e.g. tests).
    attachUa: ws.data?.attachUa ?? ws.raw?.request?.headers.get("user-agent") ?? "unknown",
  });
  if (!resolved.ok) {
    ws.close(resolved.code, resolved.reason);
    return;
  }
  const { row, access, params } = resolved;

  // spec §6.5: the launcher resolves PER ROW — `local` (the schema default;
  // `nodeId` is NOT NULL) keeps the untouched path below, an agent-node row
  // relays over its node socket and returns. `launcherFor` caches a
  // RemoteLauncher for every non-local id, so the cast restates that registry
  // invariant rather than guessing at the instance.
  const launcher = launcherFor(row.nodeId);
  if (row.nodeId !== LOCAL_NODE_ID) {
    // The WHOLE params struct, not a hand-picked few: this call site is where
    // `hidden` went missing for node panes, because it took each input as its
    // own positional argument and one of them was simply never added.
    await attachRemoteSubshellWs(ws, row, launcher as RemoteLauncher, access, params);
    return;
  }
  if (!row.tmuxSocket || !(await launcher.hasSubshell(row.tmuxSocket, row.id))) {
    ws.close(4004, "subshell not running");
    return;
  }

  // A close can land while this handler still awaits (resize settle + the
  // quiet-poll can span ~1 s), so the disposer is installed BEFORE the first
  // await and flags `detached` — the remote relay's guard, ported here. The
  // end of the attach calls it again if the client already left, so a
  // watcher/timer armed after the close is released immediately.
  let detached = false;
  const data: WsData = {
    launcher,
    socket: row.tmuxSocket,
    subshellId: row.id,
    logFile: subshellLogPath(row.id),
    // Only `edit`/`owner` may type into the pane; a `view` grantee watches.
    canInput: accessAtLeast(access, "edit"),
    // This viewer's own capacity, from the connect URL. One input to the
    // shared decision below — never applied on its own.
    capacity: params.size ?? undefined,
    // Everything the client declared about itself, carried as a set — see
    // `attach-params.ts` for why these travel together rather than one at a
    // time.
    hidden: params.hidden,
    deviceLabel: params.deviceLabel,
    // Presence identity: who this viewer is in the `viewers` frame. The id
    // lives as long as the socket, so a reconnect is legitimately a new
    // viewer rather than a resurrected one.
    viewerId: crypto.randomUUID(),
    since: new Date().toISOString(),
  };
  // Assign onto the existing Elysia context object (ws.data holds the
  // request context; mutating it keeps both worlds in sync).
  Object.assign(ws.data, data);
  // The browser left while we were still looking things up. Its close already
  // ran and found nothing to undo, so nothing here may be armed — returning
  // BEFORE `registerViewer` is what keeps a ghost out of the sizing decision
  // and a pump from running for a reader that does not exist.
  if (ws.data.detachedEarly) return;
  // AFTER the assign: the registry is keyed by `ws.data.viewerId`, which does
  // not exist until the context object carries it.
  registerViewer(ws, row.id);
  ws.data.cleanup = (): void => {
    detached = true;
    data.cleanup?.();
  };

  // JOIN-POINT RULE (learned the hard way, twice): the client attaches at a
  // log offset taken BEFORE the resize, then gets the snapshot plus EVERY
  // byte from that offset on. A diff-rendering TUI (ink and friends) has no
  // resync mechanism: any byte skipped between the snapshot and the stream
  // start leaves the client's screen permanently one-frame out of phase, and
  // every later diff repaints onto the wrong base — the "jumbled until you
  // resize" report, final root cause. A small OVERLAP (the snapshot already
  // contains the frames the stream replays) is self-healing on the next
  // frame — replays of full-row repaints are idempotent; skipped diffs are
  // forever. Hence: size sampled first, never a gap.
  let logStart = 0;
  let hasLog = true;
  try {
    logStart = (await Bun.file(data.logFile).stat()).size;
  } catch {
    hasLog = false;
  }

  // Attach to the subshell's shared pump BEFORE the pane is read. The
  // subscription starts QUEUED, so nothing is delivered until the replay has
  // been sent — but from this instant no byte can be missed, which is the
  // JOIN-POINT RULE above expressed as a subscription instead of an offset a
  // later reader hopes is still current.
  const stream: Subscription = paneStreams.subscribe(
    row.id,
    () =>
      hasLog
        ? // An empty log tails from 0 like any other size; a log that appears
          // LATER is out of reach here (both the stat and the watcher need a
          // file) — the poll fallback covers that pre-existing gap as before.
          createLogTailSource({ logFile: data.logFile, fromByte: logStart, onOutput: () => persistOutputFor(row.id) })
        : createPanePollSource({
            launcher,
            socket: data.socket,
            subshellId: row.id,
            onOutput: () => persistOutputFor(row.id),
          }),
    (text) => ws.send(JSON.stringify({ type: "output", data: text })),
  );
  if (!hasLog) logger.info(`ws attach: no log file for ${row.id}, polling pane`);
  data.cleanup = (): void => stream.close();

  // The pane as the viewer FOUND it — forensics only, and only when the dump
  // is armed (it costs an extra capture). Taken before the resize, it is the
  // evidence that tells "the pane was already holding garbage" apart from
  // "our resize/capture produced it" (see ws/attach-forensics.ts).
  const preResize = forensicsEnabled() ? await captureStable(launcher, row.tmuxSocket, row.id, 0) : null;

  // Fit the pane to the viewer BEFORE anything reads it, then make sure the
  // TUI has actually REPAINTED at that geometry.
  //
  // tmux re-wraps the OLD frame the instant the pane resizes, so a
  // timer-based settle captures a stable-looking grid of mid-word garbage;
  // {@link waitForPaneRepaint} instead detects the app's real SIGWINCH
  // repaint as a byte burst in the log. No burst does NOT mean "idle": a
  // reopen at the size the pane already has makes the resize a no-op, so no
  // SIGWINCH fires and a half-repainted frame stays on screen for every
  // later viewer — {@link nudgePaneForRepaint} forces the repaint here
  // instead of leaving the user to do it by hand with a window resize.
  let repainted = false;
  let nudged = false;
  /** The grid this attach actually asked the pane for, for the announcement below. */
  const _appliedFit: PaneGeometry | null = null;
  if (params.size) {
    const sizeOf = async (): Promise<number> => (await Bun.file(data.logFile).stat()).size;
    try {
      // The pane is fitted to what EVERY viewer can display, not to the
      // joiner's own size: a phone opening a subshell a desktop is already
      // watching must shrink the pane for both, so the capture below matches
      // the grid both of them will render.
      const fit = sharedGridFor(row.id) ?? params.size;
      // `logStart` is the pre-resize size — the baseline a repaint has to grow
      // past. Re-sampling it after the resize would miss a repaint that beat
      // us to the log. Nudge only when the log is a usable signal and someone
      // is still watching: with no log `sizeOf` reads 0 forever, so "no
      // burst" carries no information and a blind nudge would thrash every
      // pane-poll attach. The nudge is handed `fit`, NOT the joiner's own
      // size: it ENDS by resizing the pane to what it is given, and the
      // joiner's size once undid the shared fit — an incumbent at 122x49 was
      // left rendering a pane a 122x52 joiner had claimed.
      const outcome = await fitPaneAndRepaint(launcher, row.tmuxSocket, row.id, fit, sizeOf, {
        baseline: logStart,
        canNudge: () => hasLog && !detached,
      });
      repainted = outcome.repainted;
      nudged = outcome.nudged;
    } catch (err) {
      logger.withError(err).warn("ws attach: initial resize failed; replay uses the current size");
      await Bun.sleep(RESIZE_SETTLE_MS);
    }
  }

  // Replay = visible grid + the last N reflowed history rows, in ONE paint.
  // N is the OWNER's per-user setting (Account → Terminal history), falling
  // back to the instance default; a shared viewer gets the owner's cap because
  // the replay is the owner's pane. The clamp lives in {@link replayLineCap},
  // shared with the remote relay. A SINGLE
  // capture — the stable-grid poll is obsolete now the byte stream is
  // gap-free: a snapshot that races an animating frame is corrected by the
  // very next diff, which the client is guaranteed to receive.
  const cap = replayLineCap(await getRequestlessContext().repos.userMeta.getTerminalReplayLines(row.userId));
  const text = await captureStable(launcher, row.tmuxSocket, row.id, cap);
  // The pane's CONFIRMED grid, announced to every viewer before the
  // replay so the capture is painted onto a grid they already agree
  // with. Null means the pane died between the fit and here, and a
  // dying pane gets no announcement — there is no second meaning to
  // disambiguate any more, because every machine can measure.
  const attachGeometry = await readPaneGeometry(launcher, row.tmuxSocket, row.id);
  if (attachGeometry) {
    broadcastToViewers(row.id, { type: "geometry", cols: attachGeometry.cols, rows: attachGeometry.rows });
  }

  const replay = text != null ? captureToReplayText(text) : null;
  if (replay != null) {
    ws.send(JSON.stringify({ type: "replay", data: replay }));
    recordAttachPaint({ subshellId: row.id, preResize, replay, repainted, nudged });
  }

  // The replay is out; release everything the pane produced while it was
  // being captured, then stream live.
  stream.open();
  // Presence LAST: a joiner should appear to the others once it is actually
  // receiving, and its own first list should already include itself.
  broadcastViewers(row.id);
  // Re-decide now the attach is over.
  //
  // This path resizes the pane DIRECTLY (it must be awaited before the
  // capture) and seeds the queue behind its back, so it can interleave with a
  // concurrent `requestPaneResize` from another viewer: the queue applies G2
  // and records it, this attach's seed then overwrites the record with G1,
  // and the repaint nudge returns the pane to G1 — leaving the pane at G1,
  // the correct shared grid at G2, and nothing scheduled to notice. Two
  // simultaneous attaches reach the same end by another route. Re-deciding
  // here is idempotent (the queue drops a request for the size it already
  // holds), so the quiet case costs nothing.
  applySharedGeometry(row.id, launcher, row.tmuxSocket);
  // Re-wrap (not raw-assign): the close that arrived during the attach awaits
  // must still reach the disposer armed moments ago — `detached` is true by
  // then, so the same wrapper both propagates and immediately tears down.
  ws.data.cleanup = (): void => {
    detached = true;
    data.cleanup?.();
  };
  if (detached) ws.data.cleanup();
}

/**
 * Client → server frame dispatch.
 *
 * Every client frame is JSON (see `@internal/subshell-protocol`). Elysia's
 * WebSocket middleware JSON-parses frames that start with `{`, so `message`
 * may arrive as either the raw text or an already-parsed object;
 * `parseClientFrame` accepts both. Anything that is not a valid frame is
 * logged and dropped — it can no longer be mistaken for terminal input.
 */
export function handleSubshellMessage(ws: WsSocket, message: string | object): void {
  const data = ws.data;
  if (!data?.launcher) return;
  const frame = parseClientFrame(message);
  if (!frame) {
    logger.warn("ws: dropped unrecognized client frame");
    return;
  }
  // Fire-and-forget through the launcher (spec §6.3): local stays sync-fast
  // inside the async wrapper, so the browser socket never waits on tmux. The
  // rejections the old sync try/catch used to log are logged in place — the
  // browser socket must not await, and the promise must not go unhandled.
  const logFailure = (err: unknown) => logger.withError(err).warn("ws input failed");
  if (frame.type === "visibility") {
    // A hidden viewer is excluded from the shared grid, so this changes the
    // pane's size for everyone — backgrounding a phone hands the pane back to
    // the laptops, and showing it takes it again.
    if (data.hidden === frame.hidden) return;
    data.hidden = frame.hidden;
    applySharedGeometry(data.subshellId, data.launcher, data.socket);
    broadcastViewers(data.subshellId);
    return;
  }
  if (frame.type === "set-sizing") {
    // Changing how the pane is sized changes what every viewer sees, so it is
    // an `edit` act — the same gate keystrokes pass, and a `view` grantee's
    // choice is dropped exactly like one.
    if (!data.canInput) return;
    setSizingPolicy(data.subshellId, { mode: frame.mode, pinnedViewerId: frame.viewerId ?? null });
    applySharedGeometry(data.subshellId, data.launcher, data.socket);
    broadcastViewers(data.subshellId);
    return;
  }
  if (frame.type === "resize") {
    // A client re-announces its capacity on every fit, and most of those
    // repeat the value it already reported. Presence is serialized PER
    // RECIPIENT, so forwarding an unchanged number costs every viewer a frame
    // that says nothing.
    const moved = data.capacity?.cols !== frame.cols || data.capacity?.rows !== frame.rows;
    // A client frame reports what THIS viewer can display; it is not an
    // instruction. The pane's size is decided from every attached viewer
    // (`resolveSharedGrid`) and applied through the queue — never straight at
    // the launcher, because two bare `void resize(...)` calls can complete out
    // of order and strand the pane at a superseded size.
    data.capacity = { cols: frame.cols, rows: frame.rows };
    applySharedGeometry(data.subshellId, data.launcher, data.socket);
    // The list shows each device's capacity, and it is what explains the
    // pane's size — so a viewer resizing is a presence change too, when the
    // number actually changed.
    if (moved) broadcastViewers(data.subshellId);
    return;
  }
  // Raw terminal input, forwarded verbatim — but only for callers allowed to
  // type (spec §4.1: input is an `edit` act). A `view` grantee's keystrokes
  // are dropped here; the resize branch above still applies (a view is a
  // legitimate layout action). The client emits one frame per keystroke and
  // already encodes Enter as "\r", so bytes must not be split or terminated.
  if (frame.data) {
    if (!data.canInput) return;
    void data.launcher.sendInput(data.socket, data.subshellId, frame.data).catch(logFailure);
  }
}

/** Stops streaming when the client disconnects. */
export function cleanupSubshellWs(ws: WsSocket): void {
  // The attach is fired unawaited from the plugin's `open` and reaches
  // `Object.assign(ws.data, data)` only after an access lookup and a tmux
  // probe. A close inside that window finds NOTHING to undo — no viewerId to
  // delete, no cleanup to call — and used to return having done nothing at
  // all, after which the attach carried on and registered a viewer for a
  // socket that was already gone and would never close again.
  //
  // Under the old one-viewer rule the next attach evicted that ghost. Now it
  // is permanent: it holds a place in the shared-grid decision, so every
  // other device's pane stays sized for a viewer nobody is looking at, and
  // its subscription keeps the pane's pump running with no reader. Leave a
  // mark instead; the attach checks it the instant it has somewhere to look.
  if (ws.data && !ws.data.viewerId) ws.data.detachedEarly = true;
  detachViewer(ws);
  ws.data?.cleanup?.();
}
