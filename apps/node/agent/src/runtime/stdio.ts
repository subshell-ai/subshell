import { encodeSshSessionFrame, type SshRuntimeEventFrame, SshSessionFrameDecoder } from "@internal/subshell-protocol";

/**
 * The runtime's stdio discipline (design 2026-10-05 §2: "stdout is
 * protocol-only; stderr is diagnostic text forwarded to logs without
 * interpretation").
 *
 * Two rules, one module. FIRST: every byte this process writes to stdout goes
 * through {@link RuntimeWriter} - one writer, one codec, no interleaving (a
 * second writer would splice JSON). SECOND: the agent's `console`-transported
 * logger, which every reused executor imports and which writes to STDOUT,
 * is redirected to stderr for the life of a `runtime-serve` process. Without
 * the redirect one `log("tail pump failed")` line would land between frames
 * and the plane's fail-closed decoder would correctly kill the session, so
 * the redirect is not politeness, it is the protocol.
 */

export class RuntimeWriter {
  #out = Bun.stdout;
  /** Bytes written since stdout last reported drained; the tail pump's backpressure signal. */
  #backlog = 0;

  constructor() {
    // Bun's WriteStream surfaces `drain` the way Node's does; on drain the
    // backlog is not literally per-event accounting (there is no byte-count
    // callback), so one drain clears the whole signal: the pump resumes and
    // the NEXT saturated write re-arms the pause. Conservative in both
    // directions, which is what a backpressure signal is for.
    (Bun.stdout as unknown as { on?: (ev: string, cb: () => void) => void }).on?.("drain", () => {
      this.#backlog = 0;
    });
  }

  /** The queue depth the reused pumps read as `ws.bufferedAmount` (bytes awaiting drain). */
  get bufferedAmount(): number {
    return this.#backlog;
  }

  /** Write one protocol frame. Saturated stdout is recorded, never thrown into: a parked pump drains it. */
  writeFrame(frame: SshRuntimeEventFrame | unknown): void {
    const bytes = encodeSshSessionFrame(frame);
    const ok = this.#out.write(bytes) as unknown as boolean;
    if (ok === false) this.#backlog += bytes.byteLength;
  }
}

/**
 * Redirect the process's console to stderr for the whole runtime (see the
 * module doc for why the redirect is the protocol, not hygiene). Idempotent;
 * called once from the verb before any executor runs.
 */
export function redirectConsoleToStderr(): void {
  const toErr = (...args: unknown[]): void => {
    process.stderr.write(`${args.map((a) => (typeof a === "string" ? a : String(a))).join(" ")}\n`);
  };
  console.log = toErr;
  console.info = toErr;
  console.debug = toErr;
  console.warn = toErr;
  console.error = toErr;
}

/** One diagnostic line, stderr, timestamped like the agent's own log format. */
export function diag(message: string): void {
  process.stderr.write(`[subshell-runtime ${new Date().toISOString()}] ${message}\n`);
}

/**
 * The stdin frame reader: pull the byte stream through the shared codec and
 * hand complete parsed frames to the callback. A codec failure (the
 * session-protocol contract is fail-closed at both ends) stops the reader and
 * reports the reason; the serve loop treats it exactly like an EOF: the
 * session is over, close everything.
 *
 * @param onFrame - called per successfully parsed inbound frame
 * @param onDone - called once, with the reason the stream ended
 */
export function startStdinReader(
  onFrame: (frame: unknown) => void,
  onDone: (reason: "eof" | "codec" | string) => void,
): void {
  const decoder = new SshSessionFrameDecoder();
  void (async (): Promise<void> => {
    // `Bun.stdin` itself is not a stream in Bun 1.4 (no getReader on the
    // namespace object); `Bun.stdin.stream()` is the byte stream. Measured on
    // 1.4.2: the namespace object throws the reader lookup at the first push.
    const reader = Bun.stdin.stream().getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          onDone("eof");
          return;
        }
        if (value === undefined) continue;
        for (const frame of decoder.push(value)) onFrame(frame);
        const failure = decoder.failed;
        if (failure !== null) {
          onDone(`codec:${failure}`);
          return;
        }
      }
    } catch (err) {
      onDone(err instanceof Error ? err.message : String(err));
    }
  })();
}
