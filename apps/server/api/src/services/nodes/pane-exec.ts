/**
 * The exec protocol, pure (spec 2026-10-02 §1). The pane's shell is dumb on
 * purpose; completion is machinery, and all of it lives here: the sentinel
 * line the plane types, the ACCUMULATED recognition (S1's liveness rule can
 * split the answer line across two cursor reads, so matching runs over the
 * merged line stream, never per window; a per-read match would answer a
 * finished command with a silent false timeout), the quiet probe that decides
 * whether anything may be typed yet, and the bounded wait loop. No launcher,
 * no DB, no Elysia: the service composes these over the LogWindowReader seam.
 */

import { cursorLinesFromWindow, LOG_WINDOW_DEFAULT_BYTES, type LogWindowReader } from "./log-tail.js";

/** A pane whose log size moved within this window is producing; typing now risks corruption. */
export const EXEC_QUIET_MS = 1_000;
/** Default wait for the sentinel; the caller may ask shorter or longer, never outside the clamp. */
export const EXEC_TIMEOUT_MS = 30_000;
export const EXEC_TIMEOUT_MIN = 1_000;
export const EXEC_TIMEOUT_MAX = 300_000;
/**
 * Poll cadence. Deliberately NOT `TAIL_POLL_MS` (50): that is the ATTACHED
 * pump's local stat-poll, and every remote exec poll is a SIGNED log_read
 * round trip - 500 ms bounds a max-timeout remote exec at 600 command frames
 * instead of thousands.
 */
export const EXEC_POLL_MS = 500;
/** The `output` keeps the newest lines inside this cap (the log-tail precedent). */
export const EXEC_MAX_OUTPUT_BYTES = 256 * 1024;

const TOKEN_RE = /^[0-9a-f]{16}$/;

/** One fresh sentinel token per exec; unguessable, so nothing else can complete the line. */
export function execSentinelToken(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** The lone printf line typed after the command. `$?` is read when the shell parses THIS line. */
export function execSentinelCommand(token: string): string {
  if (!TOKEN_RE.test(token)) throw new Error("exec: sentinel token must be 16 lowercase hex chars");
  return `printf '__xcomm_${token}_DONE rc=%s\\n' "$?"`;
}

/** S1's liveness branch: a window with no newline returns its text partial and advances. */
export function windowIsPartial(bytes: Uint8Array): boolean {
  return bytes.byteLength > 0 && bytes.lastIndexOf(0x0a) === -1;
}

export interface SentinelScanner {
  /** Feed one read's stripped lines; a hit reports the rc and the line's index IN THIS WINDOW. */
  push(lines: string[], partialLast: boolean): { rc: number; hitInWindow: number } | null;
  /** Every completed non-sentinel line consumed so far. */
  output(): string[];
  /** The unterminated tail held so far ("" when none). The caller's liveness cursor already sits past it. */
  pending(): string;
}

/**
 * Recognition over the merged stream. A partial tail line is CARRIED, never
 * matched (its remainder arrives as the next read's leading line and the two
 * are joined before the anchored test); the typed echo cannot match because
 * it carries quotes and a literal `$?` and sits behind prompt bytes.
 */
export function createSentinelScanner(token: string): SentinelScanner {
  const re = new RegExp(`^__xcomm_${token}_DONE rc=([0-9]+)$`);
  const out: string[] = [];
  let carry = "";
  return {
    push(lines, partialLast) {
      const complete = partialLast ? lines.slice(0, -1) : lines;
      const tail = partialLast ? (lines.at(-1) ?? "") : "";
      for (let i = 0; i < complete.length; i++) {
        const line = (i === 0 ? carry : "") + complete[i];
        carry = "";
        const m = re.exec(line);
        if (m) return { rc: Number(m[1]), hitInWindow: i };
        out.push(line);
      }
      carry += tail;
      return null;
    },
    output: () => out,
    pending: () => carry,
  };
}

/** Route-side clamp: absent means the default; out-of-range is pulled in, never refused. */
export function execTimeoutMs(requested: number | undefined): number {
  if (requested === undefined) return EXEC_TIMEOUT_MS;
  return Math.min(EXEC_TIMEOUT_MAX, Math.max(EXEC_TIMEOUT_MIN, Math.trunc(requested)));
}

/**
 * Two tiny reads at least `EXEC_QUIET_MS` apart; an unchanged whole-file size
 * across them is the quiet verdict (remote logs carry no mtime, so size is
 * the only shared signal both launchers can answer). `size` is the start
 * offset the caller sends from.
 */
export async function probeQuiet(
  read: LogWindowReader,
  sleep: (ms: number) => Promise<void>,
): Promise<{ quiet: boolean; size: number }> {
  const a = await read(0, 1);
  await sleep(EXEC_QUIET_MS);
  const b = await read(0, 1);
  return { quiet: a.size === b.size, size: b.size };
}

export interface ExecWaitAnswer {
  status: "completed" | "timed_out";
  rc: number | null;
  outputLines: string[];
  nextByte: number;
}

/**
 * Poll windows from `startByte` until the sentinel completes or the deadline
 * passes. `nextByte` on a hit is the offset right AFTER the sentinel line's
 * newline, found by walking the raw window (stripped lines correspond 1:1 to
 * raw newline-separated lines; ANSI runs do not contain newlines in practice,
 * and the answer line itself is plain bytes printf wrote). On a miss it is
 * where the scan stopped. `alive` false ends the wait early: polling a dead
 * pane's log is reading noise, and stopping touches nothing (ruling 2).
 * A timed-out answer also reports the scanner's carried partial line as its
 * final output line: the liveness branch already advanced `nextByte` past
 * those bytes, so no follow-up read would ever return them and the caller
 * would silently lose the pane's newest text. Never on the completed path —
 * a hit proves the sentinel line was newline-terminated in-window, so the
 * carry is empty there by construction.
 */
export async function waitSentinel(
  read: LogWindowReader,
  token: string,
  startByte: number,
  opts: {
    timeoutMs: number;
    sleep: (ms: number) => Promise<void>;
    now: () => number;
    alive?: () => Promise<boolean>;
  },
): Promise<ExecWaitAnswer> {
  const scanner = createSentinelScanner(token);
  const deadline = opts.now() + opts.timeoutMs;
  let cursor = startByte;
  // One shape for both miss exits. `cursor` is read at call time, so each
  // return reports exactly where that branch's scan stopped.
  const timedOut = (): ExecWaitAnswer => {
    const carried = scanner.pending();
    return {
      status: "timed_out",
      rc: null,
      outputLines: carried === "" ? scanner.output() : [...scanner.output(), carried],
      nextByte: cursor,
    };
  };
  for (;;) {
    if (opts.alive && !(await opts.alive())) {
      return timedOut();
    }
    const { bytes, size } = await read(cursor, LOG_WINDOW_DEFAULT_BYTES);
    const { lines, nextByte } = cursorLinesFromWindow(bytes, cursor, size);
    if (lines.length > 0) {
      const hit = scanner.push(lines, windowIsPartial(bytes));
      if (hit) {
        // The consumed portion of the window ends at its last newline; the
        // sentinel is the (hitInWindow+1)-th line of it, so summing raw line
        // lengths plus their newlines lands exactly after the sentinel.
        const consumed = bytes.subarray(0, nextByte - cursor);
        let after = 0;
        for (let seen = 0; seen <= hit.hitInWindow; ) {
          const nl = consumed.subarray(after).indexOf(0x0a);
          if (nl === -1) break; // unreachable on a hit: matched lines were complete
          after += nl + 1;
          seen++;
        }
        return {
          status: "completed",
          rc: hit.rc,
          outputLines: scanner.output(),
          nextByte: cursor + after,
        };
      }
      cursor = nextByte;
    }
    if (opts.now() >= deadline) {
      return timedOut();
    }
    await opts.sleep(EXEC_POLL_MS);
  }
}

/** Keep whole lines newest-first inside the byte cap; past it, the head is dropped and named. */
export function execOutputTail(lines: string[], capBytes: number): { text: string; truncated: boolean } {
  const total = lines.reduce((n, l) => n + l.length + 1, 0) - (lines.length > 0 ? 1 : 0);
  if (total <= capBytes) return { text: lines.join("\n"), truncated: false };
  let size = -1; // first join adds nothing before line 0; track as sum(len+1), fix at the end
  let start = lines.length;
  for (let i = lines.length - 1; i >= 0; i--) {
    size += lines[i].length + 1;
    if (size > capBytes) break;
    start = i;
  }
  const kept = lines.slice(start);
  return { text: kept.join("\n"), truncated: true };
}
