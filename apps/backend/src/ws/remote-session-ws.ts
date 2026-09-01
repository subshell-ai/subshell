import { type Access, accessAtLeast } from "@/lib/session-access.js";
import { LOG_TAIL_BYTES, replayLineCap, replayOffsetFromWindow } from "@/services/nodes/log-tail.js";
import { getLive } from "@/services/nodes/node-registry.js";
import type { RemoteLauncher } from "@/services/nodes/remote-launcher.js";
import { logger } from "@/utils/logger.js";
import { persistOutput, stripSyncMarkers, type WsData, type WsSocket } from "@/ws/session-ws.js";

/**
 * Live-terminal relay for sessions running on an agent node (spec
 * 2026-08-31 §6.5) — the remote twin of the local WS attach in
 * `session-ws.ts`. The browser contract is BYTE-IDENTICAL: one
 * `{"type":"replay","data":...}` frame (current pane grid), then
 * `{"type":"output","data":...}` frames as the tail streams, every outbound
 * string through `stripSyncMarkers`, refusals on close code 4004.
 *
 * The flow (per row): liveness (registry + probe) → capture → replay-window
 * computation over two `log_read` round-trips → `tail_start`. Everything the
 * relay consumes from the launcher is pinned by the launcher's own suite:
 * the agent's `tail_start` RESULT can resolve before its initial catch-up
 * bytes flow (never assume "caught up" at resolve — the launcher's relay
 * queues those bytes itself), gap backfill/dup-clamp live inside
 * {@link RemoteLauncher.tailStart}, so `onChunk` here just ships bytes
 * monotonically. Client input/resize/teardown ride the EXISTING
 * `handleSessionMessage`/`cleanupSessionWs` — attach sets `ws.data` to the
 * same {@link WsData} shape the local path builds.
 *
 * Cycle note: imports `session-ws.ts` and is imported by it — both directions
 * reference hoisted function declarations at call time only, so evaluation
 * order never deadlocks.
 */

/** The row fields the relay consumes (`SessionTable` subset). */
export interface RemoteAttachRow {
  /** Session id (uuid) — also the agent-side log/meta file stem. */
  id: string;
  /** Node the session runs on (never `local` on this path). */
  nodeId: string;
  /** tmux socket name — ignored by the remote launcher, carried in `WsData` for shape honesty. */
  tmuxSocket: string | null;
  /** Per-session replay-line budget (NULL = instance default; readers clamp to [1,200]). */
  terminalReplayLines: number | null;
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
 * UTF-8 decode of one relayed chunk — the same zero-copy `TextDecoder` usage
 * as the local twin (`session-ws.ts` decodes every tail chunk with a fresh
 * decoder; stream-less decode carries no state across calls, so results are
 * byte-identical to `Buffer.toString("utf8")` on every chunk, including
 * split multi-byte sequences).
 */
const utf8 = new TextDecoder();
const decode = (bytes: Uint8Array): string => utf8.decode(bytes);

/**
 * Attaches a browser socket to a session living on an agent node.
 *
 * Refusals: `4004 node offline` (no live connection — checked before any
 * round-trip), `4004 session not running` (probe says dead, or the pane
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
 * @param row - the session row (must name a non-local node)
 * @param launcher - the node's cached {@link RemoteLauncher} (registry-resolved)
 * @param access - the caller's effective access; only `edit`/`owner` may type
 */
export async function attachRemoteSessionWs(
  ws: WsSocket,
  row: RemoteAttachRow,
  launcher: RemoteLauncher,
  access: Access,
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
    sessionId: row.id,
    logFile: "",
    lastSize: 0,
    lastOutputWriteAt: 0,
    // Only `edit`/`owner` may type into the pane; a `view` grantee watches.
    canInput: accessAtLeast(access, "edit"),
    cleanup,
  };
  Object.assign(ws.data, data);

  try {
    if (!(await launcher.hasSession(data.socket, row.id))) {
      ws.close(4004, "session not running");
      return;
    }
    if (detached) return;

    try {
      const capture = await launcher.capture(data.socket, row.id);
      ws.send(JSON.stringify({ type: "replay", data: stripSyncMarkers(capture) }));
    } catch {
      // pane may have just died (the local twin swallows this; remote closes
      // the same refusal the probe path uses — nothing after it can stream)
      ws.close(4004, "session not running");
      return;
    }
    if (detached) return;

    // Replay-window math identical to the local attach: window = last
    // LOG_TAIL_BYTES (the whole log when smaller), start = where the last
    // `cap` lines begin. `size` rides every log_read answer, so the window
    // start costs one 1-byte probe. A missing/empty log reads size 0 → the
    // offset is 0 and the tail still arms (the agent tolerates a log that
    // pipe-pane has not created yet).
    // N is per-session config, falling back to the instance default; the
    // clamp (column predates the API; ceiling is a load guarantee) is the
    // SHARED {@link replayLineCap} — identical math on both attach paths.
    const cap = replayLineCap(row.terminalReplayLines);
    const first = await launcher.readLogSized(row.id, 0, 1);
    const windowStart = Math.max(0, first.size - LOG_TAIL_BYTES);
    const win = await launcher.readLogSized(row.id, windowStart, LOG_TAIL_BYTES);
    const offset = replayOffsetFromWindow(windowStart, decode(win.bytes), cap);
    if (detached) return;

    disposer = await launcher.tailStart(row.id, crypto.randomUUID(), offset, (bytes) => {
      // Spec §3.4: a browser that cannot keep up is cut, not queued into —
      // its reconnect replays fresh. (Measured on the server send queue.)
      const lag = (ws.raw as RawWithBackpressure | undefined)?.getBufferedAmount?.() ?? 0;
      if (lag > CLIENT_LAG_LIMIT_BYTES) {
        ws.close(1011, "client too slow");
        return;
      }
      ws.send(JSON.stringify({ type: "output", data: stripSyncMarkers(decode(bytes)) }));
      persistOutput(ws, data);
    });
    if (detached) disposer(); // vanished during the tail_start round-trip
  } catch (err) {
    // Anything after open that throws (rpc drop, malformed answer): tear the
    // tail down (idempotent — cleanup may already have run) and close. The
    // disposer's tail_stop stays fire-and-forget inside the launcher.
    cleanup();
    logger.withError(err).warn(`remote terminal relay failed for session ${row.id}`);
    ws.close(1011, "relay failed");
  }
}
