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
 * A single wall-clock budget shared by every read of one request.
 *
 * One deadline PER read lets a request stack them — gate (10s) + listing (10s)
 * + each saved-shortcut (10s) — so a pathological request answers only after
 * ~40s, which is not what "a 10 second timeout" promised. A request instead
 * mints ONE of these and threads its `signal` through each {@link withFsDeadline}
 * in the phase; the first read to overrun the SHARED clock fails the phase, and
 * a read that starts late gets only what the budget still has. {@link AbortSignal.timeout}'s
 * timer does not hold the event loop open.
 */
export function newReadBudget(ms?: number): AbortSignal {
  return AbortSignal.timeout(deadlineFor(ms));
}

/**
 * Run `make` under a deadline. If the operation has not settled before the
 * deadline, the returned promise rejects with {@link FsDeadlineError} while the
 * underlying read is left to finish (or never) on its own thread — there is no
 * interrupting an uninterruptible mount wait from userspace.
 *
 * The thunk (not a pre-started promise) keeps the timer and the syscall
 * starting on the same line, so a caller cannot accidentally race the clock
 * against work begun before the call.
 *
 * @param make - starts the fs operation and returns its promise
 * @param opts.signal - a shared {@link newReadBudget} signal; when supplied it
 *             is the ONLY clock (no per-call timer), so one budget bounds many
 * @param opts.ms - standalone deadline when no signal is given; defaults to
 *             {@link FS_READ_TIMEOUT_MS} (or the env override)
 */
export function withFsDeadline<T>(
  make: () => Promise<T>,
  opts: { signal?: AbortSignal; ms?: number } = {},
): Promise<T> {
  const { signal, ms } = opts;
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => {
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    const onAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new FsDeadlineError());
    };
    if (signal) {
      if (signal.aborted) {
        settled = true;
        reject(new FsDeadlineError());
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
    } else {
      timer = setTimeout(onAbort, deadlineFor(ms));
      // Keep the timer from holding a test's event loop open past an early return.
      (timer as { unref?: () => void }).unref?.();
    }
    try {
      // A thunk that THROWS SYNCHRONOUSLY still settles cleanly (and clears the
      // timer/listener) rather than leaving one to fire onto a settled promise.
      make().then(
        (value) => {
          if (settled) return;
          settled = true;
          cleanup();
          resolve(value);
        },
        (err) => {
          if (settled) return;
          settled = true;
          cleanup();
          reject(err);
        },
      );
    } catch (err) {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    }
  });
}
