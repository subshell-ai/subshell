import { closeSync, constants, openSync, readSync, writeSync } from "node:fs";

/**
 * The CLI verb that runs {@link appendStdinToLogFile} on both binaries
 * (`subshell` and `subshell-server`). Defined here — beside the function it
 * runs and the flag it takes — so the pipe-pane command built in
 * `tmux-runner.ts`, the two CLI dispatchers, and the launch call sites all name
 * ONE word rather than agreeing on a string three times.
 */
export const PANE_LOG_VERB = "pane-log";

/** How the output path reaches the verb. Every node/server verb is flag-based (no bare positional), so the child is `<self> pane-log --file <path>`. */
export const PANE_LOG_FILE_FLAG = "--file";

/** Read size. A blocking `readSync` returns whatever is buffered (a keystroke echo, or a whole burst), never waiting to fill this. */
const READ_SIZE = 64 * 1024;

/**
 * Stream this process's stdin to `path`, appending, and flushing **every read**
 * — the child `tmux pipe-pane` runs to capture one subshell's output to its log
 * file (which the control plane then tails into the browser's live view).
 *
 * Why this exists rather than `cat >>`: `/usr/bin/cat` on some Linux hosts is
 * **uutils coreutils** (`coreutils-from-uutils`), not GNU — and uutils `cat`
 * does not flush a *partial* write to a regular file; it holds bytes until EOF
 * or a large block. A terminal's keystroke echoes are exactly that — tiny,
 * newline-less writes — so `cat >>` freezes the pane log (and the browser's
 * live view) until an Enter-sized burst finally flushes it. GNU and BSD `cat`
 * write each block immediately, which is why the same product stream fine on a
 * host with either. This function is that GNU/BSD semantics — a plain blocking
 * `readSync` → `writeSync` loop, no `splice`, no stdio buffering, binary-safe —
 * so the capture is identical on macOS and Linux regardless of which `cat` (if
 * any) is installed.
 *
 * The file is opened `0600`. `O_WRONLY | O_CREAT | O_APPEND` with mode `0o600`
 * cannot be widened by the caller's umask (umask only clears bits, and `0600`
 * carries no group/other bits to clear), so the transcript of everything the
 * operator typed is never group- or world-readable, not even briefly. The
 * `umask 077` still wrapped around the exec in `pipePane` is belt-and-suspenders
 * for a child that might create the file another way.
 *
 * Returns when stdin reaches EOF — the pane died, or `pipe-pane` was re-armed
 * and closed this pipe — so a re-armed or retired capture never leaks a child.
 *
 * @param path - the pane's log file to append to
 */
export function appendStdinToLogFile(path: string): void {
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND, 0o600);
  const buf = Buffer.allocUnsafe(READ_SIZE);
  try {
    for (;;) {
      let n: number;
      try {
        // Position must be null for a pipe/socket; a blocking read returns as
        // soon as ≥1 byte is available (so a keystroke echo flushes on arrival).
        n = readSync(0, buf, 0, buf.length, null);
      } catch (err) {
        // A non-blocking stdin (should not happen — tmux gives the child a
        // blocking end) would raise EAGAIN; treat it as "nothing yet".
        if ((err as NodeJS.ErrnoException).code === "EAGAIN") {
          Bun.sleepSync(2);
          continue;
        }
        throw err;
      }
      if (n === 0) break; // stdin closed
      writeSync(fd, buf, 0, n); // unbuffered: the byte count lands now
    }
  } finally {
    closeSync(fd);
  }
}
