import { appendFileSync, chmodSync, existsSync, mkdirSync, statSync, truncateSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { BlankTransport, type LogLayerTransportParams, type LogLevelType } from "loglayer";
import { SUBSHELL_SERVER_DATA_DIR } from "@/constants.js";

/**
 * The server's own log file: ONE file under the data directory, JSON lines,
 * capped and REPLACED when full — never a growing history, and never a copy
 * in memory (operator direction 2026-09-12, spec § 3.4).
 *
 * The same on every platform, deliberately. The desktop console used to tail
 * launchd's file on macOS and `journalctl` on Linux; neither exists in a
 * container, and a headless install may run under anything at all. The
 * manager's own log is still named in the deployment view for anything older
 * than this file holds.
 */

/** Size at which the file is replaced (spec § 3.4). */
export const SERVER_LOG_CAP_BYTES = 204_800;

/** `<dataDir>/logs/server.log` — one file, every platform. */
export function serverLogPath(): string {
  return join(SUBSHELL_SERVER_DATA_DIR, "logs", "server.log");
}

/** One parsed line of the file. */
export interface ServerLogLine {
  /** ISO 8601 timestamp; empty for a line that was not JSON. */
  ts: string;
  /** The level word, or `raw` for a line that was not JSON. */
  level: string;
  /** The message. */
  message: string;
  /** Everything else the line carried (context, metadata, err). */
  data?: unknown;
}

/** JSON line → fields; a non-JSON line (a partial write at the cap) comes back as `raw`. */
export function parseServerLogLine(line: string): ServerLogLine {
  try {
    const v = JSON.parse(line) as Record<string, unknown>;
    const { timestamp, level, message, ...rest } = v;
    return {
      ts: typeof timestamp === "string" ? timestamp : "",
      level: typeof level === "string" ? level : "raw",
      message: typeof message === "string" ? message : line,
      ...(Object.keys(rest).length > 0 ? { data: rest } : {}),
    };
  } catch {
    return { ts: "", level: "raw", message: line };
  }
}

/**
 * The last `lines` lines of the file, oldest first, plus its current size.
 * A whole read is fine: the file is at most {@link SERVER_LOG_CAP_BYTES} by
 * construction. A missing file is empty, never an error — it simply has not
 * been written to yet.
 */
export async function readServerLogTail(
  path: string,
  lines: number,
): Promise<{ lines: ServerLogLine[]; bytes: number }> {
  if (!existsSync(path)) return { lines: [], bytes: 0 };
  const [text, st] = await Promise.all([readFile(path, "utf8"), stat(path)]);
  const all = text.split("\n").filter((l) => l.length > 0);
  return { lines: all.slice(-Math.max(0, lines)).map(parseServerLogLine), bytes: st.size };
}

/**
 * What the debug toggle touches on the writer, and the only thing it touches.
 *
 * Optional because that is how LogLayer's own `LoggerlessTransport` declares
 * it (an absent level means "trace"); the toggle always writes a concrete one.
 */
export interface LevelledTransport {
  /** Minimum level this transport writes. */
  level?: LogLevelType;
}

/**
 * Render one log call as a single JSON line.
 *
 * The field names are the ones {@link parseServerLogLine} reads, and they
 * match what a LogLayer JSON transport would emit, so a line stays readable
 * with `jq` outside this app.
 */
function renderLine({ logLevel, messages, data, hasData }: LogLayerTransportParams): string {
  const message = messages.map((m) => (typeof m === "string" ? m : JSON.stringify(m))).join(" ");
  return `${JSON.stringify({
    timestamp: new Date().toISOString(),
    level: logLevel,
    message,
    ...(hasData && data ? (data as object) : {}),
  })}\n`;
}

/**
 * Append one line, replacing the file when it would overflow the cap.
 *
 * Truncation starts a NEW file rather than dropping the oldest lines, which
 * is what "replaced when full" means and is the whole reason no dependency
 * was taken for this: the rotation transport the spike measured (2026-09-12)
 * kept every rotated file, each one PAST the cap, under plain `bun` and
 * compiled alike.
 *
 * Synchronous, like the pane-log pipe: a line lost to buffering at a crash is
 * the line that explains the crash. The directory is created on first write
 * rather than at import, because this module is in the CLI entry graph and
 * that graph must stay free of IO at import.
 */
function appendCapped(path: string, line: string, capBytes: number): void {
  let size = 0;
  try {
    size = statSync(path).size;
  } catch {
    // No file yet — create its directory 0700, like the pane logs' directory.
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  }
  if (size > 0 && size + line.length > capBytes) {
    truncateSync(path, 0);
    size = 0;
  }
  appendFileSync(path, line, { mode: 0o600 });
  // The creation mode is umask-clamped, so assert 0600 on the file we just
  // created: it holds whatever the server logged, the same class of content
  // as a pane log.
  if (size === 0) chmodSync(path, 0o600);
}

/**
 * A size-capped JSON-lines appender, as a LogLayer transport.
 *
 * Built on `BlankTransport` (loglayer's own `LoggerlessTransport` with a
 * supplied `shipToLogger`) so the level gate, the `enabled` flag and the
 * transport contract are the library's rather than a reimplementation — and
 * so this needs no dependency beyond the one already here.
 */
export class CappedFileTransport extends BlankTransport implements LevelledTransport {
  constructor(path: string, capBytes: number, level: LogLevelType = "info") {
    super({
      id: "file",
      level,
      shipToLogger: (params) => {
        appendCapped(path, renderLine(params), capBytes);
        return params.messages;
      },
    });
  }
}

/**
 * The file writer the app logs through. Its `level` is the ONE thing the
 * debug toggle flips (`services/logging-preference.ts`); stdout's transport
 * stays pinned at `info` so the service manager's log never fills with debug
 * lines.
 */
export const serverLogFile: CappedFileTransport = new CappedFileTransport(serverLogPath(), SERVER_LOG_CAP_BYTES);
