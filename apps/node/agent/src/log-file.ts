import { appendFileSync, chmodSync, existsSync, mkdirSync, statSync, truncateSync } from "node:fs";
import { open, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { BlankTransport, type LogLayerTransportParams, type LogLevelType } from "loglayer";
import { clientHome } from "./config.js";

/**
 * The agent's own log file: ONE file, JSON lines, capped and REPLACED when
 * full (spec 2026-09-12, node half § 4).
 *
 * **Why this exists at all.** The agent logs to the console, and what happens
 * to that console is a different thing on every platform: launchd redirects it
 * to a file, systemd hands it to the journal, a container sends it nowhere in
 * particular. `collectRuntime` reports `logHint` — a sentence telling a person
 * to go run `journalctl` — precisely because under systemd there IS no file to
 * name. Most nodes are headless, so "read this machine's log" has to work from
 * a browser, and it cannot be built on an artifact that only exists on macOS.
 *
 * The console transport stays beside this one: journald and launchd keep their
 * copy and `subshell run` in a terminal is unchanged.
 *
 * **A deliberate copy of `apps/server/api/src/utils/log-file.ts`, not an
 * import.** That file is AGPL (everything under `apps/server/**` is), this app
 * is Apache-2.0, and an Apache package may reach into the server only for
 * TYPES — so importing the value would entangle the two licences for the sake
 * of sixty lines. Same reasoning, and same shape, as `legal.rs` beside
 * `legal.ts`. Moving it into a shared package instead would relicense it
 * permanently, which `AGENTS.md` says to decide rather than discover.
 */

/** Size at which the file is replaced. The server's own cap, for the same reasons. */
export const AGENT_LOG_CAP_BYTES = 204_800;

/**
 * `<configHome>/logs/agent.log` — one file, every platform.
 *
 * Under the CONFIG home rather than the configured `dataDir`, because logging
 * starts before `config.json` is read and has to work on a machine that has
 * never been enrolled: a daemon that cannot say why it failed to load its
 * config is the one you most need the log for. The directory is the one
 * `saveConfig` already keeps at 0700.
 */
export function agentLogPath(): string {
  return join(clientHome(), "logs", "agent.log");
}

/**
 * Render one log call as a single JSON line.
 *
 * Field names match the server's file, so the two are readable with the same
 * `jq` and the plane's log view needs one parser rather than two.
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
 * Truncation starts a NEW file rather than dropping the oldest lines — that is
 * what "replaced when full" means, and it is why a reader's byte offset can go
 * stale (see {@link readAgentLogSlice}).
 *
 * Synchronous, like the pane-log pipe: a line lost to buffering at a crash is
 * the line that explains the crash. The directory is created on first write
 * rather than at import, because this module is in the CLI entry graph and
 * that graph must stay free of IO at import — the rule
 * `apps/server/api/AGENTS.md` pins by test for the server binary and that the
 * agent's `mcp` subcommand depends on just as much.
 */
function appendCapped(path: string, line: string, capBytes: number): void {
  let size = 0;
  try {
    size = statSync(path).size;
  } catch {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  }
  if (size > 0 && size + line.length > capBytes) {
    truncateSync(path, 0);
    size = 0;
  }
  appendFileSync(path, line, { mode: 0o600 });
  // The creation mode is umask-clamped, so assert 0600 on a file we just
  // created. It holds whatever the agent logged about this machine.
  if (size === 0) chmodSync(path, 0o600);
}

/**
 * A size-capped JSON-lines appender, as a LogLayer transport.
 *
 * Built on `BlankTransport` — loglayer's own `LoggerlessTransport` with a
 * supplied `shipToLogger` — so the level gate and the transport contract are
 * the library's. No new dependency: `loglayer` is already here, which matters
 * in an artifact operators download for four triples.
 *
 * **`level` is the one thing the debug switch touches**, exactly as on the
 * server (`apps/server/api/src/utils/log-file.ts`). It was omitted here, and
 * the omission was invisible: with no level passed, LoggerlessTransport treats
 * an absent level as `trace`, so this wrote whatever it was handed — which is
 * only ever `info` today, because the agent has no debug-level call sites.
 * The console transport beside it is never touched, so what journald or
 * launchd collect stays at `info` whatever this says.
 */
export class CappedFileTransport extends BlankTransport implements LevelledTransport {
  constructor(path: string, capBytes: number, level: LogLevelType = "info") {
    super({
      id: "agent-log-file",
      level,
      shipToLogger: (params) => {
        try {
          appendCapped(path, renderLine(params), capBytes);
        } catch {
          // A log write must never take the daemon down, and it must never
          // recurse into the logger to say so. The console transport beside
          // this one still has the line.
        }
        return params.messages;
      },
    });
  }
}

/**
 * What the debug toggle touches on the writer, and the only thing it touches.
 *
 * Optional because that is how LogLayer's own `LoggerlessTransport` declares
 * it (an absent level means "trace"); the toggle always writes a concrete one.
 * The server declares the same interface for the same reason — see the licence
 * note at the top of this file for why this is a copy rather than an import.
 */
export interface LevelledTransport {
  /** Minimum level this transport writes. */
  level?: LogLevelType;
}

/** What {@link readAgentLogSlice} answers. */
export interface AgentLogSlice {
  text: string;
  nextByte: number;
  size: number;
  truncated: boolean;
}

/**
 * Read a byte range of the log file.
 *
 * A RANGE rather than a line tail, because the caller polls: the plane's log
 * view holds an offset and asks for what arrived since, which is one read of
 * the new bytes instead of the whole file each time.
 *
 * `truncated` is the flag that makes that safe across a replacement. The file
 * is truncated rather than rotated at the cap, so an offset taken before a
 * replacement does not point at older content — it points past the end of a
 * now-shorter file, and the only correct answer is "start over". Without this
 * a reader would sit at a stale offset reporting an empty tail forever.
 *
 * A missing file is empty, never an error: the agent may simply not have
 * logged anything yet.
 */
export async function readAgentLogSlice(path: string, fromByte: number, maxBytes: number): Promise<AgentLogSlice> {
  if (!existsSync(path)) return { text: "", nextByte: 0, size: 0, truncated: false };
  const size = (await stat(path)).size;
  if (fromByte > size) return { text: "", nextByte: 0, size, truncated: true };
  const start = Math.max(0, Math.min(fromByte, size));
  const length = Math.min(maxBytes, size - start);
  if (length <= 0) return { text: "", nextByte: start, size, truncated: false };
  const handle = await open(path, "r");
  try {
    const buf = Buffer.alloc(length);
    await handle.read(buf, 0, length, start);
    return { text: buf.toString("utf8"), nextByte: start + length, size, truncated: false };
  } finally {
    await handle.close();
  }
}
