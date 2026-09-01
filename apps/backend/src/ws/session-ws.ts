import { type FSWatcher, watch } from "node:fs";
import { getHarness } from "@internal/harnesses";
import { parseClientFrame } from "@internal/session-protocol";
import { TERMINAL_REPLAY_LINES } from "@/constants.js";
import { LOCAL_NODE_ID } from "@/db/types/nodes.db-types.js";
import { getRequestlessContext } from "@/lib/context.js";
import { accessAtLeast, loadSessionAccess } from "@/lib/session-access.js";
import { resolveCookieSession } from "@/lib/session-cookie.js";
import { launcherFor } from "@/services/nodes/launcher-registry.js";
import { logReplayStartOffset } from "@/services/nodes/log-tail.js";
import type { NodeLauncher } from "@/services/nodes/node-launcher.js";
import type { RemoteLauncher } from "@/services/nodes/remote-launcher.js";
import { sessionLogPath } from "@/services/nodes/session-paths.js";
import { logger } from "@/utils/logger.js";
import { attachRemoteSessionWs } from "@/ws/remote-session-ws.js";
import { consumeWsToken } from "@/ws/ws-token.js";

/**
 * WebSocket attach endpoint: streams a session's live output to the client
 * and forwards client input to the tmux pane verbatim (send-keys -l).
 *
 * Auth: the `token` query param is the short-lived (30 s), single-use WS
 * attach token minted by `POST /api/auth/ws-token` — NOT the better-auth
 * session token. Attaching requires at least `view` access to the session
 * (spec 2026-08-31 §4): the owner, an admin, or anyone it is shared with. A
 * viewer watches read-only; only `edit`/`owner` may send input (see `canInput`).
 *
 * Output is streamed by tailing the per-session log file (written by
 * pipe-pane) with an initial `capture-pane` replay for current scrollback.
 *
 * A row whose `nodeId` names an agent node (spec §6.5) is delegated whole to
 * `attachRemoteSessionWs` — the browser contract there is byte-identical;
 * everything past the delegation below is the local path.
 *
 * Import note: `session-ws.ts` ↔ `remote-session-ws.ts` is a deliberate
 * cycle (the relay reuses `stripSyncMarkers`/`persistOutput`/the `WsData`
 * shape); both use each other's hoisted function declarations only at call
 * time, so module evaluation order never matters.
 */
export async function handleSessionWs(ws: WsSocket, url: URL): Promise<void> {
  const sessionId = url.searchParams.get("session");
  if (!sessionId) {
    ws.close(4001, "missing session");
    return;
  }

  // Auth: the `token` query param is a short-lived WS token issued by
  // POST /api/auth/ws-token (the frontend authenticates via its HttpOnly
  // cookie on that call). Fall back to reading the session cookie when it
  // reaches us directly (same-host WS without a proxy).
  const tokenParam = url.searchParams.get("token");
  const cookieHeader = ws.raw?.request?.headers.get("cookie") ?? "";

  let userId: string | null = null;
  if (tokenParam) {
    userId = consumeWsToken(tokenParam);
  } else {
    // Same shared extraction as the REST guard — accepts the https
    // `__Secure-` spelling and re-presents it under both names.
    const session = await resolveCookieSession(cookieHeader);
    userId = session?.user.id ?? null;
  }
  if (!userId) {
    ws.close(4001, "unauthorized");
    return;
  }

  const { repos } = getRequestlessContext();
  // Resolve the caller's access to THIS session (a human browser path: admin
  // and shared grants both count). Invisible (absent or unshared) closes with
  // the same 4004 an owner-mismatch used to, so a stranger learns nothing.
  const { row, access } = await loadSessionAccess(
    { sessions: repos.sessions, shares: repos.sessionShares, userMeta: repos.userMeta },
    userId,
    sessionId,
  );
  if (!row || !accessAtLeast(access, "view")) {
    ws.close(4004, "session not found");
    return;
  }

  // spec §6.5: the launcher resolves PER ROW — `local` (the schema default;
  // `nodeId` is NOT NULL) keeps the untouched path below, an agent-node row
  // relays over its node socket and returns. `launcherFor` caches a
  // RemoteLauncher for every non-local id, so the cast restates that registry
  // invariant rather than guessing at the instance.
  const launcher = launcherFor(row.nodeId);
  if (row.nodeId !== LOCAL_NODE_ID) {
    await attachRemoteSessionWs(ws, row, launcher as RemoteLauncher, access);
    return;
  }
  if (!row.tmuxSocket || !(await launcher.hasSession(row.tmuxSocket, row.id))) {
    ws.close(4004, "session not running");
    return;
  }

  const data: WsData = {
    launcher,
    socket: row.tmuxSocket,
    sessionId: row.id,
    logFile: sessionLogPath(row.id),
    lastSize: 0,
    lastOutputWriteAt: 0,
    // Only `edit`/`owner` may type into the pane; a `view` grantee watches.
    canInput: accessAtLeast(access, "edit"),
  };
  // Assign onto the existing Elysia context object (ws.data holds the
  // request context; mutating it keeps both worlds in sync).
  Object.assign(ws.data, data);

  // Replay current pane content, then stream the live log tail.
  const harness = row.harnessId ? getHarness(row.harnessId) : undefined;
  void harness;
  try {
    const replay = await launcher.capture(row.tmuxSocket, row.id);
    ws.send(JSON.stringify({ type: "replay", data: stripSyncMarkers(replay) }));
  } catch {
    // pane may have just died
  }

  const logExists = await Bun.file(data.logFile).exists();
  if (logExists) {
    // Start the tail at the offset where the last N replay lines begin instead
    // of byte 0 — the whole-log replay is what made long sessions crawl.
    // N is per-session config, falling back to the instance default.
    // Clamp again: the column is older than the API and could hold an
    // out-of-band value; the ceiling is a load guarantee, not a preference.
    const stored = row.terminalReplayLines;
    const cap = stored == null ? TERMINAL_REPLAY_LINES : Math.min(200, Math.max(1, Math.trunc(stored)));
    data.lastSize = await logReplayStartOffset(data.logFile, cap);
    startLogTail(ws, data);
  } else {
    logger.info(`ws attach: no log file for ${row.id}, polling pane`);
    startPanePoll(ws, data);
  }
}

/** Minimal WebSocket surface used by the attach handler (ElysiaWS provides it). */
export interface WsSocket {
  data: WsData;
  send(data: string): unknown;
  close(code?: number, reason?: string): void;
  readonly raw?: { request?: { headers: Headers } };
}

/**
 * Per-socket state both attach paths (local here, remote in
 * `remote-session-ws.ts`) build and `Object.assign` onto `ws.data`, so
 * `handleSessionMessage`/`cleanupSessionWs` serve either kind. Exported for
 * the remote relay; the shape is the contract between the two files.
 */
export interface WsData {
  /** Machine handle for every pane touchpoint (spec §6.3 seam; local in phase 0). */
  launcher: NodeLauncher;
  socket: string;
  sessionId: string;
  logFile: string;
  lastSize: number;
  lastOutputWriteAt: number;
  /** True when the caller may send terminal input (`edit`/`owner`); a `view` grantee is read-only. */
  canInput: boolean;
  cleanup?: () => void;
}

/**
 * Strips DEC private mode 2026 (synchronized output) begin/end markers from
 * pane output before it reaches the client.
 *
 * Some TUIs (claude-code's ink renderer among them) open a synchronized
 * update and leave it open until their next redraw — which on an idle prompt
 * can be a full second later. xterm 6 honors the mode by withholding all
 * painting until the closing marker or its 1000ms safety timeout, so every
 * keystroke echo visually lands one second late. Tearing without the mode is
 * what every pre-2026 terminal has lived with for decades; a guaranteed
 * 1s paint gate is the worse trade.
 *
 * Measured on a claude-code session: keystroke→paint ~1010 ms with the
 * markers, 1–30 ms without them. Every byte this endpoint sends outbound
 * (replay, live tail, pane-poll fallback) passes through here — do not
 * reintroduce the markers anywhere on that path.
 */
// The markers are built at runtime so no control-character literal appears
// in source (biome's noControlCharactersInRegex); plain split/join also beats
// a regex here.
const ESC = String.fromCharCode(27);
const SYNC_BEGIN = `${ESC}[?2026h`;
const SYNC_END = `${ESC}[?2026l`;

export function stripSyncMarkers(s: string): string {
  if (!s.includes("2026")) return s;
  return s.split(SYNC_BEGIN).join("").split(SYNC_END).join("");
}

/**
 * Persists the session's lastOutputAt when new output arrives, throttled to
 * at most one DB write per 2s (drives the active/idle heuristic).
 * Exported so the remote relay (`remote-session-ws.ts`) keeps the heuristic
 * byte-identical for agent-node sessions — one throttle, both paths.
 */
export function persistOutput(_ws: WsSocket, data: WsData): void {
  const now = Date.now();
  if (now - data.lastOutputWriteAt < 2000) return;
  data.lastOutputWriteAt = now;
  getRequestlessContext()
    .repos.sessions.update(data.sessionId, { lastOutputAt: new Date().toISOString() })
    .catch((err: unknown) => logger.withError(err).warn("failed to persist lastOutputAt"));
}

/** Safety net for missed watch events (file replaced under the watch, quota). */
const TAIL_BACKSTOP_MS = 1000;

/**
 * Streams new log file appends to the WS client.
 *
 * Event-driven: `fs.watch` (inotify on Linux) fires the moment pipe-pane
 * appends, so a keystroke's echo arrives immediately rather than waiting for
 * the next tick of a poll — polling at 250ms quantized every echo to 0–250ms.
 * A slow interval remains only as a backstop for lost watch events; both
 * paths share this size-based read, so delivery is identical either way.
 */
function startLogTail(ws: WsSocket, data: WsData): void {
  // spec §6.5: phase 2 routes local + remote tails through NodeLauncher.tailStart
  // Watch events and the backstop can land together; `pumping`/`again`
  // serialize the reads so a byte is never sliced twice.
  let pumping = false;
  let again = false;

  async function pump(): Promise<void> {
    if (pumping) {
      again = true;
      return;
    }
    pumping = true;
    do {
      again = false;
      try {
        const size = (await Bun.file(data.logFile).stat()).size;
        if (size > data.lastSize) {
          const buf = await Bun.file(data.logFile).slice(data.lastSize, size).arrayBuffer();
          data.lastSize = size;
          ws.send(JSON.stringify({ type: "output", data: stripSyncMarkers(new TextDecoder().decode(buf)) }));
          persistOutput(ws, data);
        }
      } catch {
        // file gone
      }
    } while (again);
    pumping = false;
  }

  let watcher: FSWatcher | null = null;
  try {
    watcher = watch(data.logFile, () => void pump());
    // If the inode dies the watcher is dead weight; the backstop still delivers.
    watcher.on("error", () => {
      watcher?.close();
      watcher = null;
    });
  } catch {
    watcher = null;
  }
  const timer = setInterval(() => void pump(), TAIL_BACKSTOP_MS);
  void pump(); // ship anything written between the replay and the attach
  data.cleanup = () => {
    watcher?.close();
    clearInterval(timer);
  };
}

/** Fallback: poll capture-pane for output (no log file configured). */
function startPanePoll(ws: WsSocket, data: WsData): void {
  let last = "";
  // The capture is async behind the launcher seam; the tick stays fire-and-forget
  // (`void`). Local capture resolves synchronously inside the wrapper, so ticks
  // never overlap in practice.
  async function poll(): Promise<void> {
    try {
      const out = await data.launcher.capture(data.socket, data.sessionId);
      if (out !== last) {
        const delta = out.startsWith(last) ? out.slice(last.length) : out;
        last = out;
        if (delta) {
          ws.send(JSON.stringify({ type: "output", data: stripSyncMarkers(delta) }));
          persistOutput(ws, data);
        }
      }
    } catch {
      // session dead
    }
  }
  const timer = setInterval(() => void poll(), 300);
  data.cleanup = () => clearInterval(timer);
}

/**
 * Client → server frame dispatch.
 *
 * Every client frame is JSON (see `@internal/session-protocol`). Elysia's
 * WebSocket middleware JSON-parses frames that start with `{`, so `message`
 * may arrive as either the raw text or an already-parsed object;
 * `parseClientFrame` accepts both. Anything that is not a valid frame is
 * logged and dropped — it can no longer be mistaken for terminal input.
 */
export function handleSessionMessage(ws: WsSocket, message: string | object): void {
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
  if (frame.type === "resize") {
    void data.launcher.resize(data.socket, data.sessionId, frame.cols, frame.rows).catch(logFailure);
    return;
  }
  // Raw terminal input, forwarded verbatim — but only for callers allowed to
  // type (spec §4.1: input is an `edit` act). A `view` grantee's keystrokes
  // are dropped here; the resize branch above still applies (a view is a
  // legitimate layout action). The client emits one frame per keystroke and
  // already encodes Enter as "\r", so bytes must not be split or terminated.
  if (frame.data) {
    if (!data.canInput) return;
    void data.launcher.sendInput(data.socket, data.sessionId, frame.data).catch(logFailure);
  }
}

/** Stops streaming when the client disconnects. */
export function cleanupSessionWs(ws: WsSocket): void {
  ws.data?.cleanup?.();
}
