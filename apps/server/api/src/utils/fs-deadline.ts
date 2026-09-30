/**
 * A deadline for the folder picker's filesystem reads.
 *
 * The picker walks arbitrary directories on the host, and a single blocking
 * syscall there is not a slow request — it is the whole server. The control
 * plane's event loop is one thread, so a synchronous `stat`/`readdir`/`realpath`
 * that parks in the kernel parks EVERYTHING: health checks, WebSockets, other
 * people's browse. Measured on mac-builder (2026-09-30): browsing a Linux-style
 * `/home/…` path made macOS's `auto_home` autofs mount attempt NFS-on-access
 * that never returned, the process sat in `openat`, and the instance read as
 * dead while the OS happily reported it "running".
 *
 * Two halves fix it, and this file is the second:
 *
 * 1. the reads themselves move to `node:fs/promises`, which run OFF the event
 *    loop (a threadpool worker), so a stuck mount stalls one request instead of
 *    the process;
 * 2. {@link withFsDeadline} bounds even that one request, so a mount that never
 *    answers cannot hold the picker open forever — it resolves as a named
 *    timeout the UI can offer a way out of.
 *
 * The abandoned read's thread is NOT reclaimable while the kernel holds it
 * (there is no interrupting an uninterruptible mount wait from userspace), so
 * repeated hits on a permanently-hung mount can occupy the fs threadpool. That
 * is the accepted DoS non-goal for a local/trusted tool (security §11): the
 * catastrophic failure — the whole instance wedged — is what this closes.
 */

/** A read that did not answer within {@link FS_READ_TIMEOUT_MS}. */
export class FsDeadlineError extends Error {
  constructor() {
    super("directory read timed out");
    this.name = "FsDeadlineError";
  }
}

/**
 * How long the picker will wait for one directory read before giving up on it.
 * Ten seconds: generous enough that a slow but healthy drive (a spinning disk
 * spinning up, a busy machine) still lists normally, short enough that a hung
 * network mount stops holding the panel open — and the event loop's one thread
 * is already free once the read moved off it, so this only bounds the request
 * the person is actually watching.
 */
export const FS_READ_TIMEOUT_MS = 10_000;

/**
 * Resolve the deadline: an explicit `ms` wins, then
 * `SUBSHELL_FS_READ_TIMEOUT_MS` if the operator (or a test) set it to a sane
 * positive number, else {@link FS_READ_TIMEOUT_MS}. A malformed or non-positive
 * env value is ignored rather than trusted — a typo must not turn the picker's
 * guard off (an unbounded read is exactly the wedge this file exists to stop).
 */
function deadlineFor(ms: number | undefined): number {
  if (ms !== undefined) return ms;
  const raw = process.env.SUBSHELL_FS_READ_TIMEOUT_MS?.trim();
  if (raw) {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return FS_READ_TIMEOUT_MS;
}

/**
 * Run `make` under a deadline. `make` returns the read's promise; if it has not
 * settled in `ms`, the returned promise rejects with {@link FsDeadlineError}
 * while the underlying read is left to finish (or never) on its own thread.
 *
 * The thunk (not a pre-started promise) keeps the timer and the syscall
 * starting on the same line, so a caller cannot accidentally race the clock
 * against work begun before the call.
 *
 * @param make - starts the fs operation and returns its promise
 * @param ms - deadline; defaults to {@link FS_READ_TIMEOUT_MS} (or the env
 *             override), so callers normally omit it and share one knob
 */
export function withFsDeadline<T>(make: () => Promise<T>, ms?: number): Promise<T> {
  const budget = deadlineFor(ms);
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new FsDeadlineError());
    }, budget);
    // Keep the timer from holding a test's event loop open past an early return.
    (timer as { unref?: () => void }).unref?.();
    make().then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}
