import { type FSWatcher, watch } from "node:fs";
import type { JsonValue, NodeCommandBody, NodeEvent, NodeLogReadResult } from "@internal/session-protocol";
import { log } from "../log.js";
import { isSessionId } from "../session-meta.js";
import type { CommandContext, CommandResult, TailHandle } from "./context.js";

/**
 * The `log_read` + `tail_start`/`tail_stop` executors (spec 2026-08-31 §3.1/§3.4)
 * — the agent-side twin of `LocalLauncher.readLog`/`tailStart`. The pump is a
 * port of `LocalLauncher.tailStart` (itself the WS attach pump from
 * `ws/session-ws.ts`): `fs.watch` (inotify on Linux) fires the moment
 * pipe-pane appends, a slow interval covers lost watch events, and both paths
 * share the size-based read with `pumping`/`again` flags so a byte is never
 * sliced twice. The wire differences (spec §3.1): each read slice is chunked
 * to ≤ {@link TAIL_CHUNK_BYTES} RAW bytes per `output` event (base64 in
 * `data_b64`), and the pump throttles on `ctx.ws.bufferedAmount` before every
 * event so a slow control plane cannot make the agent buffer unboundedly.
 */

/** Narrowing alias for one command's executor signature (same pattern as basics.ts). */
type Cmd<T extends NodeCommandBody["type"]> = Extract<NodeCommandBody, { type: T }>;

/** Max RAW bytes carried by ONE `output` event (spec §3.1; base64 inflates ~4/3 on the wire). */
export const TAIL_CHUNK_BYTES = 192 * 1024;

/** Queue depth above which the pump pauses before sending (agent-side mirror of the spec's backpressure). */
export const TAIL_BACKPRESSURE_BYTES = 512 * 1024;

/** Safety net for missed watch events — same value the backend's log-tail pump uses. */
export const TAIL_BACKSTOP_MS = 1_000;

/** Re-check cadence inside the backpressure wait. */
const TAIL_BACKPRESSURE_POLL_MS = 50;

/** Consecutive `send` throws that self-stop a sub (a dead ws must not be pumped into forever). */
const TAIL_SEND_FAILURE_LIMIT = 2;

/**
 * `log_read` (spec §3.4): one byte window of the session's pane log with the
 * offset a sequential reader should ask for next. A missing/unreadable log is
 * a VALID EMPTY read (`size: 0`), never an error — same rule as
 * `readLogTailFrom`, so a relay never special-cases the race between "pane
 * died" and "log unlinked". `next` is the requested offset clamped to `size`:
 * the `parseNodeLogReadResult` contract forbids an empty read reporting past
 * EOF, which a file truncated since the reader's last call would otherwise
 * produce.
 * @param ctx - the per-daemon execution context (owns the meta store)
 * @param cmd - the verified `log_read` command
 * @returns `{ok:true, data:{bytes_b64, next, size}}`, or `{ok:false}` on a malformed id
 */
export async function execLogRead(ctx: CommandContext, cmd: Cmd<"log_read">): Promise<CommandResult> {
  if (!isSessionId(cmd.sessionId)) return { ok: false, error: "invalid session id" };
  const file = Bun.file(ctx.meta.logPath(cmd.sessionId));
  // The result shapes are JSON-safe by construction (`node-results.ts` owns
  // them); an interface cannot structurally satisfy JsonValue's index
  // signature, so the seam cast is the intended route (same as execProbe).
  const empty = (size: number): CommandResult => {
    const data: NodeLogReadResult = { bytes_b64: "", next: Math.min(cmd.fromByte, size), size };
    return { ok: true, data: data as unknown as JsonValue };
  };
  const size = file.size; // Bun yields 0 for a missing file — the empty-read path covers it
  if (size === 0 || cmd.fromByte >= size) return empty(size);
  const end = Math.min(size, cmd.fromByte + cmd.maxBytes);
  try {
    const bytes = await file.slice(cmd.fromByte, end).bytes();
    const data: NodeLogReadResult = {
      bytes_b64: Buffer.from(bytes).toString("base64"),
      next: cmd.fromByte + bytes.byteLength,
      size,
    };
    return { ok: true, data: data as unknown as JsonValue };
  } catch {
    return empty(size); // raced unlink between stat and slice — reads as empty, as the local twin does
  }
}

/**
 * `tail_start` (spec §3.4): register a pump streaming the pane log from
 * `fromByte` onward as `output` events, keyed by `subId` in `ctx.tails`. A
 * duplicate `subId` replaces the old handle (stop-then-register — defensive;
 * the serial executor makes true concurrency impossible, but a stale entry
 * must never keep streaming into the same sub). The result does NOT await the
 * initial catch-up read: the pump runs it in the background, so a stuffed
 * socket (backpressure wait) cannot stall the daemon's serial command chain
 * behind a slow control plane.
 * @param ctx - the per-daemon execution context (ws seam + tails map)
 * @param cmd - the verified `tail_start` command
 * @returns `{ok:true}` once the pump is registered, or `{ok:false}` on a malformed id
 */
export async function execTailStart(ctx: CommandContext, cmd: Cmd<"tail_start">): Promise<CommandResult> {
  if (!isSessionId(cmd.sessionId)) return { ok: false, error: "invalid session id" };
  const logFile = ctx.meta.logPath(cmd.sessionId);

  // Replace-with-stop on dup subId (defensive; see JSDoc).
  const prev = ctx.tails.get(cmd.subId);
  if (prev) {
    try {
      prev.stop();
    } catch {
      /* idempotent by contract; belt against a throwing pump */
    }
  }

  // Watch events and the backstop can land together; `pumping`/`again` serialize
  // the reads so a byte is never sliced twice (port of LocalLauncher.tailStart).
  let pumping = false;
  let again = false;
  let stopped = false;
  let last = cmd.fromByte;
  let everSeen = false; // the log may not exist yet (pipe-pane has not run); only a VANISHED log is terminal
  let sendFailures = 0;

  const handle: TailHandle = {
    sessionId: cmd.sessionId,
    stop: (): void => {
      if (stopped) return;
      stopped = true;
      try {
        watcher?.close();
      } catch {
        /* already closed */
      }
      clearInterval(timer);
      if (ctx.tails.get(cmd.subId) === handle) ctx.tails.delete(cmd.subId); // identity-guarded: a replaced pump must not evict its successor
    },
  };

  const pump = async (): Promise<void> => {
    if (stopped) return;
    if (pumping) {
      again = true;
      return;
    }
    pumping = true;
    do {
      again = false;
      let size: number;
      try {
        size = (await Bun.file(logFile).stat()).size;
      } catch {
        if (everSeen) {
          stopAndFinish(); // the log vanished mid-stream (cleanup race) — stop this sub cleanly
          return;
        }
        break; // not created yet — the watch/backstop will pick it up when it appears
      }
      everSeen = true;
      if (size > last) {
        let bytes: Uint8Array;
        try {
          bytes = await Bun.file(logFile).slice(last, size).bytes();
        } catch {
          stopAndFinish(); // vanished between stat and slice — same terminal as above
          return;
        }
        if (stopped) {
          pumping = false;
          return; // disposed mid-read: the bytes belong to the next subscriber (fresh fromByte)
        }
        // `cursor` walks the slice independently of `last`: `last` only moves on
        // a successful send (retry point), so fromByte must not be `last + off`.
        for (let off = 0, cursor = last; off < bytes.byteLength && !stopped; off += TAIL_CHUNK_BYTES) {
          const n = Math.min(TAIL_CHUNK_BYTES, bytes.byteLength - off);
          const fromByte = cursor;
          const toByte = cursor + n;
          // Throttle on socket backpressure before EVERY event (spec §3.1 mirror);
          // bounded only by stop/shutdown.
          while (!stopped && (ctx.ws.bufferedAmount ?? 0) > TAIL_BACKPRESSURE_BYTES) {
            await Bun.sleep(TAIL_BACKPRESSURE_POLL_MS);
          }
          if (stopped) {
            pumping = false;
            return;
          }
          try {
            const ev: Extract<NodeEvent, { type: "output" }> = {
              type: "output",
              sessionId: cmd.sessionId,
              subId: cmd.subId,
              fromByte,
              toByte,
              data_b64: Buffer.from(bytes.subarray(off, off + n)).toString("base64"),
            };
            ctx.ws.send(ev);
            sendFailures = 0;
            last = toByte; // the retry cursor advances only on a SUCCESSFUL send — a failed chunk is re-read, never skipped
            cursor = toByte;
          } catch {
            sendFailures += 1;
            if (sendFailures >= TAIL_SEND_FAILURE_LIMIT) {
              stopAndFinish(); // twice in a row → the ws is gone; self-stop rather than pump into a dead socket
              return;
            }
            break; // one throw reads as transient: retry this window on the next watch/backstop tick
          }
        }
      }
    } while (again && !stopped);
    pumping = false;
  };
  const stopAndFinish = (): void => {
    pumping = false;
    handle.stop();
  };
  const pumpFailed = (err: unknown): void =>
    log(`tail pump ${cmd.subId} failed: ${err instanceof Error ? err.message : String(err)}`);

  let watcher: FSWatcher | null = null;
  try {
    watcher = watch(logFile, () => void pump().catch(pumpFailed));
    // If the inode dies the watcher is dead weight; the backstop still delivers.
    watcher.on("error", () => {
      try {
        watcher?.close();
      } catch {
        /* already gone */
      }
      watcher = null;
    });
  } catch {
    watcher = null; // file not created yet — the backstop interval carries the pump until it appears
  }
  const timer = setInterval(() => void pump().catch(pumpFailed), TAIL_BACKSTOP_MS);
  timer.unref?.(); // a tail must never hold the daemon (or a test process) open on its own
  ctx.tails.set(cmd.subId, handle);
  void pump().catch(pumpFailed); // immediate catch-up read, NOT awaited (see JSDoc)
  return { ok: true };
}

/**
 * `tail_stop` (spec §3.4): stop + forget one pump. An unknown `subId` is not
 * an error — stop is idempotent, so replayed cleanup converges.
 * @param ctx - the per-daemon execution context (owns the tails map)
 * @param cmd - the verified `tail_stop` command
 * @returns `{ok:true}` always
 */
export async function execTailStop(ctx: CommandContext, cmd: Cmd<"tail_stop">): Promise<CommandResult> {
  const handle = ctx.tails.get(cmd.subId);
  if (handle) {
    try {
      handle.stop();
    } catch {
      /* nothing left to stop */
    }
    ctx.tails.delete(cmd.subId);
  }
  return { ok: true };
}

/**
 * Stop every live pump (daemon close path: on a socket drop, tails would
 * otherwise push into a dead ws; the backend re-subscribes after reconnect).
 * @param ctx - the per-daemon execution context
 */
export function stopAllTails(ctx: CommandContext): void {
  for (const [, handle] of [...ctx.tails]) {
    try {
      handle.stop();
    } catch {
      /* nothing left to stop */
    }
  }
  ctx.tails.clear();
}
