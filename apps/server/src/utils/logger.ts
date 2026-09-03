import { getSimplePrettyTerminal } from "@loglayer/transport-simple-pretty-terminal";
import { type ILogLayer, LogLayer } from "loglayer";
import { serializeError } from "serialize-error";
import { IS_TEST } from "@/constants.js";

const transport = getSimplePrettyTerminal({ runtime: "node" });

export const logger = new LogLayer({
  transport,
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
