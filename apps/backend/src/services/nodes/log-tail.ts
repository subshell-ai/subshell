import { stripAnsi } from "@internal/backend-errors";

/** Bytes read from the end of a pane log for {@link readLogTailFrom}. */
export const LOG_TAIL_BYTES = 256 * 1024;
/** Lines returned by {@link readLogTailFrom}, newest end of the log. */
export const LOG_TAIL_LINES = 200;

/** Safety net for missed watch events (file replaced under the watch, quota). */
export const TAIL_BACKSTOP_MS = 1000;

/**
 * Byte offset at which the last `lines` newline-terminated lines of `path`
 * begin — the attach-time replay window for {@link startLogTail}. Reading
 * from this offset instead of 0 is what keeps a days-old session's terminal
 * open in milliseconds instead of shipping its whole log.
 *
 * Returns 0 when the file already holds ≤ `lines` lines (nothing to prune) or
 * cannot be read (the caller's tail then behaves as it always did). The scan
 * is bounded to the last {@link LOG_TAIL_BYTES}; a file bigger than that
 * window always has "enough" lines, so returning the window start is safe.
 * The offset normally sits just after a `\n`; only the degenerate case (fewer
 * line boundaries than requested lines inside the window — one absurdly long
 * line) starts mid-line, which xterm renders as a harmless partial row.
 */
export async function logReplayStartOffset(path: string, lines: number): Promise<number> {
  const file = Bun.file(path);
  const size = file.size;
  if (!size) return 0;
  const windowStart = Math.max(0, size - LOG_TAIL_BYTES);
  let text: string;
  try {
    text = await file.slice(windowStart, size).text();
  } catch {
    return 0;
  }
  const newlines: number[] = [];
  for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) newlines.push(i);
  // Displayable lines: every newline terminates one line; trailing bytes after
  // the last newline (no closing \n) are one more.
  const lineCount = newlines.length + (text.endsWith("\n") ? 0 : 1);
  if (lineCount <= lines) return windowStart; // nothing to prune (or the
  // degenerate windowed single-line file — bounded either way)
  const skip = lineCount - lines; // drop this many leading lines
  return windowStart + newlines[skip - 1] + 1;
}

/**
 * Reads the tail of one pane log file — the only surviving record of a
 * harness that exited before anyone attached (the WS refuses dead panes and
 * the live preview is empty for them). ANSI is stripped and the read is
 * bounded ({@link LOG_TAIL_BYTES} from the end, last {@link LOG_TAIL_LINES}
 * lines) so a long-lived session cannot balloon the response. A missing or
 * unreadable log reads as empty; this is a display surface, not a gate.
 */
export async function readLogTailFrom(path: string): Promise<{ lines: string[]; truncated: boolean }> {
  const file = Bun.file(path);
  const size = file.size;
  if (size === undefined) return { lines: [], truncated: false };
  let text: string;
  try {
    const start = Math.max(0, size - LOG_TAIL_BYTES);
    text = await file.slice(start, size).text();
    if (start > 0) {
      // Drop the first partial line the byte-window may have cut through.
      text = text.slice(Math.max(0, text.indexOf("\n") + 1));
    }
  } catch {
    return { lines: [], truncated: false };
  }
  const all = stripAnsi(text).split("\n");
  if (all.at(-1) === "") all.pop();
  const truncated = size > LOG_TAIL_BYTES || all.length > LOG_TAIL_LINES;
  return { lines: all.slice(-LOG_TAIL_LINES), truncated };
}
