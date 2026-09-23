import { getRequestlessContext } from "@/lib/context.js";
import { type Access, accessAtLeast } from "@/lib/subshell-access.js";
import { replayLineCap } from "@/services/nodes/log-tail.js";
import { getLive } from "@/services/nodes/node-registry.js";
import type { RemoteLauncher } from "@/services/nodes/remote-launcher.js";
import { logger } from "@/utils/logger.js";
import { forensicsEnabled, recordAttachPaint } from "@/ws/attach-forensics.js";
import type { AttachParams } from "@/ws/attach-params.js";
import { captureToReplayText } from "@/ws/capture-text.js";
import { captureStable, fitPaneAndRepaint, RESIZE_SETTLE_MS } from "@/ws/pane-repaint.js";
import { createRemoteTailSource } from "@/ws/pane-sources.js";
import type { Subscription } from "@/ws/pane-stream.js";
import {
  applySharedGeometry,
  broadcastToViewers,
  broadcastViewers,
  paneStreams,
  persistOutputFor,
  readPaneGeometry,
  registerViewer,
  sendFrame,
  sharedGridFor,
  type WsData,
  type WsSocket,
} from "@/ws/viewers.js";

/**
 * Live-terminal relay for subshells running on an agent node (spec
 * 2026-08-31 §6.5) — the remote twin of the local WS attach in
 * `subshell-ws.ts`. The browser contract is BYTE-IDENTICAL: one
 * `{"type":"replay","data":...}` frame (pane grid + reflowed history rows),
 * then `{"type":"output","data":...}` frames carrying ONLY bytes appended
 * after the replay was taken, every outbound string marker-stripped, refusals
 * on close code 4004.
 *
 * The flow (per row): liveness (registry + probe) → optional pre-capture
 * resize + settle → `capture` with the replay line cap → one `log_read(0,1)`
 * size probe (AFTER the capture — the tail starts at that EOF and never
 * replays historical log bytes). Everything the
 * relay consumes from the launcher is pinned by the launcher's own suite:
 * the agent's `tail_start` RESULT can resolve before its initial catch-up
 * bytes flow (never assume "caught up" at resolve — the launcher's relay
 * queues those bytes itself), gap backfill/dup-clamp live inside
 * {@link RemoteLauncher.tailStart}, so `onChunk` here just ships bytes
 * monotonically. Client input/resize/teardown ride the EXISTING
 * `handleSubshellMessage`/`cleanupSubshellWs` — attach sets `ws.data` to the
 * same {@link WsData} shape the local path builds.
 *
 * No longer part of an import cycle: everything both attach paths share
 * lives in `ws/viewers.ts` (the registry, sizing and pump), `ws/pane-repaint.ts`
 * and `ws/attach-params.ts`, so this module reaches for those directly instead
 * of into the local attach handler.
 */

/** The row fields the relay consumes (`SubshellTable` subset). */
export interface RemoteAttachRow {
  /** Subshell id (uuid) — also the agent-side log/meta file stem. */
  id: string;
  /** Node the subshell runs on (never `local` on this path). */
  nodeId: string;
  /** tmux socket name — ignored by the remote launcher, carried in `WsData` for shape honesty. */
  tmuxSocket: string | null;
  /** Owning user — whose per-user terminal-history cap governs this attach. */
  userId: string;
}

/**
 * Local structural extension of `WsSocket.raw` for the backpressure probe —
 * Bun's server-side ws exposes `getBufferedAmount`; the shared `WsSocket`
 * type stays deliberately narrow (only this call site needs it).
 */
type RawWithBackpressure = { getBufferedAmount?: () => number };

/** Browser queue depth above which the client is dropped (spec §3.4: a lagging browser reconnects and replays). */
const CLIENT_LAG_LIMIT_BYTES = 4 * 1024 * 1024;

/**
 * Attaches a browser socket to a subshell living on an agent node.
 *
 * Refusals: `4004 node offline` (no live connection — checked before any
 * round-trip), `4004 subshell not running` (probe says dead, or the pane
 * raced away between probe and capture). After open, any relay failure
 * (dropped node socket, malformed answer) tears the tail down and closes
 * `1011`; a browser whose send queue exceeds {@link CLIENT_LAG_LIMIT_BYTES}
 * is closed `1011 client too slow` mid-tail.
 *
 * Disposal is EXACTLY-ONCE by construction: `ws.data.cleanup` is installed
 * before the first await (so a close during any round-trip lands on it), it
 * flags `detached` and calls the late-bound disposer, and the disposer
 * itself is idempotent ({@link RemoteLauncher.tailStart}). If the browser
 * vanishes before `tailStart` resolves, no zombie stream survives: the
 * pending attach disposes immediately on resolve (or returns before arming).
 *
 * @param ws - the browser socket (Elysia WS, narrowed to {@link WsSocket})
 * @param row - the subshell row (must name a non-local node)
 * @param launcher - the node's cached {@link RemoteLauncher} (registry-resolved)
 * @param access - the caller's effective access; only `edit`/`owner` may type
 * @param size - the client's fitted geometry; when present the pane is
 *   resized (and given {@link RESIZE_SETTLE_MS} to repaint) BEFORE the
 *   capture, so the replay matches the geometry the client renders into
 */
export async function attachRemoteSubshellWs(
  ws: WsSocket,
  row: RemoteAttachRow,
  launcher: RemoteLauncher,
  access: Access,
  /**
   * Everything the client declared on the connect URL, as ONE value.
   *
   * The relay never sees the URL itself, and taking these one positional
   * argument at a time is exactly how `hidden` came to be missing here while
   * the local twin had it — a phone attached to a node subshell while
   * backgrounded then counted as a visible viewer for its whole life. A
   * struct makes the next omission a type error instead.
   */
  params: AttachParams,
): Promise<void> {
  const { size, deviceLabel, hidden, wireMode } = params;
  if (!getLive(row.nodeId)) {
    ws.close(4004, "node offline");
    return;
  }

  // Teardown state, armed BEFORE the first await: a close event during any
  // round-trip runs `cleanup`, and whatever eventually resolves knows it is
  // too late (detached) and cleans itself up.
  let detached = false;
  let disposer: (() => void) | undefined;
  const cleanup = (): void => {
    detached = true;
    disposer?.();
  };

  // The WsData the shared message/close handlers read. Mirrors the local
  // attach's shape — except `logFile`, which honestly stays "": the remote
  // path never opens a local file (tail bytes ride `log_read`/`output`
  // frames) and neither shared handler reads the field, so the node-side
  // path (`launcher.logPath`) has no consumer here — filling it after the
  // Object.assign below would not even reach `ws.data` (review-wave trap).
  // `socket` carries the row's tmux name (the remote launcher ignores it,
  // like every other member).
  const data: WsData = {
    launcher,
    socket: row.tmuxSocket ?? "",
    subshellId: row.id,
    // Always an agent node on this path — the local twin sets `local`. Wave D
    // keys the plane→node input hold by it.
    nodeId: row.nodeId,
    logFile: "",
    // Only `edit`/`owner` may type into the pane; a `view` grantee watches.
    canInput: accessAtLeast(access, "edit"),
    capacity: size ?? undefined,
    hidden,
    // Presence identity: who this viewer is in the `viewers` frame. The id
    // lives as long as the socket, so a reconnect is legitimately a new
    // viewer rather than a resurrected one.
    viewerId: crypto.randomUUID(),
    deviceLabel,
    since: new Date().toISOString(),
    // The encoding the client negotiated on its connect URL (`&enc=cbor`),
    // same rule as the local twin: one connection, one mode; absent means
    // JSON, byte-identical to before the negotiation existed.
    wireMode,
    cleanup,
  };
  Object.assign(ws.data, data);
  // The browser left while the node registry was being consulted — see the
  // local twin: its close found nothing to undo, so registering now would
  // strand a viewer that can never be removed.
  if (ws.data.detachedEarly) return;
  // AFTER the assign: the registry is keyed by `ws.data.viewerId`, which does
  // not exist until the context object carries it.
  registerViewer(ws, row.id);

  try {
    if (!(await launcher.hasSubshell(data.socket, row.id))) {
      ws.close(4004, "subshell not running");
      return;
    }
    if (detached) return;

    // JOIN POINT (the local twin carries the full reasoning): one 1-byte
    // `log_read` for `size`, sampled BEFORE the resize — the tail streams
    // every byte from here, so the client can never miss a diff frame (a
    // desync a diff-rendering TUI can never heal; skipped-overlap it replays
    // is idempotent repaint). A missing/empty log reads size 0 and the tail
    // still arms (the agent tolerates a log pipe-pane has not created yet).
    const logStart = (await launcher.readLogSized(row.id, 0, 1)).size;
    if (detached) return;

    // Attach to the subshell's shared pump BEFORE the pane is read — the
    // local twin's ordering, and here it is also a hard requirement rather
    // than an optimization: `NodeLauncher`'s contract forbids overlapping
    // per-subshell pumps, so two viewers each running their own `tailStart`
    // over one pane is two independent dup-clamp/backfill states on one byte
    // stream. Each device could observe a different order and neither would
    // be authoritative. The subscription starts QUEUED; nothing is delivered
    // until the replay has been sent.
    const stream: Subscription = paneStreams.subscribe(
      row.id,
      () =>
        createRemoteTailSource({
          launcher,
          subshellId: row.id,
          fromByte: logStart,
          onOutput: () => persistOutputFor(row.id),
        }),
      (text) => {
        // Spec §3.4: a browser that cannot keep up is cut, not queued into —
        // its reconnect replays fresh. (Measured on the server send queue.)
        const lag = (ws.raw as RawWithBackpressure | undefined)?.getBufferedAmount?.() ?? 0;
        if (lag > CLIENT_LAG_LIMIT_BYTES) {
          ws.close(1011, "client too slow");
          return;
        }
        // Encoded in THIS socket's negotiated mode: the same helper the local
        // twin's sink uses, so a mode can never be decided twice.
        sendFrame(ws, { type: "output", data: text });
      },
    );
    disposer = () => stream.close();

    // The pane as the viewer found it — forensics only, and only when armed
    // (an extra capture RPC). The local twin carries the reasoning.
    const preResize = forensicsEnabled() ? await captureStable(launcher, data.socket, row.id, 0) : null;

    // Fit the pane to the viewer BEFORE anything reads it — the local twin's
    // pre-capture resize, relayed as one RPC. A failure here is not fatal
    // (stale geometry beats a refused attach); the capture right after dies
    // with its own refusal if the node actually went away.
    let repainted = false;
    let nudged = false;
    if (size) {
      const sizeOf = async (): Promise<number> => (await launcher.readLogSized(row.id, 0, 1)).size;
      try {
        // The pane is fitted to what EVERY viewer can display, not to the
        // joiner's own size — the local twin's rule, and the remote path was
        // the half that never got it: a phone attaching to a node subshell a
        // laptop was already watching applied its own 60x20 unconditionally,
        // so the pane bounced between the two exactly as it did before
        // eviction was removed.
        const fit = sharedGridFor(row.id) ?? size;
        // Fit, detect the TUI's real repaint (a burst of fresh log bytes —
        // a flat settle captures tmux's re-wrapped approximation of the OLD
        // frame), and when no burst comes force one. One shared sequence with
        // the local twin, which carries the full reasoning. Improves the
        // first paint only; correctness lives in the gap-free join above.
        const outcome = await fitPaneAndRepaint(launcher, data.socket, row.id, fit, sizeOf, {
          baseline: logStart,
          canNudge: () => !detached,
          // The local twin's rule: a pane with no output yet gets the fit and
          // nothing else — the winch storm duplicates a still-booting prompt.
          booting: logStart === 0,
        });
        repainted = outcome.repainted;
        nudged = outcome.nudged;
      } catch (err) {
        logger.withError(err).warn("remote attach: initial resize failed; replay uses the current size");
        await Bun.sleep(RESIZE_SETTLE_MS);
      }
      if (detached) return;
    }

    // N is the OWNER's per-user setting (Account → Terminal history), falling
    // back to the instance default — the local twin's rule; the clamp
    // (ceiling is a load guarantee) is the SHARED {@link replayLineCap} —
    // identical math on both attach paths.
    // The capture carries the visible grid PLUS the last `cap` reflowed
    // history rows; historical log bytes are never re-played. One capture —
    // the gap-free stream above corrects any raced frame (local twin).
    const cap = replayLineCap(await getRequestlessContext().repos.userMeta.getTerminalReplayLines(row.userId));
    const replay = await captureStable(launcher, data.socket, row.id, cap);
    if (replay === null) {
      // pane may have just died (the local twin swallows this; remote closes
      // the same refusal the probe path uses — nothing after it can stream).
      // Tear the subscription down HERE rather than trusting the platform to
      // deliver a close event for a socket we just closed ourselves: the pump
      // is armed before the capture (the join-point rule), so a refusal after
      // it would otherwise leave a tail running for a viewer that never was.
      cleanup();
      ws.close(4004, "subshell not running");
      return;
    }
    // The pane's CONFIRMED grid, announced to every viewer before the
    // replay so the capture is painted onto a grid they already agree
    // with. Null means the pane died between the fit and here, and a
    // dying pane gets no announcement — there is no second meaning to
    // disambiguate any more, because every machine can measure.
    const attachGeometry = await readPaneGeometry(launcher, data.socket, row.id);
    if (attachGeometry) {
      broadcastToViewers(row.id, { type: "geometry", cols: attachGeometry.cols, rows: attachGeometry.rows });
    }

    const painted = captureToReplayText(replay);
    sendFrame(ws, { type: "replay", data: painted });
    recordAttachPaint({ subshellId: row.id, preResize, replay: painted, repainted, nudged });
    if (detached) return;

    // Deliver: flush what the pump held while the replay was being taken,
    // then stream live. Decode/strip state lives in the SOURCE, not here —
    // per-viewer copies would each see only part of the byte stream and burn
    // characters split across a read boundary to U+FFFD.
    stream.open();
    // Presence LAST, like the local twin: a joiner appears to the others once
    // it is actually receiving, and its own first list already includes it.
    broadcastViewers(row.id);
    // Re-decide now the attach is over — the local twin's reasoning: this
    // path resized the pane DIRECTLY and seeded the queue behind its back, so
    // a client frame that landed mid-attach could have been applied and then
    // undone. Idempotent when nothing raced (the queue drops a request for
    // the size it already holds), so the quiet case costs nothing.
    applySharedGeometry(row.id, launcher, data.socket);
    if (detached) stream.close();
  } catch (err) {
    // Anything after open that throws (rpc drop, malformed answer): tear the
    // tail down (idempotent — cleanup may already have run) and close. The
    // disposer's tail_stop stays fire-and-forget inside the launcher.
    cleanup();
    logger.withError(err).warn(`remote terminal relay failed for subshell ${row.id}`);
    ws.close(1011, "relay failed");
  }
}
