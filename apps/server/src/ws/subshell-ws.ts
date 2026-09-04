import { getHarness } from "@internal/harnesses";
import { parseClientFrame } from "@internal/subshell-protocol";
import { LOCAL_NODE_ID } from "@/db/types/nodes.db-types.js";
import { getRequestlessContext } from "@/lib/context.js";
import { resolveCookieSession } from "@/lib/session-cookie.js";
import { accessAtLeast, loadSubshellAccess } from "@/lib/subshell-access.js";
import { launcherFor } from "@/services/nodes/launcher-registry.js";
import { replayLineCap } from "@/services/nodes/log-tail.js";
import type { NodeLauncher } from "@/services/nodes/node-launcher.js";
import type { RemoteLauncher } from "@/services/nodes/remote-launcher.js";
import { subshellLogPath } from "@/services/nodes/subshell-paths.js";
import { logger } from "@/utils/logger.js";
import { forensicsEnabled, recordAttachPaint } from "@/ws/attach-forensics.js";
import { captureToReplayText } from "@/ws/capture-text.js";
import { createGeometryQueue, type PaneGeometry } from "@/ws/pane-geometry.js";
import { createLogTailSource, createPanePollSource } from "@/ws/pane-sources.js";
import { createPaneStreamRegistry, type Subscription } from "@/ws/pane-stream.js";
import { attachRemoteSubshellWs } from "@/ws/remote-subshell-ws.js";
import { consumeWsToken } from "@/ws/ws-token.js";

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
 * Import note: `subshell-ws.ts` ↔ `remote-subshell-ws.ts` is a deliberate
 * cycle (the relay reuses `persistOutput`/the `WsData` shape; marker
 * stripping lives beside both in `sync-stripper.ts`); both use each other's
 * hoisted function declarations only at call time, so module evaluation order
 * never matters.
 */
export async function handleSubshellWs(ws: WsSocket, url: URL): Promise<void> {
  const subshellId = url.searchParams.get("subshell");
  if (!subshellId) {
    ws.close(4001, "missing subshell");
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
  // Resolve the caller's access to THIS subshell (a human browser path: admin
  // and shared grants both count). Invisible (absent or unshared) closes with
  // the same 4004 an owner-mismatch used to, so a stranger learns nothing.
  const { row, access } = await loadSubshellAccess(
    { subshells: repos.subshells, shares: repos.subshellShares, userMeta: repos.userMeta },
    userId,
    subshellId,
  );
  if (!row || !accessAtLeast(access, "view")) {
    ws.close(4004, "subshell not found");
    return;
  }

  // The client's fitted geometry rides the URL so the pane can be resized
  // BEFORE the replay is captured: a capture taken at tmux's 80×24 birth size
  // (or any stale size) re-wraps history rows against the wrong column count,
  // which is exactly the mis-positioned garbage that used to scroll up and
  // stay garbled. Both attach branches consume it.
  const initialSize = parseInitialSize(url);
  // One line per attach makes "still jumbled" reports diagnosable from the
  // journal alone: `geometry WxH` proves the browser's cols/rows survived
  // proxy + plugin handoff; `geometry MISSING` names the remaining culprits
  // (stale client bundle that sends no geometry, or a proxy stripping the
  // WS upgrade query).
  // The UA names the app behind the socket: `geometry MISSING` plus a plain
  // browser UA = a stale PWA bundle that predates the geometry feature (and
  // the paste fixes) — a reload/reinstall is the cure, not a server change.
  // It rides `ws.data.attachUa`, stashed by the plugin's `upgrade` hook,
  // because `ws.raw.request` is NOT populated in Elysia's WS open context
  // (that read is the fallback for direct callers, e.g. tests).
  const ua = ws.data?.attachUa ?? ws.raw?.request?.headers.get("user-agent") ?? "unknown";
  // WHICH BUNDLE is asking. A cached PWA keeps running old JavaScript across
  // any number of server deploys, and static requests are not logged, so
  // "did the client actually load the fix" was unanswerable — the 2026-09-04
  // session burned hours on renderer theories while the phone may never have
  // fetched the new chunk. `build=` is the client's own asset hash, so a
  // reload is visible as a CHANGED id; `build MISSING` is itself the answer,
  // meaning a bundle older than this line.
  const build = parseClientBuild(url);
  logger.info(
    initialSize
      ? `ws attach ${row.id}: geometry ${initialSize.cols}x${initialSize.rows} build=${build} ua="${ua.slice(0, 90)}"`
      : `ws attach ${row.id}: geometry MISSING (stale client predates cols/rows) build=${build} ua="${ua.slice(0, 90)}"`,
  );

  // spec §6.5: the launcher resolves PER ROW — `local` (the schema default;
  // `nodeId` is NOT NULL) keeps the untouched path below, an agent-node row
  // relays over its node socket and returns. `launcherFor` caches a
  // RemoteLauncher for every non-local id, so the cast restates that registry
  // invariant rather than guessing at the instance.
  const launcher = launcherFor(row.nodeId);
  if (row.nodeId !== LOCAL_NODE_ID) {
    await attachRemoteSubshellWs(ws, row, launcher as RemoteLauncher, access, initialSize);
    return;
  }
  if (!row.tmuxSocket || !(await launcher.hasSubshell(row.tmuxSocket, row.id))) {
    ws.close(4004, "subshell not running");
    return;
  }
  evictPreviousViewer(ws, row.id);

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
    lastSize: 0,
    lastOutputWriteAt: 0,
    // Only `edit`/`owner` may type into the pane; a `view` grantee watches.
    canInput: accessAtLeast(access, "edit"),
  };
  // Assign onto the existing Elysia context object (ws.data holds the
  // request context; mutating it keeps both worlds in sync).
  Object.assign(ws.data, data);
  ws.data.cleanup = (): void => {
    detached = true;
    data.cleanup?.();
  };

  const harness = row.harnessId ? getHarness(row.harnessId) : undefined;
  void harness;

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
  if (initialSize) {
    const sizeOf = async (): Promise<number> => (await Bun.file(data.logFile).stat()).size;
    try {
      await launcher.resize(row.tmuxSocket, row.id, initialSize.cols, initialSize.rows);
      // Tell the queue: this fit bypassed it, and a client frame asking for
      // the same size must not then be swallowed as already-applied.
      seedPaneGeometry(row.id, initialSize.cols, initialSize.rows);
      // `logStart` is the pre-resize size — the baseline a repaint has to grow
      // past. Re-sampling it after the resize would miss a repaint that beat
      // us to the log.
      repainted = await waitForPaneRepaint(sizeOf, { baseline: logStart });
      // Nudge only when the log is a usable signal and someone is still
      // watching: with no log `sizeOf` reads 0 forever, so "no burst" carries
      // no information and a blind nudge would thrash every pane-poll attach.
      if (!repainted && hasLog && !detached) {
        nudged = true;
        repainted = await nudgePaneForRepaint(
          launcher,
          row.tmuxSocket,
          row.id,
          initialSize.cols,
          initialSize.rows,
          sizeOf,
        );
      }
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
  const cap = replayLineCap(await repos.userMeta.getTerminalReplayLines(row.userId));
  const text = await captureStable(launcher, row.tmuxSocket, row.id, cap);
  // The trailing terminator still goes (kept from b76a22f): it would land the
  // client one row past the pane's last row, scrolling the viewport out of
  // step with the pane's grid. No cursor is restored — the replay ends where
  // the last captured row ends, which is the bottom of the grid. See
  // {@link captureToReplayText}.
  // The pane's real grid, announced BEFORE the replay: the capture below was
  // taken at whatever size the pane actually holds, which is not necessarily
  // the size this client asked for on the URL (the request can be clamped, or
  // lost). Telling the client first means it paints the capture onto a grid it
  // already agrees with, instead of discovering the mismatch a frame later.
  // Null (a remote pane, an unreadable pane) simply announces nothing and
  // leaves the client sizing itself, exactly as before the readback existed.
  const attachGeometry = await readPaneGeometry(launcher, row.tmuxSocket, row.id);
  if (attachGeometry) {
    ws.send(JSON.stringify({ type: "geometry", cols: attachGeometry.cols, rows: attachGeometry.rows }));
  }

  const replay = text != null ? captureToReplayText(text) : null;
  if (replay != null) {
    ws.send(JSON.stringify({ type: "replay", data: replay }));
    recordAttachPaint({ subshellId: row.id, preResize, replay, repainted, nudged });
  }

  // The replay is out; release everything the pane produced while it was
  // being captured, then stream live.
  stream.open();
  // Re-wrap (not raw-assign): the close that arrived during the attach awaits
  // must still reach the disposer armed moments ago — `detached` is true by
  // then, so the same wrapper both propagates and immediately tears down.
  ws.data.cleanup = (): void => {
    detached = true;
    data.cleanup?.();
  };
  if (detached) ws.data.cleanup();
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
 * `remote-subshell-ws.ts`) build and `Object.assign` onto `ws.data`, so
 * `handleSubshellMessage`/`cleanupSubshellWs` serve either kind. Exported for
 * the remote relay; the shape is the contract between the two files.
 */
export interface WsData {
  /** Machine handle for every pane touchpoint (spec §6.3 seam; local in phase 0). */
  launcher: NodeLauncher;
  socket: string;
  subshellId: string;
  logFile: string;
  lastSize: number;
  lastOutputWriteAt: number;
  /** True when the caller may send terminal input (`edit`/`owner`); a `view` grantee is read-only. */
  canInput: boolean;
  /**
   * The upgrade request's User-Agent, stashed by the `/ws` `upgrade` hook
   * (`ws.raw.request` is absent in Elysia's WS open context). Journal-only —
   * it names the client bundle behind a "still garbled" report.
   */
  attachUa?: string;
  cleanup?: () => void;
}

/**
 * The client geometry a browser passed on the WS URL (`&cols=&rows=`), or
 * null when absent/malformed (older client, manual connect) — the attach then
 * skips the pre-capture resize and behaves the old way.
 */
function parseInitialSize(url: URL): { cols: number; rows: number } | null {
  const cols = Number(url.searchParams.get("cols"));
  const rows = Number(url.searchParams.get("rows"));
  if (Number.isInteger(cols) && cols > 0 && Number.isInteger(rows) && rows > 0) return { cols, rows };
  return null;
}

/** Longest client build id the attach line will print (an asset hash is ~8). */
const MAX_BUILD_ID_LEN = 24;

/**
 * The client's self-reported bundle id (`&build=`) for the attach log line —
 * see the call site for why it exists. Untrusted display data: it is logged,
 * never used for a decision, so it is clamped to
 * {@link MAX_BUILD_ID_LEN} and reduced to a safe alphabet rather than
 * validated against a list of known builds. `MISSING` covers both "no param"
 * and "nothing usable in it", which are the same fact — a client too old to
 * report.
 *
 * @param url - the attach URL
 * @returns the id, or `"MISSING"`
 */
export function parseClientBuild(url: URL): string {
  const raw = (url.searchParams.get("build") ?? "").replace(/[^A-Za-z0-9_.-]/g, "");
  return raw ? raw.slice(0, MAX_BUILD_ID_LEN) : "MISSING";
}

/**
 * Rebuilds the attach URL from the upgrade request's parsed query — the
 * handler consumes it (token auth, and the `cols`/`rows` the pre-capture
 * resize needs). Passing the WHOLE query through is load-bearing: an earlier
 * version re-picked only subshell+token here, silently dropping the geometry
 * and regressing every attach to the stale-width replay (2026-09-01).
 * `URLSearchParams` re-encodes Elysia's already-decoded values exactly once.
 */
export function attachUrlFromQuery(query: Record<string, string>): URL {
  return new URL(`/ws?${new URLSearchParams(query).toString()}`, "http://localhost");
}

/**
 * Grace given to the pane's TUI to repaint after the pre-capture resize —
 * roughly one SIGWINCH frame; the replay that follows then shows the grid at
 * the geometry the client will render it into. Shared with the remote relay
 * so both attach paths paint the same post-resize grid.
 */
export const RESIZE_SETTLE_MS = 150;
/** Poll cadence / quiet-window / hard caps for {@link waitForPaneRepaint}. */
const REPAINT_POLL_MS = 50;
const REPAINT_QUIET_MS = 150;
const REPAINT_DEADLINE_MS = 1500;
/** How long to keep waiting for a repaint burst that never starts. */
const REPAINT_NO_GROWTH_GRACE_MS = 300;
/**
 * The same grace AFTER a nudge. Tighter on purpose: the nudge's SIGWINCH is
 * synchronous for the app, so a repainting TUI starts emitting within tens of
 * ms — waiting the full {@link REPAINT_NO_GROWTH_GRACE_MS} a second time only
 * taxes the panes that were never going to repaint at all.
 */
const NUDGE_NO_GROWTH_GRACE_MS = 150;

/**
 * After a pre-capture resize, wait for the pane's application to REPAINT at
 * the new geometry, detected as fresh bytes in the pipe-pane log (the only
 * signal that distinguishes tmux's instant re-wrap of the OLD frame from the
 * app's real repaint of the new one).
 *
 * Returns once (a) the log grew and then went quiet for {@link
 * REPAINT_QUIET_MS} — the repaint landed, capture is safe — or (b) nothing
 * ever grew within the settle + {@link REPAINT_NO_GROWTH_GRACE_MS} — an idle
 * pane or a non-repainting app, where the re-wrapped grid is all there will
 * ever be and waiting buys nothing — or (c) {@link REPAINT_DEADLINE_MS}
 * elapses mid-busy-stream (the repaint keeps coming; the live tail converges
 * the rest). A no-op resize on a revisit pays ~settle+grace, not the cap.
 *
 * `sizeOf` is the log-size probe: a local `stat` or the relay's 1-byte
 * `log_read` — errors read as size 0 (no log yet behaves like "never grew").
 * Shared by both attach paths so local and node subshells paint identically.
 *
 * @param sizeOf - the log-size probe (see above)
 * @param opts.baseline - the log size sampled BEFORE the resize. Both attach
 *   paths already hold it (it is the join point), and passing it is what
 *   makes a FAST repaint detectable: sampling the baseline here instead would
 *   race the app, counting bytes it already wrote as "the pane was always
 *   this size" and reporting no repaint for a pane that had just repainted
 *   perfectly. Omitted, the baseline is sampled on entry.
 * @param opts.noGrowthGraceMs - how long to keep waiting for a burst that
 *   never starts; {@link nudgePaneForRepaint} passes the tighter
 *   {@link NUDGE_NO_GROWTH_GRACE_MS} for its second wait
 * @returns `true` when the app's repaint burst was observed — the capture that
 *   follows ships the fresh frame — `false` when the log never grew (a no-op
 *   resize that fired no SIGWINCH, an idle pane, or an unresponsive TUI, where
 *   the caller forces a repaint with {@link nudgePaneForRepaint} rather than
 *   capturing a stale, re-wrapped grid).
 */
export async function waitForPaneRepaint(
  sizeOf: () => Promise<number>,
  opts: { baseline?: number; noGrowthGraceMs?: number } = {},
): Promise<boolean> {
  const noGrowthGraceMs = opts.noGrowthGraceMs ?? REPAINT_NO_GROWTH_GRACE_MS;
  const started = Date.now();
  let last: number;
  if (opts.baseline !== undefined) {
    last = opts.baseline;
  } else {
    try {
      last = await sizeOf();
    } catch {
      last = 0;
    }
  }
  let grew = false;
  let quietSince = 0;
  while (Date.now() - started < REPAINT_DEADLINE_MS) {
    await Bun.sleep(REPAINT_POLL_MS);
    const now = Date.now();
    let size = last;
    try {
      size = await sizeOf();
    } catch {
      // stat failed this tick (log vanished mid-attach) — treat as no growth
    }
    if (size !== last) {
      grew = true;
      last = size;
      quietSince = now;
      continue;
    }
    if (!grew) {
      if (now - started >= RESIZE_SETTLE_MS + noGrowthGraceMs) return false;
      continue;
    }
    if (now - quietSince >= REPAINT_QUIET_MS) return true;
  }
  // Deadline elapsed mid-busy-stream: a repaint IS landing (grew), just not
  // yet settled — report it so the caller skips the nudge.
  return grew;
}

/** How long to hold the nudge width before stepping back, so the TUI's first SIGWINCH frame lands. */
const NUDGE_SETTLE_MS = 80;

/**
 * Force a fresh full repaint when the pane stayed silent after the pre-capture
 * resize.
 *
 * A diff-rendering TUI (ink and friends) repaints the WHOLE screen only on
 * SIGWINCH. Two ways that leaves a garbled pane no diff frame ever heals:
 *
 * - **The no-op resize (the reopen case).** `resize-window` to the size the
 *   pane ALREADY has changes nothing, so no SIGWINCH fires. Whatever
 *   half-repainted frame the pane was left holding — e.g. by an earlier
 *   viewer at another width — stays on screen, the capture faithfully ships
 *   it, and the app's later diffs paint onto a base the client never had.
 *   This is exactly the standing report: "close subshell, re-enter, garbled until
 *   I resize the window" (a real width change is the SIGWINCH that finally
 *   forces a full repaint) — and why reopening at the same size never helps
 *   while a manual resize fixes it for good.
 * - **The late repaint.** Under load (a build running in that very pane) the
 *   app's SIGWINCH response can land after {@link waitForPaneRepaint}'s
 *   bound, so the capture catches tmux's instant re-wrap of the OLD frame: a
 *   stable-LOOKING grid of mid-word garbage.
 *
 * Both are cured by making the app repaint NOW. The preferred route is a
 * bare `SIGWINCH` to the pane's process ({@link NodeLauncher.signalPaneWinch}):
 * the app gets the resize signal it waits for while the geometry never moves,
 * so tmux never REFLOWS the pane's history. Only when the machine cannot
 * deliver the signal — or the app stayed silent after it — does the fallback
 * run: bump the width one column, hold it {@link NUDGE_SETTLE_MS}, then step
 * back to the client's real width. Two genuine geometry changes force the
 * same full repaint, but each re-wraps scrollback — which is why the phone
 * that reattaches every minute accumulated duplicate blocks in its history
 * (2026-09-04 report: "still garbled when I scroll up").
 *
 * At call time the pane is reliably at {@link cols}×{@link rows} (the caller
 * only reaches here after a successful resize), so the nudge is relative to
 * that rather than a re-read of the pane's size. Any failure leaves the
 * capture proceeding on the current state — correctness still lives in the
 * gap-free join, and the nudge only improves the first paint — so this never
 * throws.
 *
 * @param launcher - the pane handle (the winch is one call; the fallback
 *   nudge issues two `resize` RPCs)
 * @param socket - tmux socket (local) — ignored by the remote launcher
 * @param id - subshell id
 * @param cols - the client's target width (the pane's current width)
 * @param rows - the client's target height
 * @param sizeOf - the log-size probe handed to {@link waitForPaneRepaint} so
 *   the post-nudge wait detects the fresh repaint the same way
 * @returns whether the post-nudge repaint burst was observed (the capture
 *   that follows ships the fresh frame)
 */
export async function nudgePaneForRepaint(
  launcher: NodeLauncher,
  socket: string,
  id: string,
  cols: number,
  rows: number,
  sizeOf: () => Promise<number>,
): Promise<boolean> {
  try {
    // The no-reflow route first: same repaint, zero history damage.
    if (await launcher.signalPaneWinch(socket, id)) {
      if (await waitForPaneRepaint(sizeOf, { noGrowthGraceMs: NUDGE_NO_GROWTH_GRACE_MS })) return true;
      // The signal reached the pane and nothing repainted — the app does not
      // answer a same-size SIGWINCH. Fall through to the geometry nudge,
      // which forces the repaint with sizes it cannot ignore.
    }
    // The ±1 step moves the pane behind the queue's back; seed BOTH ends so a
    // failure between them cannot leave `applied` claiming the pre-nudge size.
    seedPaneGeometry(id, cols + 1, rows);
    await launcher.resize(socket, id, cols + 1, rows);
    await Bun.sleep(NUDGE_SETTLE_MS);
    seedPaneGeometry(id, cols, rows);
    await launcher.resize(socket, id, cols, rows);
    // No baseline here (unlike the caller's pre-resize sample): the +1 step
    // above has already provoked whatever bytes a repainting app emits, so a
    // fresh sample is the honest "did anything happen after the step back".
    return await waitForPaneRepaint(sizeOf, { noGrowthGraceMs: NUDGE_NO_GROWTH_GRACE_MS });
  } catch {
    // A failed nudge leaves the pane at its (possibly bumped) width, but the
    // gap-free join still delivers every byte and the client's own resize
    // frames re-fit it — the first paint degrades to the pre-nudge behavior,
    // which is the floor we never regress below.
    return false;
  }
}
/**
 * Capture the replay grid (+ the last `cap` reflowed history rows). `null`
 * when the capture fails (pane gone). One capture is all it takes now the
 * attach streams gap-free from the join point: a snapshot that races an
 * animating frame self-corrects via the byte stream the client is guaranteed
 * to receive. (The old stable-grid poll raced diff-renderers' animation
 * cadence and bought latency, not correctness.) Shared with the remote
 * relay — identical paint there.
 */
export async function captureStable(
  launcher: NodeLauncher,
  socket: string,
  id: string,
  cap: number,
): Promise<string | null> {
  try {
    return await launcher.capture(socket, id, cap);
  } catch {
    return null;
  }
}

/**
 * Persists the subshell's lastOutputAt when new output arrives, throttled to
 * at most one DB write per 2s (drives the active/idle heuristic).
 * Exported so the remote relay (`remote-subshell-ws.ts`) keeps the heuristic
 * byte-identical for agent-node subshells — one throttle, both paths.
 */
export function persistOutput(_ws: WsSocket, data: WsData): void {
  const now = Date.now();
  if (now - data.lastOutputWriteAt < 2000) return;
  data.lastOutputWriteAt = now;
  getRequestlessContext()
    .repos.subshells.update(data.subshellId, { lastOutputAt: new Date().toISOString() })
    .catch((err: unknown) => logger.withError(err).warn("failed to persist lastOutputAt"));
}

/**
 * One output pump per subshell, shared by every viewer watching it (see
 * `ws/pane-stream.ts`). Today a subshell still has at most one viewer — the
 * eviction below enforces that until geometry arbitration exists — so this
 * behaves exactly as the per-socket pumps it replaces; what changes is that
 * the pump's state (decoder, sync stripper, log offset) now belongs to the
 * SUBSHELL rather than to a socket, which is the precondition for sharing it.
 */
const paneStreams = createPaneStreamRegistry();

/** Last lastOutputAt write per subshell — the heartbeat throttle, stream-lived. */
const lastOutputWrites = new Map<string, number>();

/**
 * Records that a subshell produced output, at most once per 2s.
 *
 * Keyed by SUBSHELL, not by socket: the pump is shared now, so a per-viewer
 * throttle would multiply the write rate by the number of devices watching.
 * @param subshellId - The subshell that produced output
 */
function persistOutputFor(subshellId: string): void {
  const now = Date.now();
  if (now - (lastOutputWrites.get(subshellId) ?? 0) < 2000) return;
  lastOutputWrites.set(subshellId, now);
  getRequestlessContext()
    .repos.subshells.update(subshellId, { lastOutputAt: new Date().toISOString() })
    .catch((err: unknown) => logger.withError(err).warn("failed to persist lastOutputAt"));
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
  if (frame.type === "resize") {
    // Through the queue, never straight at the launcher: two bare
    // `void resize(...)` calls can complete out of order and leave the pane
    // at a superseded size, which is what made a relative-positioning TUI
    // paint onto the wrong rows until a reattach.
    requestPaneResize(data.launcher, data.socket, data.subshellId, frame.cols, frame.rows);
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
  const subshellId = ws.data?.subshellId;
  if (subshellId && liveViewers.get(subshellId) === ws) {
    liveViewers.delete(subshellId);
    // No one is watching, so the remembered "already applied" size must go
    // too: the next attach has to be able to re-assert the same geometry (the
    // pane may have been resized by anything in between), and holding the
    // entry would make that request look like a no-op.
    geometryQueue.release(subshellId);
  }
  ws.data?.cleanup?.();
}

/**
 * One LIVE VIEWER per subshell — newest wins.
 *
 * A tmux pane has exactly one width, but two viewers (a reloaded tab and its
 * zombie pre-reload socket, a laptop and a phone) fit it differently: every
 * geometry switch re-wraps the TUI's hard rows under the other viewer's
 * absolute-positioned diff repaints, and the screen shatters into the
 * alternating-offset jumble (2026-09-01 report — the journal showed the same
 * subshell attached at 92x28 and 86x28 seconds apart while the pane bounced
 * between the two). Letting the newest attach close the previous one makes a
 * single terminal the sole size authority; the replaced client sees the
 * terminal-4xxx close and stops reconnecting (see `use-subshell-ws`).
 *
 * Called once both paths have PROVEN the pane is alive (post-probe), so a
 * refused attach never evicts the incumbent.
 */
const liveViewers = new Map<string, WsSocket>();

/**
 * Drops all viewer registrations WITHOUT closing the sockets. Only for tests,
 * which reuse subshell ids across cases and must not see a prior case's socket
 * evicted.
 * @internal
 */
export function resetLiveViewersForTests(): void {
  liveViewers.clear();
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
 * One viewer today (see {@link liveViewers}), so this is a lookup with a
 * loop's shape — deliberately, because the shared-session work replaces the
 * registry's value with a Set and every caller here is already correct for
 * that.
 */
function broadcastToViewers(subshellId: string, frame: object): void {
  const viewer = liveViewers.get(subshellId);
  if (!viewer) return;
  try {
    viewer.send(JSON.stringify(frame));
  } catch {
    // socket already gone; its close handler does the bookkeeping
  }
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
async function readPaneGeometry(
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

export function evictPreviousViewer(ws: WsSocket, subshellId: string): void {
  const prev = liveViewers.get(subshellId);
  // Drop the remembered pane size BEFORE claiming the slot. `cleanupSubshellWs`
  // releases only when the closing socket is still the registered viewer, and
  // the incumbent's close arrives after this line has already replaced it — so
  // without this the entry survives, and its stale `applied` silently swallows
  // the new viewer's first request for that size.
  if (prev && prev !== ws) geometryQueue.release(subshellId);
  liveViewers.set(subshellId, ws);
  if (!prev || prev === ws) return;
  // Release the incumbent's watcher/timer NOW — its close event also runs
  // `cleanupSubshellWs`, but the disposer is idempotent and the map entry
  // already names the new socket, so neither the double-run nor the
  // bookkeeping can disturb the fresh attach.
  try {
    prev.data?.cleanup?.();
    prev.close(4003, "subshell open in another viewer");
  } catch {
    // socket already gone — the registry entry was stale, and we just replaced it
  }
}
