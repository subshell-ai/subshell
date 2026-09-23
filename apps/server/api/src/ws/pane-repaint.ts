/**
 * Making a pane REPAINT after it is resized, and reading it back.
 *
 * tmux re-wraps the OLD frame the instant a pane resizes, so a timer-based
 * settle captures a stable-looking grid of mid-word garbage. These helpers
 * detect the app's real SIGWINCH repaint as a burst of log bytes instead, and
 * force one when a no-op resize fires no SIGWINCH at all — the case that left
 * a half-painted frame on screen for every later viewer.
 *
 * Extracted from `subshell-ws.ts` unchanged: both attach paths need them, and
 * having the remote relay reach into the local attach module for them was
 * half of the import cycle between the two.
 */

import type { NodeLauncher } from "@/services/nodes/node-launcher.js";
import { seedPaneGeometry } from "@/ws/viewers.js";

/**
 * Grace given to the pane's TUI to repaint after the pre-capture resize —
 * roughly one SIGWINCH frame; the replay that follows then shows the grid at
 * the geometry the client will render it into. Shared with the remote relay
 * so both attach paths paint the same post-resize grid.
 */
export const RESIZE_SETTLE_MS = 150;
/**
 * The repaint wait's budget, and why every number is small.
 *
 * This whole dance "improves the first paint only; correctness lives in the
 * gap-free join" (both attach paths say so). A snapshot taken mid-frame is
 * healed by the very next diff the client is guaranteed to receive — so the
 * wait buys a cleaner first paint, and its entire cost is wall-clock a person
 * spends looking at nothing. Measured with these functions against real
 * panes before the numbers below: 1.55s for a pane animating a spinner every
 * 80ms (growth, but never 150ms of quiet — straight to a 1500ms deadline) and
 * 1.18s for an idle shell (467ms of no-growth grace, then a 711ms nudge).
 *
 * - POLL 25ms: how soon growth is noticed; a stat per tick for ≤300ms.
 * - QUIET 60ms: long enough for one full-screen frame to land whole (a TUI's
 *   repaint is a single write, well under that), short enough to fall BETWEEN
 *   the frames of an 80ms animation instead of waiting for it to stop.
 * - DEADLINE 300ms: the cap when an animation runs faster than the quiet
 *   window. Bounds the transient; the stream fixes the frame either way.
 * - No-growth budgets: a SIGWINCH is synchronous for the app, so a TUI that
 *   is going to repaint starts emitting within tens of ms. Concluding "it is
 *   not going to" needs a little margin for load — not 450ms, which is what
 *   the old settle + grace added up to on every same-size reopen.
 */
const REPAINT_POLL_MS = 25;
const REPAINT_QUIET_MS = 60;
const REPAINT_DEADLINE_MS = 300;
/** No-growth budget after a REAL resize (the app got a SIGWINCH with new dims). */
const RESIZE_NO_GROWTH_MS = 200;
/** No-growth budget after a nudge (a bare winch, or the ±1 step). */
const NUDGE_NO_GROWTH_MS = 120;

/**
 * After a pre-capture resize, wait for the pane's application to REPAINT at
 * the new geometry, detected as fresh bytes in the pipe-pane log (the only
 * signal that distinguishes tmux's instant re-wrap of the OLD frame from the
 * app's real repaint of the new one).
 *
 * Returns once (a) the log grew and then went quiet for {@link
 * REPAINT_QUIET_MS} — the repaint landed, capture is safe — or (b) nothing
 * ever grew within `noGrowthMs` — an idle
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
 * @param opts.noGrowthMs - the whole budget before concluding no burst is coming
 *   (default {@link RESIZE_NO_GROWTH_MS}; the nudge passes {@link NUDGE_NO_GROWTH_MS})
 * @returns `true` when the app's repaint burst was observed — the capture that
 *   follows ships the fresh frame — `false` when the log never grew (a no-op
 *   resize that fired no SIGWINCH, an idle pane, or an unresponsive TUI, where
 *   the caller forces a repaint with {@link nudgePaneForRepaint} rather than
 *   capturing a stale, re-wrapped grid).
 */
export async function waitForPaneRepaint(
  sizeOf: () => Promise<number>,
  opts: { baseline?: number; noGrowthMs?: number } = {},
): Promise<boolean> {
  const noGrowthMs = opts.noGrowthMs ?? RESIZE_NO_GROWTH_MS;
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
      if (now - started >= noGrowthMs) return false;
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
 * How long after a row's (re)start a pane with residual log bytes still
 * reads as booting. A restart reuses the row id and the pipe-pane log is
 * append-only (the transcript survives deliberately), so the zero-bytes rule
 * alone would let a RESTARTED row — empty grid, shell mid-boot — take the
 * full nudge storm. `startedAt` is rewritten at every (re)start, which is the
 * per-boot epoch; this window covers it. Sized to outlast a slow shell's
 * init (ble.sh-class prompt machinery: seconds) while staying far under the
 * interval at which a person reattaches to a settled pane — a late joiner to
 * a still-initializing slower-than-the-window shell keeps the old dance, the
 * pre-fix behavior, never anything worse.
 */
export const STARTUP_GRACE_MS = 5_000;

/**
 * Whether this attach may skip the repaint wait and the nudge, because there
 * is no settled frame to protect: no readable log bytes at the join sample
 * (a first boot, or no log to read from), OR bytes left over from a PREVIOUS
 * life of the row while the current boot is still young.
 *
 * @param logStart - the log size sampled BEFORE any resize (both attach paths)
 * @param startedAt - the row's boot timestamp (null/older-than-grace ⇒ not booting)
 * @param nowMs - injected clock for tests
 */
export function paneReadsAsBooting(
  logStart: number,
  startedAt: string | null | undefined,
  nowMs: number = Date.now(),
): boolean {
  if (logStart === 0) return true;
  if (!startedAt) return false;
  const started = Date.parse(startedAt);
  return Number.isFinite(started) && nowMs - started < STARTUP_GRACE_MS;
}

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
      if (await waitForPaneRepaint(sizeOf, { noGrowthMs: NUDGE_NO_GROWTH_MS })) return true;
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
    return await waitForPaneRepaint(sizeOf, { noGrowthMs: NUDGE_NO_GROWTH_MS });
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

/** What {@link fitPaneAndRepaint} did, for the attach's forensics line. */
export interface FitRepaintOutcome {
  /** A repaint burst at the fit geometry was observed before the capture. */
  repainted: boolean;
  /** The pane had to be provoked (winch / ±1 step) because the fit alone repainted nothing. */
  nudged: boolean;
}

/**
 * Fit a pane to `fit`, then make sure its TUI has repainted at that geometry
 * — the one sequence both attach paths run before their capture.
 *
 * Shared so the two cannot drift, and because it holds the observation that
 * removed ~450ms from every reopen: **a same-size resize is a no-op**. tmux
 * fires no SIGWINCH for it, so nothing can repaint and the whole no-growth
 * budget was being spent waiting for a burst that could not come — on every
 * attach at the size the pane already had, which is what reattaching IS.
 * When the pane is already at `fit`, the resize and its wait are skipped and
 * the nudge (which provokes the repaint deliberately) runs at once. An
 * unreadable size degrades to the resize-and-wait, never to a guess.
 *
 * @param fit - the shared grid every viewer will render (never the joiner's own)
 * @param sizeOf - reads the pane log's size (the repaint signal)
 * @param opts.baseline - the log size sampled BEFORE any resize, so a fast
 *   repaint still counts as growth
 * @param opts.canNudge - evaluated AFTER the first wait: false when there is
 *   no log to read a burst from (a blind nudge would thrash every pane-poll
 *   attach) or the viewer has already gone
 * @param opts.booting - {@link paneReadsAsBooting}: no readable log bytes at
 *   the join sample (a first boot, or no log to read at all), or bytes only
 *   from a PREVIOUS life while the current boot is inside
 *   {@link STARTUP_GRACE_MS} (a restarted row — its log deliberately
 *   survives). Then this reduces to the one fit resize and returns: there is
 *   no frame that could be stale, so the repaint wait has nothing to watch
 *   and the nudge is strictly harmful — a slow-booting shell (ble.sh,
 *   powerlevel10k: prompts redrawn by every SIGWINCH during init) takes the
 *   ±1 storm as duplicated prompts written INTO the pane's own history, the
 *   stray prompt-at-top the operator sees on every fresh terminal (2026-09-23
 *   report). The single fit resize stays: it lands before the first frame
 *   exists, so the shell boots at the fit geometry rather than being winched
 *   mid-prompt later. Honest edge: bytes landing between the caller's sample
 *   and this call make `booting` stale-TRUE, which skips the provocation —
 *   the safe direction, since a seconds-old frame is not the stale one the
 *   nudge exists for.
 * @throws whatever `launcher.resize` throws — callers keep their fallback
 */
export async function fitPaneAndRepaint(
  launcher: NodeLauncher,
  socket: string,
  id: string,
  fit: { cols: number; rows: number },
  sizeOf: () => Promise<number>,
  opts: { baseline: number; canNudge: boolean | (() => boolean); booting?: boolean },
): Promise<FitRepaintOutcome> {
  const current = await launcher.paneSize(socket, id);
  const alreadyFitted = current !== null && current.cols === fit.cols && current.rows === fit.rows;
  if (!alreadyFitted) {
    await launcher.resize(socket, id, fit.cols, fit.rows);
  }
  // Tell the queue either way: the fit bypassed it, and a client frame asking
  // for this same size must not then be swallowed as already-applied.
  seedPaneGeometry(id, fit.cols, fit.rows);
  if (opts.booting) {
    // See the JSDoc: a pane with no output yet cannot hold a stale frame, and
    // every extra winch is prompt-scatter for its still-booting shell.
    return { repainted: false, nudged: false };
  }
  const repainted = alreadyFitted ? false : await waitForPaneRepaint(sizeOf, { baseline: opts.baseline });
  const canNudge = typeof opts.canNudge === "function" ? opts.canNudge() : opts.canNudge;
  if (repainted || !canNudge) return { repainted, nudged: false };
  return { repainted: await nudgePaneForRepaint(launcher, socket, id, fit.cols, fit.rows, sizeOf), nudged: true };
}
