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

/** Hard ceiling on one cursor-read window (spec 2026-10-01 §3; same size as the tail). */
export const LOG_MAX_WINDOW_BYTES = LOG_TAIL_BYTES;
/** Window a cursor read asks for when the caller named none. */
export const LOG_WINDOW_DEFAULT_BYTES = 64 * 1024;

/**
 * Byte truth behind a cursor read (spec 2026-10-01 §3), split from the
 * launcher hop so local and remote answer from ONE implementation, the way
 * {@link tailLinesFromWindowText} does for the tail.
 *
 * The caller passes the window's RAW bytes, never decoded text: `nextByte`
 * must be a raw file offset (stripped text is shorter and cannot be fed back
 * to a byte read), and a UTF-8 sequence may straddle the window edge, so
 * counting is done on bytes. A newline cannot hide inside a multibyte
 * sequence, so byte-level `lastIndexOf` is exact.
 *
 * Line-aligned resume: only newline-terminated lines are consumed, so the
 * cursor always sits at a line boundary and a line cut by the window edge
 * arrives whole on the next read. The exception is the liveness rule: a
 * window containing NO newline returns its partial text and the cursor
 * advances past the window. That branch fires not only for a line longer
 * than any window but also for a line merely unterminated at read time (an
 * active prompt, a mid-write append) - and it must fire in both cases, or a
 * quiet pane would pin the cursor and a spinning loop would never see what
 * follows. The visible cost: such a line's remainder arrives as the NEXT
 * read's leading line. Output is never duplicated, skipped, or stuck; a
 * logical line can be split across reads (pinned by test).
 *
 * Unlike the tail there is no line cap in cursor mode: the byte budget IS the
 * cap, and silently dropping lines from a caller paging through output is the
 * lossy behavior this whole path exists to remove.
 *
 * @param bytes - the window's raw bytes (the answer of one `readLogWindow`)
 * @param fromByte - the raw offset the window began at
 * @param size - whole-file size as reported beside the window
 */
export function cursorLinesFromWindow(
  bytes: Uint8Array,
  fromByte: number,
  size: number,
): { lines: string[]; truncated: boolean; nextByte: number } {
  if (bytes.byteLength === 0) return { lines: [], truncated: false, nextByte: Math.min(fromByte, size) };
  const lastNewline = bytes.lastIndexOf(0x0a);
  if (lastNewline === -1) {
    const text = Buffer.from(bytes).toString("utf8");
    return { lines: [stripAnsi(text)], truncated: true, nextByte: fromByte + bytes.byteLength };
  }
  const consumed = lastNewline + 1;
  const all = stripAnsi(Buffer.from(bytes.subarray(0, consumed)).toString("utf8")).split("\n");
  if (all.at(-1) === "") all.pop();
  const nextByte = fromByte + consumed;
  return { lines: all, truncated: nextByte < size, nextByte };
}

/** The launcher seam's window triple, unbound (see `NodeLauncher.readLogWindow`). */
export type LogWindowReader = (
  fromByte: number,
  maxBytes: number,
) => Promise<{ bytes: Uint8Array; next: number; size: number }>;

/** Optional window request beside a log read; `fromByte` absent means "tail". */
export interface LogCursorRequest {
  /** Inclusive raw file offset to resume from; absent keeps the EOF-anchored tail. */
  fromByte?: number;
  /** Window budget, clamped to [1, {@link LOG_MAX_WINDOW_BYTES}]; {@link LOG_WINDOW_DEFAULT_BYTES} when absent. */
  maxBytes?: number;
}

/**
 * One log read behind the cursor API (spec 2026-10-01 §3), composed over the
 * launcher's window triple so local and remote are byte-identical by
 * construction.
 *
 * TAIL mode (no `fromByte`): the byte-identical answer of today's
 * `readLogTail` (size probe, last {@link LOG_TAIL_BYTES},
 * {@link tailLinesFromWindowText} with its partial-leading-line drop and
 * {@link LOG_TAIL_LINES} cap), plus `nextByte` = file size: the tail seeds a
 * cursor at EOF. Lines beyond the 200 cap were not shown and are not replayed
 * - the honesty is in the description, not the offset. (The two hops read
 * append-only content at slightly different instants; output that landed
 * between them shows in the tail AND re-arrives on the first cursor read:
 * bounded duplication, never a skip.)
 *
 * CURSOR mode (`fromByte`): ONE window read through {@link cursorLinesFromWindow}.
 * At or past EOF the answer is empty with the cursor parked at the offset (a
 * reader polling a quiet pane never moves it).
 */
export async function readLogCursor(
  read: LogWindowReader,
  req: LogCursorRequest,
): Promise<{ lines: string[]; truncated: boolean; nextByte: number }> {
  if (req.fromByte === undefined) {
    const { size } = await read(0, 1);
    if (size === 0) return { lines: [], truncated: false, nextByte: 0 };
    const start = Math.max(0, size - LOG_TAIL_BYTES);
    const { bytes } = await read(start, LOG_TAIL_BYTES);
    const tail = tailLinesFromWindowText(Buffer.from(bytes).toString("utf8"), start === 0);
    return { ...tail, nextByte: size };
  }
  const fromByte = Math.max(0, Math.trunc(req.fromByte));
  const maxBytes = Math.min(Math.max(1, Math.trunc(req.maxBytes ?? LOG_WINDOW_DEFAULT_BYTES)), LOG_MAX_WINDOW_BYTES);
  const { bytes, size } = await read(fromByte, maxBytes);
  return cursorLinesFromWindow(bytes, fromByte, size);
}
