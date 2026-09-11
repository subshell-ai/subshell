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

/**
 * How often the pane log is re-read for new bytes.
 *
 * This is the PRIMARY delivery path, not a safety net, and its interval is the
 * latency a person feels when they type: the pane echoes a keystroke into the
 * log, and nothing ships it until the next poll. The `fs.watch` beside it is an
 * optimization that cannot be relied on — measured on bun 1.4.2 / macOS, a
 * watch on a file appended by ANOTHER process (which is what tmux `pipe-pane`
 * is: `sh -c 'cat >> log'`) fired 0/10 in one run and 1/3 in another, while
 * the same watch reports in-process writes reliably. At the old 1000ms
 * "backstop" that made every keystroke land 698ms late, every sample within
 * 2ms of the rest.
 *
 * 50ms costs one `stat` per poll per ATTACHED pane — 9.4µs measured, so
 * ~0.19ms of work per second per pane, and the pump exists only while somebody
 * is watching. That is a price worth paying twenty times a second for a
 * terminal that feels live.
 */
export const TAIL_POLL_MS = 50;

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
