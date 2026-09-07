import { ConsoleTransport, type ILogLayer, LogLayer } from "loglayer";

/**
 * Builds the agent's log transport.
 *
 * A factory rather than an inline literal so tests can rebuild the SAME
 * transport around a recording sink (`__tests__/helpers/capture-logs.ts`) —
 * the alternative was spying on the global `console`, which pins the tests to
 * whichever console method the logging library happens to call.
 *
 * `messageFn` reproduces the previously hand-rolled line EXACTLY —
 * `[subshell <ISO>] <message>` — because moving to LogLayer is a change of
 * mechanism, not of output: this stream is read by whoever runs `subshell run`
 * and by systemd/launchd, and launchd's log file adds no timestamp of its own,
 * so the agent has to stamp its own lines.
 *
 * @param sink - where lines go (default: the real console)
 * @returns A transport writing `[subshell <ISO>] …` lines to that sink
 */
export function createLogTransport(sink: typeof console = console): ConsoleTransport {
  return new ConsoleTransport({
    logger: sink,
    // Errors and metadata AFTER the line they belong to. The default prepends
    // them, which puts a multi-line serialized error in front of the sentence
    // saying what failed — unreadable in a journal, where these are read in
    // sequence.
    appendObjectData: true,
    messageFn: ({ messages }) => `[subshell ${new Date().toISOString()}] ${messages.join(" ")}`,
  });
}

/**
 * The agent's logger.
 *
 * LogLayer with the CORE `ConsoleTransport` — both ship in the `loglayer`
 * package itself, so the agent takes on no third-party dependency for this.
 * That matters more here than on the server: this module is bundled into a
 * `bun build --compile --bytecode` binary cross-built for four triples, and
 * every dependency is weight in an artifact operators download.
 *
 * What it buys over the raw `console.log` it replaced: levels, `withError()`
 * serialization, `withMetadata()`, and a transport that can be swapped without
 * touching a call site — which is exactly what the test helper does.
 */
export const logger: ILogLayer = new LogLayer({
  transport: createLogTransport(),
  // Serialize errors to PLAIN STRINGS ourselves. Handing the console a raw
  // Error makes Bun's inspector render source context, which inside a
  // `--compile --bytecode` binary is the whole minified bundle — measured: one
  // `withError()` call printed ~25 KB of bundled source in front of the stack.
  // The server solves this with `serialize-error`; the agent will not take a
  // dependency for four lines, and this keeps the fields that survive
  // compilation anyway (AGENTS.md notes the compiled bundle's stack header
  // drops the message, so `message` is carried explicitly).
  errorSerializer: (err: unknown) => {
    const e = err instanceof Error ? err : new Error(String(err));
    return { name: e.name, message: e.message, stack: e.stack ?? "" };
  },
});

/**
 * Emit one timestamped daemon log line.
 *
 * Kept as a free function over {@link logger} because it is the agent's most
 * common call by an order of magnitude and reads better than `logger.info` at
 * every site. Anything needing a level, an error or structured fields should
 * use {@link logger} directly.
 *
 * Lives in its own module (moved out of daemon.ts) because the daemon sits at
 * the top of the import graph — anything downstream that needs to log would
 * otherwise close a cycle through it. daemon.ts re-exports it for its
 * historical importers.
 *
 * @param message - the line to emit, already formatted
 */
export function log(message: string): void {
  logger.info(message);
}
