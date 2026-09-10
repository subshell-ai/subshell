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
  /** Raw stdout, untrimmed (empty when `truncated`: a capped read keeps no partial output) */
  text: string;
  /** Exit status, or null when the process was signalled */
  exitCode: number | null;
  /**
   * True when `maxBytes` was exceeded: the child was killed mid-stream and
   * nothing partial is retained. Every caller today needs the WHOLE answer
   * and treats this as a failed read; the day a head-only reader arrives,
   * retaining the read bytes is this branch's first change.
   */
  truncated?: boolean;
}

/**
 * Runs `cmd`, returning its stdout and exit code, or `null` when it could not
 * be spawned or did not finish in time.
 *
 * stdin and stderr are closed off deliberately: a diagnostic that can prompt
 * is a diagnostic that can hang, and nothing here reads stderr.
 * @param cmd - argv, the first element being the executable
 * @param timeoutMs - deadline after which the process is killed and `null` returned
 * @param maxBytes - optional output cap: once the child has produced more, it
 * is killed and the result is flagged `truncated` rather than read to the
 * end. A time bound alone lets a chatty-but-fast child hand the caller
 * megabytes the caller then has to carry (a version string rides a capped
 * protocol frame); the cap makes the budget real on SIZE, not just time.
 */
export async function readCommandBounded(
  cmd: string[],
  timeoutMs: number,
  maxBytes?: number,
): Promise<BoundedResult | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const proc = Bun.spawn({ cmd, stdout: "pipe", stderr: "ignore", stdin: "ignore" });

    const read = (async (): Promise<BoundedResult> => {
      if (maxBytes === undefined) {
        const text = await new Response(proc.stdout).text();
        await proc.exited;
        return { text, exitCode: proc.exitCode };
      }
      // Chunked read so the cap can stop the pipe, not just post-filter it:
      // an uncapped `Response.text()` allocates the whole stream first, which
      // is the memory the cap exists to refuse.
      const reader = proc.stdout.getReader();
      const chunks: Uint8Array[] = [];
      let total = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        chunks.push(value);
        total += value.byteLength;
        if (total > maxBytes) {
          // Past the cap: stop reading and stop the child. (Cancel and kill
          // are best-effort — a child that already exited or a stream already
          // closed have nothing to give up, and the verdict stands either
          // way.)
          void reader.cancel().catch(() => {});
          proc.kill();
          return { text: "", exitCode: null, truncated: true };
        }
      }
      await proc.exited;
      return { text: Buffer.concat(chunks).toString("utf8"), exitCode: proc.exitCode };
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
