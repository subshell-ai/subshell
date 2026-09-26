import { getSimplePrettyTerminal } from "@loglayer/transport-simple-pretty-terminal";
import { ConsoleTransport, type ILogLayer, LogLayer } from "loglayer";
import { serializeError } from "serialize-error";
import { IS_TEST } from "@/constants.js";
import { type LevelledTransport, serverLogFile } from "@/utils/log-file.js";

// Raised at `info` for every manager-collected day: the debug switch
// governs the FILE only (spec 2026-09-12 § 3.4), so a debug session never
// fills the journal and `logger.debug(…)` reaches the file without reaching
// stdout. The ONE exception is deliberate and per-process: `subshell-server
// --verbose` (2026-09-26) raises THIS transport to debug for the life of the
// run an operator invoked by hand — it cannot reach a systemd/launchd unit
// (their ExecStarts carry no such flag), so a service's journal stays clean.
const transport = getSimplePrettyTerminal({ runtime: "node", id: "pretty", level: "info" });

/**
 * The `--verbose` switch (2026-09-26): raise THIS transport's gate to debug
 * for the life of a run an operator invoked by hand. It mirrors
 * `applyDebugLogging` and deliberately does not call it: that function owns
 * the FILE transport, the settings row, and the env-forced read-only rule,
 * and `--verbose` engages none of them. The mutation is the same public
 * `level` field the library gates on (the shape `LevelledTransport` names).
 */
export function setConsoleVerbose(verbose: boolean): void {
  (transport as LevelledTransport).level = verbose ? "debug" : "info";
}

/** Is this process's console gate open to debug? Read-back for tests. */
export function consoleVerbose(): boolean {
  return (transport as LevelledTransport).level === "debug";
}

/** The group whose logs bypass the timestamp/level prefix. */
export const BANNER_GROUP = "banner";

/**
 * A second sink for output that is ART, not a log line: the boot banner.
 *
 * A wordmark is only a wordmark if its first row starts at column zero, and
 * the pretty transport prefixes the first line of any message with
 * `[time] INFO`, which shears the top off the letterforms. Rather than write
 * the banner straight to `console` — the one thing that would put an unmanaged
 * writer back into a codebase that routes everything through LogLayer — it
 * gets its own transport, selected by a GROUP.
 */
const bannerTransport = new ConsoleTransport({
  id: BANNER_GROUP,
  logger: console,
  messageFn: ({ messages }) => messages.join(" "),
});

export const logger = new LogLayer({
  transport: [transport, bannerTransport, serverLogFile],
  groups: { [BANNER_GROUP]: { transports: [BANNER_GROUP] } },
  // Ordinary logs go to stdout AND the file, never to the banner. Without
  // this, every ordinary log would fan out to all three and the wordmark
  // transport would print a duplicate of each line.
  ungroupedBehavior: ["pretty", "file"],
  contextFieldName: "context",
  metadataFieldName: "metadata",
  errorFieldName: "err",
  errorSerializer: serializeError,
  copyMsgOnOnlyError: true,
});

if (IS_TEST) {
  logger.disableLogging();
}

export function getLogger(): ILogLayer {
  return logger;
}
