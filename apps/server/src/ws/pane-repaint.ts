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
