/**
 * Running a short command with a deadline that actually holds.
 *
 * Detection spawns two kinds of subprocess: a harness's `--version`, and the
 * login shell that reports a user's PATH. Both are diagnostics on a polled
 * surface, so neither may block a request, and both originally used the same
 * pattern:
 *
 * ```ts
 * const timer = setTimeout(() => proc.kill(), MS);
 * const text = await new Response(proc.stdout).text();
 * ```
 *
 * **That is not a deadline.** Killing a process does not close a pipe its
 * CHILDREN still hold, so `sh -c "sleep 30"` leaves the read pending forever
 * and the timeout never takes effect. Measured: the version probe's own
 * timeout test hung for the full test-runner budget until this raced the read
 * instead. A login profile that backgrounds anything has the same shape.
 */

/** Sentinel for the deadline branch, so empty output cannot be read as a timeout. */
const TIMED_OUT = Symbol("bounded-exec-timeout");

/** What a completed command produced. */
export interface BoundedResult {
  /** Raw stdout, untrimmed */
  text: string;
  /** Exit status, or null when the process was signalled */
  exitCode: number | null;
}

/**
 * Runs `cmd`, returning its stdout and exit code, or `null` when it could not
 * be spawned or did not finish in time.
 *
 * stdin and stderr are closed off deliberately: a diagnostic that can prompt
 * is a diagnostic that can hang, and nothing here reads stderr.
 * @param cmd - argv, the first element being the executable
 * @param timeoutMs - deadline after which the process is killed and `null` returned
 */
export async function readCommandBounded(cmd: string[], timeoutMs: number): Promise<BoundedResult | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const proc = Bun.spawn({ cmd, stdout: "pipe", stderr: "ignore", stdin: "ignore" });

    const read = (async (): Promise<BoundedResult> => {
      const text = await new Response(proc.stdout).text();
      await proc.exited;
      return { text, exitCode: proc.exitCode };
    })();
    const expired = new Promise<typeof TIMED_OUT>((resolve) => {
      timer = setTimeout(() => resolve(TIMED_OUT), timeoutMs);
    });

    const result = await Promise.race([read, expired]);
    if (result === TIMED_OUT) {
      proc.kill();
      return null;
    }
    return result;
  } catch {
    return null;
  } finally {
    // Without this, a pending timer keeps the loop alive for its full budget on
    // every SUCCESSFUL call, which a scan makes once per installed harness.
    if (timer !== undefined) clearTimeout(timer);
  }
}
