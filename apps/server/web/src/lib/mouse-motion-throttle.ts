/**
 * The SGR mouse report shape, anchored: a chunk that is EXACTLY one report.
 *
 * Anchored on purpose. A chunk carrying a report plus anything else is not
 * something to sample — it is passed through whole, because the "anything
 * else" may be a keystroke and reordering input is never acceptable.
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: ESC introduces the sequence being matched
const LONE_SGR_REPORT = /^\x1b\[<(\d{1,7});\d{1,7};\d{1,7}([Mm])$/;

/** Bit 5 of the button byte marks a MOTION event (a drag, or bare movement under mode 1003). */
const MOTION_BIT = 32;

/**
 * True when this chunk is a single mouse MOTION report and nothing else.
 *
 * Presses, releases and wheel reports are deliberately excluded: sampling
 * those loses a click or a scroll notch, which a person would feel as the
 * terminal ignoring them. Motion is the only kind where the intermediate
 * values carry no information the final one does not.
 */
export function isMotionReport(data: string): boolean {
  const m = LONE_SGR_REPORT.exec(data);
  if (!m) return false;
  // A release (`m`) is never motion however its button byte reads.
  if (m[2] !== "M") return false;
  return (Number(m[1]) & MOTION_BIT) !== 0;
}

/** What {@link createMotionThrottle} hands back. */
export interface MotionThrottle {
  /** Offer one `onData` chunk; it is sent now or sampled. */
  push(data: string): void;
  /** Sends anything pending and stops the timer. */
  dispose(): void;
}

/**
 * Samples mouse MOTION reports instead of forwarding every one.
 *
 * **Why this is worth doing at all.** Each chunk `term.onData` produces becomes
 * one WebSocket frame and then one `tmux send-keys` — a PROCESS SPAWN, ~3 ms,
 * serialized per pane. With mouse reporting on (tmux enables it, and the agent
 * TUIs do too) a moving pointer emits a report per cell crossed, so an idle
 * hand drifting across the terminal can ask for dozens of spawns a second and
 * queue real keystrokes behind them. Reported from a live session, 2026-09-20.
 *
 * The sampling is TRAILING: the most recent motion is always the one sent, so
 * the pane ends up at the position the pointer actually reached rather than
 * wherever it happened to be when a window closed. Anything that is not a lone
 * motion report — a keystroke, a press, a release, a wheel notch, a paste, a
 * chunk carrying several things — flushes the pending motion FIRST and then
 * goes out immediately, so order is never disturbed and nothing but movement
 * is ever delayed.
 *
 * @param send - what actually forwards a chunk
 * @param intervalMs - the sampling period
 */
export function createMotionThrottle(send: (data: string) => void, intervalMs: number): MotionThrottle {
  let pending: string | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const flush = (): void => {
    timer = null;
    if (pending === null) return;
    const data = pending;
    pending = null;
    send(data);
  };

  return {
    push(data: string) {
      if (isMotionReport(data)) {
        pending = data;
        // Leading-edge timer: a pointer moving steadily is sampled every
        // interval rather than having its report postponed indefinitely.
        if (!timer) timer = setTimeout(flush, intervalMs);
        return;
      }
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      flush();
      send(data);
    },
    dispose() {
      if (timer) clearTimeout(timer);
      timer = null;
      flush();
    },
  };
}
