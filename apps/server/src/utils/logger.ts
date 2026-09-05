import { getSimplePrettyTerminal } from "@loglayer/transport-simple-pretty-terminal";
import { ConsoleTransport, type ILogLayer, LogLayer } from "loglayer";
import { serializeError } from "serialize-error";
import { IS_TEST } from "@/constants.js";

const transport = getSimplePrettyTerminal({ runtime: "node", id: "pretty" });

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
  transport: [transport, bannerTransport],
  groups: { [BANNER_GROUP]: { transports: [BANNER_GROUP] } },
  // Everything else goes to the prefixed transport ONLY. Without this, every
  // ordinary log would fan out to both and print twice.
  ungroupedBehavior: ["pretty"],
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
