import { getRequestlessContext } from "@/lib/context.js";
import { type Access, accessAtLeast } from "@/lib/subshell-access.js";
import { replayLineCap } from "@/services/nodes/log-tail.js";
import { getLive } from "@/services/nodes/node-registry.js";
import type { RemoteLauncher } from "@/services/nodes/remote-launcher.js";
import { logger } from "@/utils/logger.js";
import { forensicsEnabled, recordAttachPaint } from "@/ws/attach-forensics.js";
import { captureToReplayText } from "@/ws/capture-text.js";
import {
  captureStable,
  nudgePaneForRepaint,
  persistOutput,
  RESIZE_SETTLE_MS,
  registerViewer,
  type WsData,
  type WsSocket,
  waitForPaneRepaint,
} from "@/ws/subshell-ws.js";
import { SyncStreamStripper } from "@/ws/sync-stripper.js";

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
 * Cycle note: imports `subshell-ws.ts` and is imported by it — both directions
 * consume the other's exports (hoisted functions, types, and the
 * `RESIZE_SETTLE_MS` value) only at call time, by which point both modules
 * have evaluated, so evaluation order never deadlocks.
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

/** The client's fitted terminal size from the attach URL (see `subshell-ws.ts`). */
export interface AttachSize {
  /** Column count the browser terminal rendered at */
  cols: number;
  /** Row count the browser terminal rendered at */
  rows: number;
}

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
  size?: AttachSize | null,
  /** Device label from the connect URL; the remote path never sees the URL. */
  deviceLabel = "Unnamed device",
): Promise<void> {
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
    logFile: "",
    lastSize: 0,
    lastOutputWriteAt: 0,
    // Only `edit`/`owner` may type into the pane; a `view` grantee watches.
    canInput: accessAtLeast(access, "edit"),
    capacity: size ?? undefined,
    // Presence identity: who this viewer is in the `viewers` frame. The id
    // lives as long as the socket, so a reconnect is legitimately a new
    // viewer rather than a resurrected one.
    viewerId: crypto.randomUUID(),
    deviceLabel,
    since: new Date().toISOString(),
    cleanup,
  };
  Object.assign(ws.data, data);

  try {
    if (!(await launcher.hasSubshell(data.socket, row.id))) {
      ws.close(4004, "subshell not running");
      return;
    }
    if (detached) return;
    // Pane proven alive — claim the subshell's one live viewer slot (the local
    // twin's rule): the previous viewer's width was about to fight this one's.
    registerViewer(ws, row.id);

    // JOIN POINT (the local twin carries the full reasoning): one 1-byte
    // `log_read` for `size`, sampled BEFORE the resize — the tail streams
    // every byte from here, so the client can never miss a diff frame (a
    // desync a diff-rendering TUI can never heal; skipped-overlap it replays
    // is idempotent repaint). A missing/empty log reads size 0 and the tail
    // still arms (the agent tolerates a log pipe-pane has not created yet).
    const logStart = (await launcher.readLogSized(row.id, 0, 1)).size;
    if (detached) return;

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
        await launcher.resize(data.socket, row.id, size.cols, size.rows);
        // Wait for the pane's TUI to repaint at the new geometry (burst of
        // fresh log bytes, then quiet) — a flat settle captures tmux's
        // re-wrapped approximation of the OLD frame — and when no burst comes
        // (a no-op resize fires no SIGWINCH), force one. The local twin
        // carries the full reasoning. Improves the first paint only;
        // correctness lives in the gap-free join above.
        // `logStart` is the pre-resize size (the local twin's reasoning): the
        // baseline a repaint must grow past, so a fast repaint still counts.
        repainted = await waitForPaneRepaint(sizeOf, { baseline: logStart });
        if (!repainted && !detached) {
          nudged = true;
          repainted = await nudgePaneForRepaint(launcher, data.socket, row.id, size.cols, size.rows, sizeOf);
        }
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
      // the same refusal the probe path uses — nothing after it can stream)
      ws.close(4004, "subshell not running");
      return;
    }
    // Trailing terminator stripped, no cursor restored — the local twin's
    // reasoning (kept from b76a22f).
    const painted = captureToReplayText(replay);
    ws.send(JSON.stringify({ type: "replay", data: painted }));
    recordAttachPaint({ subshellId: row.id, preResize, replay: painted, repainted, nudged });
    if (detached) return;

    // Per-connection decode/strip state, mirroring the local twin:
    // `stream: true` keeps a multi-byte char split across reads intact, and
    // the stripper holds a DEC-2026 marker split across a read boundary until
    // its other half arrives (see ws/sync-stripper.ts).
    const decoder = new TextDecoder();
    const stripper = new SyncStreamStripper();
    disposer = await launcher.tailStart(row.id, crypto.randomUUID(), logStart, (bytes) => {
      // Spec §3.4: a browser that cannot keep up is cut, not queued into —
      // its reconnect replays fresh. (Measured on the server send queue.)
      const lag = (ws.raw as RawWithBackpressure | undefined)?.getBufferedAmount?.() ?? 0;
      if (lag > CLIENT_LAG_LIMIT_BYTES) {
        ws.close(1011, "client too slow");
        return;
      }
      const text = stripper.push(decoder.decode(bytes, { stream: true }));
      if (!text) return; // nothing paintable yet — the whole read is held
      ws.send(JSON.stringify({ type: "output", data: text }));
      persistOutput(ws, data);
    });
    if (detached) disposer(); // vanished during the tail_start round-trip
  } catch (err) {
    // Anything after open that throws (rpc drop, malformed answer): tear the
    // tail down (idempotent — cleanup may already have run) and close. The
    // disposer's tail_stop stays fire-and-forget inside the launcher.
    cleanup();
    logger.withError(err).warn(`remote terminal relay failed for subshell ${row.id}`);
    ws.close(1011, "relay failed");
  }
}
