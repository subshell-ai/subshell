import { TERMINAL_HISTORY_BYTES } from "@/constants.js";
import type { NodeLauncher } from "@/services/nodes/node-launcher.js";
import { logger } from "@/utils/logger.js";
import { ModeStreamStripper } from "@/ws/mode-stripper.js";
import { sendFrame, type WsSocket } from "@/ws/viewers.js";

/**
 * Sends the one-shot `history` frame that gives a reloaded panel its prior
 * scrollback, as the newest window of the pane's OWN raw output log ending
 * exactly at the live stream's start.
 *
 * WHY it exists: an alt-screen TUI keeps zero history rows in tmux, so the
 * capture in the `replay` frame is all a reloaded panel used to get — one
 * bare screen, no scrollback. The log window the app itself produced holds
 * that history; writing it after the replay scrolls the app's own prior
 * frames into scrollback, which is what makes the panel open like "a tab that
 * has been open for hours". The window ENDS at `markOffset` (the offset the
 * live tail streams from on both attach paths), so log coverage is
 * continuous: history up to the mark, live bytes from it.
 *
 * Both attach paths call this at the same point — after the replay send,
 * before `stream.open()` — so the wire order is `[replay][history][output…]`
 * identically for a local and a remote pane; the two call sites are the twin
 * mirror this repo holds both paths to.
 *
 * Best effort by decision: a missing file, a torn read or a remote RPC
 * failure ships NO frame and costs the attach nothing beyond the read that
 * just failed. Prior scrollback is a nicety the replay already survives
 * without; failing it must not delay or kill the live join the pane matters
 * for. Absence is legal to the client ("no prior history"), and
 * `TERMINAL_HISTORY_BYTES` 0 spells the same empty window.
 *
 * The window bytes start at an arbitrary offset, so they may begin
 * mid-escape-sequence or mid-codepoint: one non-streaming `TextDecoder`
 * turns that into a stray byte or a U+FFFD, which xterm absorbs across its
 * own writes exactly as today's live join already absorbs a chunk that
 * splits one. The history MUST be mode-stripped: an app that entered the
 * alt screen at startup would otherwise park this viewer's xterm on the
 * scrollback-less alt buffer for its whole life, the bug the mode stripper
 * exists to kill. The pane's log file on disk stays byte-raw; only this
 * outbound copy is stripped.
 *
 * And the window ENDS at an arbitrary offset too, which the stateless
 * {@link stripViewerModes} cannot answer: the bytes may stop mid-marker
 * (`…ESC[?104`) while the live pump's first bytes carry the completion
 * (`9h`). Stripped statelessly, both halves ship, xterm completes
 * `?1049h` ACROSS ITS OWN WRITES, and the panel parks on the alt buffer
 * (a split `?2026` costs the 1 s paint gate the same way): this frame's
 * own bug, resurrected at the history→live seam. So the strip runs through
 * a THROWAWAY {@link ModeStreamStripper} whose held tail is DELIBERATELY
 * DROPPED (never `flush`ed): the incomplete head simply is not in history,
 * and the live bytes arrive as literal text at their true position.
 * Degraded text in the oldest scrollback, never a completed mode.
 *
 * @param ws - the joining socket
 * @param launcher - the row's launcher; the read rides the same
 *   `readLog` seam every other log reader uses, so local and remote panes
 *   reach their bytes with no node-agent change
 * @param subshellId - the row being attached
 * @param markOffset - the log offset where the live stream starts; the
 *   window ends here and `TERMINAL_HISTORY_BYTES` before it is where it
 *   begins (clamped at 0, so a young pane ships from its true first byte)
 * @returns the byte length of the frame actually sent (0 when none: empty
 *   window, knob off, booting skip at the caller, or failed read). The
 *   attach's ONE journal line carries it, because forensics that report only
 *   `replay=` understate what the viewer was sent by the whole window — and
 *   the window's known-degraded edges (a dropped split-marker head, a
 *   boundary U+FFFD) are exactly the "which layer lied?" evidence.
 */
export async function sendHistoryFrame(
  ws: WsSocket,
  launcher: NodeLauncher,
  subshellId: string,
  markOffset: number,
): Promise<number> {
  const from = Math.max(0, markOffset - TERMINAL_HISTORY_BYTES);
  const want = markOffset - from;
  // A mark at byte 0 has no prior history, and `TERMINAL_HISTORY_BYTES` 0
  // (the off switch) makes every window empty the same way.
  if (want === 0) return 0;
  try {
    const { bytes } = await launcher.readLog(subshellId, from, want);
    // One push, no flush: the stripper holds a split marker's head back (see
    // the window-END note above) and the held tail is dropped with it. A
    // window that is nothing but an incomplete marker yields "" and no frame.
    const history = new ModeStreamStripper().push(new TextDecoder().decode(bytes));
    if (!history) return 0;
    sendFrame(ws, { type: "history", data: history });
    return history.length;
  } catch (err) {
    // Deliberately swallowed: see the best-effort note above.
    logger.withError(err).warn(`ws attach: prior-history read failed for ${subshellId}`);
    return 0;
  }
}
