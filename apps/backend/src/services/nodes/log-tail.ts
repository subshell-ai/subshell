import { stripAnsi } from "@internal/backend-errors";

/** Bytes read from the end of a pane log for {@link readLogTailFrom}. */
export const LOG_TAIL_BYTES = 256 * 1024;
/** Lines returned by {@link readLogTailFrom}, newest end of the log. */
export const LOG_TAIL_LINES = 200;

/** Safety net for missed watch events (file replaced under the watch, quota). */
export const TAIL_BACKSTOP_MS = 1000;

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
