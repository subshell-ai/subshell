/**
 * Per-DEVICE pointer-motion sampling rate (localStorage, not `user_meta`) —
 * the same tier as `terminal-font-size` and `swipe-nav-pref`, and for the same
 * reason: how much pointer traffic a terminal should carry depends on the
 * machine in front of you and the network between it and the pane, not on the
 * account.
 *
 * **What the number buys.** Every chunk xterm emits becomes one WebSocket
 * frame and then one `tmux send-keys` — a process spawn, serialized per pane.
 * With mouse reporting on, an unthrottled pointer asks for dozens a second and
 * queues real keystrokes behind them. This caps how many of those a second a
 * moving pointer may cause; the LAST position in each window is the one sent,
 * so the pane always ends up where the pointer actually stopped.
 *
 * Presses, releases, wheel notches and keystrokes are never sampled — only
 * movement, where the intermediate values carry nothing the final one does not.
 */

/** Samples per second when nothing has been chosen (operator's call, 2026-09-20). */
export const DEFAULT_MOTION_SAMPLES_PER_SEC = 2;

/**
 * The range the control offers.
 *
 * The floor is 1 rather than 0: zero would mean a drag never reports at all,
 * which reads as the terminal ignoring the mouse rather than as a performance
 * setting. Anyone who wants that turns mouse reporting off in the program
 * itself. The ceiling is 60 — a frame per repaint, which is what an
 * unthrottled pointer approximates and the most that could ever be useful.
 */
export const MIN_MOTION_SAMPLES_PER_SEC = 1;
export const MAX_MOTION_SAMPLES_PER_SEC = 60;

const KEY = "subshell.mouseSamplesPerSec";

/** Clamps and rounds whatever was stored or typed into a usable rate. */
export function clampSamplesPerSec(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_MOTION_SAMPLES_PER_SEC;
  return Math.min(MAX_MOTION_SAMPLES_PER_SEC, Math.max(MIN_MOTION_SAMPLES_PER_SEC, Math.round(value)));
}

/** This device's sampling rate, in samples per second. */
export function motionSamplesPerSec(): number {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw === null) return DEFAULT_MOTION_SAMPLES_PER_SEC;
    return clampSamplesPerSec(Number(raw));
  } catch {
    // Private mode throws on access; an unreadable choice is no choice.
    return DEFAULT_MOTION_SAMPLES_PER_SEC;
  }
}

/** The same rate as the interval the throttle actually uses. */
export function motionSampleIntervalMs(): number {
  return Math.round(1000 / motionSamplesPerSec());
}

/**
 * Persists this device's choice.
 * @returns the stored (clamped) rate, so a caller binds its control to truth
 *          rather than to what was typed
 */
export function setMotionSamplesPerSec(value: number): number {
  const rate = clampSamplesPerSec(value);
  try {
    localStorage.setItem(KEY, String(rate));
  } catch {
    // Storage refused: the choice still holds for this page load.
  }
  return rate;
}
