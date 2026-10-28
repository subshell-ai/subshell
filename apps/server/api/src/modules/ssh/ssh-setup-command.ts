import { shellQuote } from "@internal/pane-runtime";

/** The executor sends this on stdin to bash; curl receives its URL the same way. */
export function renderSshSetupCommand(installUrl: string, nodeName: string): string {
  const curlUrl = `url = ${JSON.stringify(installUrl)}`;
  return `set -o pipefail; printf '%s\\n' ${shellQuote(curlUrl)} | curl -fsSL --config - | SUBSHELL_NODE_NAME=${shellQuote(nodeName)} bash`;
}
