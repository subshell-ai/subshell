import { stripAnsi } from "@internal/backend-errors";
import { TERMINAL_REPLAY_LINES } from "@/constants.js";

/** Bytes read from the end of a pane log for {@link readLogTailFrom}. */
export const LOG_TAIL_BYTES = 256 * 1024;
/** Lines returned by {@link readLogTailFrom}, newest end of the log. */
export const LOG_TAIL_LINES = 200;
/** Hard ceiling on a per-subshell replay cap — a LOAD GUARANTEE, not a preference. */
const REPLAY_LINE_CEILING = 200;

/**
 * Resolve the effective terminal-replay line cap for one attach: null/undefined
 * (no per-subshell choice) falls back to the instance default; anything stored
 * is coerced into [1, {@link REPLAY_LINE_CEILING}]. The clamp is re-applied at
 * READ time because the column predates the API and could hold an out-of-band
 * value — the ceiling keeps a bad row from turning one attach into a full-log
 * parse. Both attach paths (local `subshell-ws.ts` and the remote relay
 * `remote-subshell-ws.ts`) read through this so the guarantee cannot drift.
 * (The WRITE path is separate by design: the route schema validates/rejects
 * out-of-range input rather than clamping — different domain, not this helper.)
 */
export function replayLineCap(stored: number | null | undefined): number {
  return stored == null ? TERMINAL_REPLAY_LINES : Math.min(REPLAY_LINE_CEILING, Math.max(1, Math.trunc(stored)));
}

/** Safety net for missed watch events (file replaced under the watch, quota). */
export const TAIL_BACKSTOP_MS = 1000;

/**
 * Pure line math behind {@link readLogTailFrom}: turn the decoded text of a
 * {@link LOG_TAIL_BYTES} tail window into the display payload (ANSI stripped,
 * leading partial line dropped when the window cut into the file, last
 * {@link LOG_TAIL_LINES} lines, `truncated` verdict). Split from the
 * file-reading wrapper so the REMOTE tail (spec §6.3, `RemoteLauncher.readLogTail`)
 * produces byte-identical output from a `log_read` window.
 *
 * `startWasZero` is the caller's `windowStart === 0` flag: a window that
 * starts past 0 exists precisely because the file is bigger than
 * {@link LOG_TAIL_BYTES}, which is what the size half of the `truncated`
 * verdict meant in the wrapper — so `!startWasZero` carries that half.
 * @param text - the window's decoded text (whole file when `startWasZero`)
 * @param startWasZero - true when the window began at byte 0
 * @returns the last {@link LOG_TAIL_LINES} display lines + truncation flag
 */
export function tailLinesFromWindowText(text: string, startWasZero: boolean): { lines: string[]; truncated: boolean } {
  let body = text;
  if (!startWasZero) {
    // Drop the first partial line the byte-window may have cut through.
    body = body.slice(Math.max(0, body.indexOf("\n") + 1));
  }
  const all = stripAnsi(body).split("\n");
  if (all.at(-1) === "") all.pop();
  const truncated = !startWasZero || all.length > LOG_TAIL_LINES;
  return { lines: all.slice(-LOG_TAIL_LINES), truncated };
}

/**
 * Reads the tail of one pane log file — the only surviving record of a
 * harness that exited before anyone attached (the WS refuses dead panes and
 * the live preview is empty for them). ANSI is stripped and the read is
 * bounded ({@link LOG_TAIL_BYTES} from the end, last {@link LOG_TAIL_LINES}
 * lines) so a long-lived subshell cannot balloon the response. A missing or
 * unreadable log reads as empty; this is a display surface, not a gate.
 */
export async function readLogTailFrom(path: string): Promise<{ lines: string[]; truncated: boolean }> {
  const file = Bun.file(path);
  const size = file.size;
  if (size === undefined) return { lines: [], truncated: false };
  const start = Math.max(0, size - LOG_TAIL_BYTES);
  let text: string;
  try {
    text = await file.slice(start, size).text();
  } catch {
    return { lines: [], truncated: false };
  }
  return tailLinesFromWindowText(text, start === 0);
}
